import { searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const SearchRequestSchema = z.object({
	query: z.string().min(1),
	topK: z.number().int().positive().default(10),
});

/**
 * Raw vector search, for poking at retrieval — Week 2, built in class.
 * Parse { query, topK }, call searchClinicalNotes (lib/vector-search.ts),
 * return the results as JSON.
 */
export async function POST(request: Request) {
	try {
		const { query, topK } = SearchRequestSchema.parse(await request.json());
		const results = await searchClinicalNotes(query, { topK });

		return NextResponse.json(results);
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}

		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : 'Internal server error',
			},
			{ status: 500 },
		);
	}
}
