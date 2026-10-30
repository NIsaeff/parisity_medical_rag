/**
 * Pronoun resolution for the chat pipeline.
 *
 * "lets schedule a meeting with her for monday" — who is "her"? The answer may
 * be several turns back, and the turns in between may themselves use nothing
 * but pronouns. The selector only ever sees `messages.slice(-5)`, so it cannot
 * reach an antecedent that is six turns old: this has to be code, not prompt.
 *
 * The rule, recursively:
 *   resolve(turn) =
 *     one patient named   -> that patient        (base case: ground truth)
 *     several named       -> ambiguous, ask      (base case: do NOT guess)
 *     nobody named        -> resolve(turn - 1)   (recurse: keep walking back)
 *     out of turns        -> unknown, ask
 *
 * A "named" patient is a run of capitalised words that the database confirms.
 * The lookup is injected so this is testable without a database, and so the
 * caller decides how expensive a confirmation is.
 */

import type { Message } from './agent';

export type PatientRef = { name: string; dob: string | null };

export type PatientResolution =
	| { status: 'resolved'; patient: PatientRef; turnsBack: number }
	| { status: 'ambiguous'; candidates: string[] }
	| { status: 'unknown' };

/** A capitalised two-word run: enough to propose candidates, not to trust. */
const NAME_SHAPE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;

/** How far back a chain of pronouns may reach. */
const MAX_TURNS = 20;

/** Cap the confirmation queries per turn — the DB is not free. */
const MAX_CANDIDATES_PER_TURN = 5;

/** What `findPatientByName` gives us, narrowed to what we use. */
export type NameLookup = (
	name: string,
) => Promise<{ firstName: string | null; lastName: string | null; birthDate: Date | null }[]>;

/**
 * Patients confirmed by the database in a single turn, de-duplicated.
 * A name that does not resolve is ignored — "Medical Records Assistant" is a
 * capitalised pair too, but it is not a patient.
 */
async function patientsIn(
	turn: Message,
	lookup: NameLookup,
): Promise<PatientRef[]> {
	const candidates = [
		...new Set((turn.content.match(NAME_SHAPE) ?? []).slice(0, MAX_CANDIDATES_PER_TURN)),
	];

	const confirmed = new Map<string, PatientRef>();

	for (const candidate of candidates) {
		const [patient] = await lookup(candidate);
		if (!patient?.firstName || !patient.lastName) continue;

		const name = `${patient.firstName} ${patient.lastName}`;
		confirmed.set(name, {
			name,
			dob: patient.birthDate?.toISOString().slice(0, 10) ?? null,
		});
	}

	return [...confirmed.values()];
}

/**
 * Walk backwards one turn at a time until something names a patient.
 * Iterative form of the recursion above: same computation, no stack, and it
 * can stop at the first turn that decides the answer.
 */
export async function resolveReferent(
	history: Message[],
	lookup: NameLookup,
): Promise<PatientResolution> {
	const turns = history.slice(-MAX_TURNS);

	for (let i = turns.length - 1; i >= 0; i--) {
		const patients = await patientsIn(turns[i], lookup);

		// Exactly one patient here: this turn is the ground truth, stop.
		if (patients.length === 1) {
			return { status: 'resolved', patient: patients[0], turnsBack: turns.length - i };
		}

		// Several patients here: picking one would book the wrong human.
		// Stop and let the caller ask. Walking further back would be worse,
		// because the nearest naming turn is the most relevant context.
		if (patients.length > 1) {
			return { status: 'ambiguous', candidates: patients.map((p) => p.name) };
		}

		// Nobody named in this turn. It was probably a pronoun too — keep going.
	}

	return { status: 'unknown' };
}

/** Does the text lean on a pronoun or a referring phrase? */
export function usesPronoun(text: string): boolean {
	return /\b(her|his|him|she|he|they|them|that patient|this patient|the patient)\b/i.test(
		text,
	);
}
