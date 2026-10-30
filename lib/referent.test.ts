import { describe, expect, it } from 'vitest';

import { resolveReferent, usesPronoun, type Adjudicator, type NameLookup } from './referent';
import type { Message } from './agent';

/** Stand-in for findPatientByName: only the names below are real patients. */
const lookup: NameLookup = async (term) => {
	const known = [
		{ firstName: 'Cassie', lastName: 'Heidenreich', birthDate: new Date('1936-12-23') },
		{ firstName: 'Abe', lastName: 'Frami', birthDate: new Date('1950-04-02') },
		{ firstName: 'Brady', lastName: 'Hickle', birthDate: new Date('1934-08-14') },
	];
	return known.filter((p) =>
		`${p.firstName} ${p.lastName}`.toLowerCase().includes(term.toLowerCase()),
	);
};

const assistant = (content: string): Message => ({ role: 'assistant', content });
const user = (content: string): Message => ({ role: 'user', content });

const none: Adjudicator = async () => ({ name: null });

describe('resolveReferent', () => {
	it('finds a patient named on the turn immediately before', async () => {
		const history = [assistant('Cassie Heidenreich (born 1936-12-23) had hypertension.')];

		expect(await resolveReferent({ history, query: 'schedule her', lookup })).toEqual({
			status: 'resolved',
			patient: { name: 'Cassie Heidenreich', dob: '1936-12-23' },
			turnsBack: 1,
			via: 'exact',
		});
	});

	it('walks back through a chain of pronoun-only turns', async () => {
		const history = [
			assistant('Cassie Heidenreich (born 1936-12-23) had hypertension.'),
			user('how is that patient doing?'),
			assistant('She is stable.'),
			user('and her medications?'),
			assistant('She takes lisinopril.'),
			user('lets schedule a meeting with her'),
		];

		const resolution = await resolveReferent({ history, query: 'schedule her', lookup });

		// Six turns back, and nothing between here and there named anyone.
		expect(resolution).toEqual({
			status: 'resolved',
			patient: { name: 'Cassie Heidenreich', dob: '1936-12-23' },
			turnsBack: 6,
			via: 'exact',
		});
	});

	it('resolves a Synthea note name by its stem', async () => {
		// The note says "Brady998"; the patient row is Brady Hickle.
		const history = [
			assistant('Brady998 is a 61-year-old man with diabetes.'),
			user('lets schedule him for monday'),
		];

		expect(await resolveReferent({ history, query: 'schedule him', lookup })).toEqual({
			status: 'resolved',
			patient: { name: 'Brady Hickle', dob: '1934-08-14' },
			turnsBack: 2,
			via: 'stem',
		});
	});

	it('asks when the nearest naming turn lists several patients', async () => {
		const history = [
			user('who has hypertension?'),
			assistant('Abe Frami and Cassie Heidenreich both have hypertension.'),
			user('schedule her for friday'),
		];

		expect(
			await resolveReferent({ history, query: 'schedule her', lookup, adjudicate: none }),
		).toEqual({ status: 'ambiguous', candidates: ['Abe Frami', 'Cassie Heidenreich'] });
	});

	it('lets the adjudicator pick between named candidates', async () => {
		const history = [
			assistant('Abe Frami has hypertension; Cassie Heidenreich does not.'),
			user('schedule the one with hypertension'),
		];
		const adjudicate: Adjudicator = async () => ({ name: 'Abe Frami' });

		expect(await resolveReferent({ history, query: 'schedule him', lookup, adjudicate })).toEqual({
			status: 'resolved',
			patient: { name: 'Abe Frami', dob: '1950-04-02' },
			turnsBack: 2,
			via: 'adjudicated',
		});
	});

	it('ignores an adjudicated name that was not offered', async () => {
		const history = [assistant('Abe Frami and Cassie Heidenreich were discussed.')];
		const adjudicate: Adjudicator = async () => ({ name: 'Someone Else' });

		expect(await resolveReferent({ history, query: 'schedule her', lookup, adjudicate })).toEqual({
			status: 'ambiguous',
			candidates: ['Abe Frami', 'Cassie Heidenreich'],
		});
	});

	it('is unknown when nobody was ever named', async () => {
		const history = [
			user('how many patients have hypertension?'),
			assistant('Twelve patients have hypertension.'),
		];

		expect(
			await resolveReferent({ history, query: 'book her in', lookup, adjudicate: none }),
		).toEqual({ status: 'unknown' });
	});

	it('falls back to the model when the regex finds no patient name', async () => {
		// Nothing recognisable; only the model can point at the name span.
		const history = [
			assistant('The chart belongs to hickle, seen in 1976.'),
			user('schedule her appointment'),
		];
		const adjudicate: Adjudicator = async () => ({ name: 'hickle' });

		expect(await resolveReferent({ history, query: 'schedule her', lookup, adjudicate })).toEqual({
			status: 'resolved',
			patient: { name: 'Brady Hickle', dob: '1934-08-14' },
			turnsBack: 0,
			via: 'extracted',
		});
	});

	it('still refuses when the model proposes a name the database does not know', async () => {
		const history = [assistant('No patient was discussed.'), user('schedule her')];
		const adjudicate: Adjudicator = async () => ({ name: 'Jane Nobody' });

		expect(await resolveReferent({ history, query: 'schedule her', lookup, adjudicate })).toEqual({
			status: 'unknown',
		});
	});

	it('ignores capitalised pairs that are not patients', async () => {
		const history = [
			assistant('Medical Records Assistant is not a patient.'),
			user('book her in tomorrow'),
		];

		expect(
			await resolveReferent({ history, query: 'book her in', lookup, adjudicate: none }),
		).toEqual({ status: 'unknown' });
	});

	it('does not reach past the turn budget', async () => {
		const filler = Array.from({ length: 21 }, () => user('and then?'));
		const history = [
			assistant('Cassie Heidenreich (born 1936-12-23) had hypertension.'),
			...filler,
		];

		// The name is 22 turns back, beyond MAX_TURNS (20).
		expect(
			await resolveReferent({ history, query: 'schedule her', lookup, adjudicate: none }),
		).toEqual({ status: 'unknown' });
	});

	it('returns no date of birth when the record has none', async () => {
		const namelessDob: NameLookup = async () => [
			{ firstName: 'Abe', lastName: 'Frami', birthDate: null },
		];

		expect(
			await resolveReferent({
				history: [assistant('Abe Frami was seen.')],
				query: 'schedule him',
				lookup: namelessDob,
			}),
		).toEqual({
			status: 'resolved',
			patient: { name: 'Abe Frami', dob: null },
			turnsBack: 1,
			via: 'exact',
		});
	});
});

describe('usesPronoun', () => {
	it.each(['schedule her for friday', 'book him in', 'that patient needs a follow-up'])(
		'detects %s',
		(query) => expect(usesPronoun(query)).toBe(true),
	);

	it.each(['schedule Cassie Heidenreich for friday', 'how many patients have hypertension?'])(
		'does not fire on %s',
		(query) => expect(usesPronoun(query)).toBe(false),
	);
});
