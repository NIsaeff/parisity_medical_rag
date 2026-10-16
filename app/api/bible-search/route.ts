import { NextResponse } from 'next/server';
import { z } from 'zod';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createEmbedding } from '@/lib/openai';

const RequestSchema = z.object({
	query: z.string().min(1),
	collection: z.string().min(1).default('bible_smart'),
	candidates: z.number().int().positive().max(100).default(25),
	top: z.number().int().positive().max(25).default(5),
});

const qdrant = new QdrantClient({
	url: process.env.QDRANT_URL!,
	apiKey: process.env.QDRANT_API_KEY,
});

export async function POST(request: Request) {
	try {
		const { query, collection, candidates, top } = RequestSchema.parse(
			await request.json(),
		);

		let t = performance.now();
		const vector = await createEmbedding(query);
		const { points } = await qdrant.query(collection, {
			query: vector,
			limit: candidates,
			with_payload: true,
		});
		const searchMs = Math.round(performance.now() - t);

		const rows = points.map((p, i) => ({
			rank: i + 1,
			reference: String(p.payload?.reference ?? `point ${p.id}`),
			text: String(p.payload?.text ?? ''),
			score: p.score,
		}));

		t = performance.now();
		const reranked: { data: { index: number; score: number }[] } = { data: [] };
		if (rows.length) {
			const res = await fetch('https://api.cohere.com/v2/rerank', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.COHERE_RERANK_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'rerank-v3.5',
					query,
					documents: rows.map((r) => r.text),
					top_n: top,
				}),
			});
			if (!res.ok) throw new Error(`Cohere rerank ${res.status}: ${await res.text()}`);
			const json = await res.json();
			reranked.data = json.results.map((r: { index: number; relevance_score: number }) => ({
				index: r.index,
				score: r.relevance_score,
			}));
		}
		const rerankMs = Math.round(performance.now() - t);

		return NextResponse.json({
			searchMs,
			rerankMs,
			plain: rows.slice(0, top),
			reranked: reranked.data.map((r) => ({
				...rows[r.index],
				score: r.score,
				cosineRank: rows[r.index].rank,
			})),
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : 'Internal server error' },
			{ status: 500 },
		);
	}
}
