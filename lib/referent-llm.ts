/**
 * The LLM half of pronoun resolution.
 *
 * `lib/referent.ts` does the deterministic work: walk the history, confirm
 * names against the database. This module covers the two cases it cannot
 * settle on its own, and is called only when it gets there:
 *
 *   choose  — several patients are named; the conversation may make clear
 *             which one is meant ("the one with hypertension")
 *   extract — nothing the parser recognises is a known patient, because the
 *             name came out of a Synthea note ("Brady998") rather than the
 *             patient table
 *
 * The answer is a proposal, never a fact: the caller only accepts a `choose`
 * result that is already in the candidate list, and re-checks an `extract`
 * result against the database. A hallucinated name therefore cannot reach the
 * calendar.
 */

import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import type { Adjudicator } from './referent';
import { openai } from './openai';

const AdjudicationSchema = z.object({
	name: z
		.string()
		.nullable()
		.describe(
			'The patient the request is about, copied exactly as it appears, or null when it is genuinely unclear. Never invent a name.',
		),
});

export const adjudicateReferent: Adjudicator = async (input) => {
	const system =
		input.kind === 'choose'
			? `Several patients are named in this conversation. Decide which one the user's request refers to,
				and copy the name EXACTLY as one of these options:
				${input.candidates.map((c) => `- ${c.name}`).join('\n')}
				If the conversation does not make it clear, return null. Never pick a name outside the list.`
			: `Find the patient this request refers to. The request uses a pronoun, so the patient is named earlier
				in the conversation. Return the name exactly as it appears there. If no patient is named, return null.
				Never invent a name.`;

	const response = await openai.responses.parse({
		model: 'gpt-6-luna',
		input: [
			{ role: 'system', content: system },
			{
				role: 'user',
				content: `Request: ${input.query}\n\nConversation:\n${input.history
					.map((message) => `${message.role}: ${message.content}`)
					.join('\n')}`,
			},
		],
		text: { format: zodTextFormat(AdjudicationSchema, 'referent') },
	});

	return { name: AdjudicationSchema.parse(response.output_parsed).name };
};
