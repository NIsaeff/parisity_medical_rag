/**
 * Pronoun resolution for the chat pipeline.
 *
 * "lets schedule a meeting with him for monday" — who is "him"? The answer may
 * be several turns back, and the turns in between may themselves use nothing
 * but pronouns. The selector only ever sees `messages.slice(-5)`, so it cannot
 * reach an antecedent six turns old: this has to be code, not prompt.
 *
 * The rule, recursively:
 *   resolve(turn) =
 *     one patient named   -> that patient        (base case: ground truth)
 *     several named       -> adjudicate, ask      (base case: do NOT guess)
 *     nobody named        -> resolve(turn - 1)   (recurse: keep walking back)
 *     out of turns        -> adjudicate, ask
 *
 * Two name shapes live in this codebase:
 *   - "Brady Hickle"          the Patient table
 *   - "Brady998"              Synthea's notes, where the numeric suffix
 *                             disambiguates people with the same given name.
 * A Synthea token is looked up by its alphabetic stem, so a name quoted from a
 * note still resolves to the real patient row.
 *
 * The lookup is injected so this is testable without a database, and so the
 * caller decides how expensive a confirmation is. The adjudicator is optional
 * and is only consulted when code cannot decide on its own.
 */

import type { Message } from './agent';

export type PatientRef = { name: string; dob: string | null };

export type PatientResolution =
	| { status: 'resolved'; patient: PatientRef; turnsBack: number; via: Resolver }
	| { status: 'ambiguous'; candidates: string[] }
	| { status: 'unknown' };

/** How the answer was reached — useful in logs and traces. */
export type Resolver = 'exact' | 'stem' | 'adjudicated' | 'extracted';

/** A capitalised two-word run: enough to propose candidates, not to trust. */
const NAME_SHAPE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;

/** Synthea's note format: given name plus a numeric disambiguator. */
const SYNTHEA_SHAPE = /\b[A-Z][a-z]{2,}\d{2,4}\b/g;

/** How far back a chain of pronouns may reach. */
const MAX_TURNS = 20;

/** Cap the confirmation queries per turn — the DB is not free. */
const MAX_CANDIDATES_PER_TURN = 5;

/** What `findPatientByName` gives us, narrowed to what we use. */
export type NameLookup = (
	name: string,
) => Promise<{ firstName: string | null; lastName: string | null; birthDate: Date | null }[]>;

/**
 * The model is consulted only for the two jobs code cannot do:
 *   - choose: several patients are named and the conversation makes clear
 *     which one is meant ("the one with hypertension")
 *   - extract: nothing the regex recognises is a known patient (e.g. a name
 *     quoted from a note), so ask for the name span verbatim
 *
 * Whatever it returns is a proposal, never a fact: a chosen name must already
 * be in `candidates`, and an extracted name must still resolve in the DB.
 */
export type Adjudication =
	| { kind: 'choose'; query: string; history: Message[]; candidates: PatientRef[] }
	| { kind: 'extract'; query: string; history: Message[] };

export type Adjudicator = (input: Adjudication) => Promise<{ name: string | null }>;

type Candidate = { text: string; stem?: string };

/**
 * Propose candidate name spans. "Brady998" yields a stem of "Brady", which is
 * what the Patient table actually stores.
 */
function candidatesIn(content: string): Candidate[] {
	const found = new Map<string, Candidate>();

	// Two-word names first: they are the more specific shape.
	for (const [text] of content.matchAll(NAME_SHAPE)) {
		found.set(text, { text });
	}

	for (const [text] of content.matchAll(SYNTHEA_SHAPE)) {
		if (found.has(text)) continue;
		found.set(text, { text, stem: text.replace(/\d+$/, '') });
	}

	return [...found.values()].slice(0, MAX_CANDIDATES_PER_TURN);
}

/**
 * Patients confirmed by the database for one turn, de-duplicated.
 * A name that does not resolve is ignored — "Medical Records Assistant" is a
 * capitalised pair too, but it is not a patient.
 */
async function patientsIn(
	turn: Message,
	lookup: NameLookup,
): Promise<{ patients: PatientRef[]; via: Resolver }> {
	const confirmed = new Map<string, PatientRef>();
	let via: Resolver = 'exact';

	for (const candidate of candidatesIn(turn.content)) {
		let hits = await lookup(candidate.text);

		if (hits.length === 0 && candidate.stem) {
			hits = await lookup(candidate.stem);
			if (hits.length > 0) via = 'stem';
		}

		for (const patient of hits) {
			if (!patient.firstName || !patient.lastName) continue;

			const name = `${patient.firstName} ${patient.lastName}`;
			confirmed.set(name, {
				name,
				dob: patient.birthDate?.toISOString().slice(0, 10) ?? null,
			});
		}
	}

	return { patients: [...confirmed.values()], via };
}

/** Confirm a name proposed by the adjudicator against the database. */
async function confirmOne(
	name: string,
	lookup: NameLookup,
): Promise<{ patient: PatientRef; via: Resolver } | null> {
	const stem = name.replace(/\d+$/, '');
	const hits = await lookup(name);
	const resolved = hits.length > 0 ? hits : stem !== name ? await lookup(stem) : [];

	const patients = new Map<string, PatientRef>();
	for (const patient of resolved) {
		if (!patient.firstName || !patient.lastName) continue;
		patients.set(`${patient.firstName} ${patient.lastName}`, {
			name: `${patient.firstName} ${patient.lastName}`,
			dob: patient.birthDate?.toISOString().slice(0, 10) ?? null,
		});
	}

	// More than one match means the proposal was not specific enough.
	if (patients.size !== 1) return null;

	return {
		patient: [...patients.values()][0],
		via: hits.length > 0 ? 'extracted' : 'stem',
	};
}

export type ResolveInput = {
	history: Message[];
	/** The user's current message, for the adjudicator. */
	query: string;
	lookup: NameLookup;
	adjudicate?: Adjudicator;
};

/**
 * Walk backwards one turn at a time until something names a patient.
 * Iterative form of the recursion above: same computation, no stack, and it
 * can stop at the first turn that decides the answer.
 */
export async function resolveReferent({
	history,
	query,
	lookup,
	adjudicate,
}: ResolveInput): Promise<PatientResolution> {
	const turns = history.slice(-MAX_TURNS);

	for (let i = turns.length - 1; i >= 0; i--) {
		const { patients, via } = await patientsIn(turns[i], lookup);

		// Exactly one patient here: this turn is the ground truth, stop.
		if (patients.length === 1) {
			return { status: 'resolved', patient: patients[0], turnsBack: turns.length - i, via };
		}

		// Several patients here: the nearest naming turn is the relevant
		// context, so walk no further. Let the adjudicator choose if the
		// conversation makes it clear; otherwise ask.
		if (patients.length > 1) {
			if (adjudicate) {
				const { name } = await adjudicate({
					kind: 'choose',
					query,
					history: turns.slice(-5),
					candidates: patients,
				});
				const chosen = patients.find((p) => p.name === name);
				if (chosen) {
					return { status: 'resolved', patient: chosen, turnsBack: turns.length - i, via: 'adjudicated' };
				}
			}

			return { status: 'ambiguous', candidates: patients.map((p) => p.name) };
		}

		// Nobody named in this turn. It was probably a pronoun too — keep going.
	}

	// Nothing in the history is a known patient. Last resort: ask the model for
	// the name span used in the conversation, then confirm it in the database.
	if (adjudicate) {
		const { name } = await adjudicate({ kind: 'extract', query, history: turns.slice(-5) });
		if (name) {
			const confirmed = await confirmOne(name, lookup);
			if (confirmed) {
				return { status: 'resolved', patient: confirmed.patient, turnsBack: 0, via: confirmed.via };
			}
		}
	}

	return { status: 'unknown' };
}

/** Does the text lean on a pronoun or a referring phrase? */
export function usesPronoun(text: string): boolean {
	return /\b(her|his|him|she|he|they|them|that patient|this patient|the patient)\b/i.test(
		text,
	);
}
