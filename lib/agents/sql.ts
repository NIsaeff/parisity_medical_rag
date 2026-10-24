/**
 * SQL agent — Week 3. Filter extraction + a dynamic WHERE. Returns TEXT.
 *
 *   1. load the DISTINCT condition names that really exist in the data
 *      ("heart attack" is stored as "Myocardial Infarction")
 *   2. the model reads the question + that list and extracts FILTERS
 *      (structured output) — it never writes SQL
 *   3. buildWhere() turns the filters into a Prisma `where` — parameterized,
 *      so there is nothing to inject and no validator to bolt on
 *   4. run it, hand the rows back as text for the aggregator to summarize
 */

import { zodTextFormat } from 'openai/helpers/zod';

import type { Message } from '../agent';
import { openai } from '../openai';
import { prisma } from '../prisma';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

const FiltersSchema = z.object({
	conditions: z
		.array(z.string())
		.describe(
			'Condition names the question asks about, copied EXACTLY from the provided list. Empty if none.',
		),
	conditionLogic: z
		.enum(['all', 'any'])
		.describe(
			'all = patient must have every listed condition ("and", "both"); any = at least one ("or", "either").',
		),
	gender: z.enum(['male', 'female']).nullable(),
	minAge: z.number().int().nullable().describe('Minimum age in years, if stated.'),
	maxAge: z.number().int().nullable().describe('Maximum age in years, if stated.'),
	state: z.string().nullable().describe('US state name, e.g. "Massachusetts".'),
	city: z.string().nullable(),
	alive: z
		.boolean()
		.nullable()
		.describe('true = still alive, false = deceased, null = not stated.'),
});

export type Filters = z.infer<typeof FiltersSchema>;

const yearsAgo = (years: number) => {
	const d = new Date();
	d.setFullYear(d.getFullYear() - years);
	return d;
};

/** Filters -> Prisma where. Only the filters that were actually set are applied. */
export function buildWhere(f: Filters): Prisma.PatientWhereInput {
	const conds = f.conditions.map(
		(display): Prisma.PatientWhereInput => ({
			conditions: { some: { display } },
		}),
	);
	return {
		...(conds.length && (f.conditionLogic === 'any' ? { OR: conds } : { AND: conds })),
		...(f.gender && { gender: f.gender }),
		...(f.state && { state: { equals: f.state, mode: 'insensitive' } }),
		...(f.city && { city: { equals: f.city, mode: 'insensitive' } }),
		...(f.alive != null && { deathDate: f.alive ? null : { not: null } }),
		// older = earlier birth date
		...((f.minAge != null || f.maxAge != null) && {
			birthDate: {
				...(f.minAge != null && { lte: yearsAgo(f.minAge) }),
				...(f.maxAge != null && { gt: yearsAgo(f.maxAge + 1) }),
			},
		}),
	};
}

const LIMIT = 50;

export async function runSql(
	query: string,
	history: Message[] = [],
): Promise<string> {
	const [conditionRows, stateRows] = await Promise.all([
		prisma.condition.findMany({
			distinct: ['display'],
			select: { display: true },
			orderBy: { display: 'asc' },
		}),
		prisma.patient.findMany({
			distinct: ['state'],
			select: { state: true },
		}),
	]);
	const known = conditionRows.map((c) => c.display);
	const states = stateRows
		.map((s) => s.state)
		.filter((s): s is string => !!s);

	const response = await openai.responses.parse({
		model: 'gpt-6-luna',
		input: [
			{
				role: 'system',
				content: `Extract patient filters from the question. Only set a filter the question actually asks for.\n\nConditions that exist in the data:\n${known.join('\n')}\n\nStates as stored (use these exact values, e.g. "MA" not "Massachusetts"): ${states.join(', ')}`,
			},
			...history.map((m) => ({ role: m.role, content: m.content })),
			{ role: 'user', content: query },
		],
		text: { format: zodTextFormat(FiltersSchema, 'filters') },
	});
	const parsed = FiltersSchema.parse(response.output_parsed);

	// The model copies names from the list, but drop anything it invented.
	const filters = {
		...parsed,
		conditions: parsed.conditions.filter((c) => known.includes(c)),
		state:
			parsed.state && states.includes(parsed.state) ? parsed.state : null,
	};
	const where = buildWhere(filters);

	const [total, patients] = await Promise.all([
		prisma.patient.count({ where }),
		prisma.patient.findMany({
			where,
			take: LIMIT,
			select: {
				firstName: true,
				lastName: true,
				gender: true,
				birthDate: true,
				deathDate: true,
				city: true,
				state: true,
				conditions: { select: { display: true, clinicalStatus: true } },
			},
		}),
	]);

	return [
		`Filters applied: ${JSON.stringify(filters)}`,
		`Matching patients: ${total}${total > LIMIT ? ` (showing first ${LIMIT})` : ''}`,
		JSON.stringify(patients),
	].join('\n');
}
