import { describe, expect, it } from 'vitest';

import { resolveReferent, usesPronoun, type NameLookup } from './referent';
import type { Message } from './agent';

/** Stand-in for findPatientByName: only the names below are real patients. */
const lookup: NameLookup = async (term) => {
	const known = [
		{ firstName: 'Cassie', lastName: 'Heidenreich', birthDate: new Date('1936-12-23') },
		{ firstName: 'Abe', lastName: 'Frami', birthDate: new Date('1950-04-02') },
	];
	return known.filter((p) =>
		`${p.firstName} ${p.lastName}`.toLowerCase().includes(term.toLowerCase()),
	);
};

const assistant = (content: string): Message => ({ role: 'assistant', content });
const user = (content: string): Message => ({ role: 'user', content });

describe('resolveReferent', () => {
	it('finds a patient named on the turn immediately before', async () => {
		const history = [
			assistant('Cassie Heidenreich (born 1936-12-23) had hypertension.'),
		];

		expect(await resolveReferent(history, lookup)).toEqual({
			status: 'resolved',
			patient: { name: 'Cassie Heidenreich', dob: '1936-12-23' },
			turnsBack: 1,
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

		const resolution = await resolveReferent(history, lookup);

		// Six turns back, and nothing between here and there named anyone.
		expect(resolution).toEqual({
			status: 'resolved',
			patient: { name: 'Cassie Heidenreich', dob: '1936-12-23' },
			turnsBack: 6,
		});
	});

	it('refuses to choose when the nearest naming turn lists several patients', async () => {
		const history = [
			user('who has hypertension?'),
			assistant('Abe Frami and Cassie Heidenreich both have hypertension.'),
			user('schedule her for friday'),
		];

		expect(await resolveReferent(history, lookup)).toEqual({
			status: 'ambiguous',
			candidates: ['Abe Frami', 'Cassie Heidenreich'],
		});
	});

	it('is unknown when nobody was ever named', async () => {
		const history = [
			user('how many patients have hypertension?'),
			assistant('Twelve patients have hypertension.'),
		];

		expect(await resolveReferent(history, lookup)).toEqual({ status: 'unknown' });
	});

	it('ignores capitalised pairs that are not patients', async () => {
		const history = [
			assistant('Medical Records Assistant is not a patient.'),
			user('book her in tomorrow'),
		];

		expect(await resolveReferent(history, lookup)).toEqual({ status: 'unknown' });
	});

	it('does not reach past the turn budget', async () => {
		const filler = Array.from({ length: 21 }, () => user('and then?'));
		const history = [
			assistant('Cassie Heidenreich (born 1936-12-23) had hypertension.'),
			...filler,
		];

		// The name is 22 turns back, beyond MAX_TURNS (20).
		expect(await resolveReferent(history, lookup)).toEqual({ status: 'unknown' });
	});

	it('returns no date of birth when the record has none', async () => {
		const namelessDob: NameLookup = async () => [
			{ firstName: 'Abe', lastName: 'Frami', birthDate: null },
		];

		expect(await resolveReferent([assistant('Abe Frami was seen.')], namelessDob)).toEqual({
			status: 'resolved',
			patient: { name: 'Abe Frami', dob: null },
			turnsBack: 1,
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
