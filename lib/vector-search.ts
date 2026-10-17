/**
 * Vector search over the clinical notes — Week 2, built together in class.
 *
 * The shape we're building, two-stage retrieval in one call:
 *   1. embed the query, ask Pinecone for the nearest topK notes (wide, cheap)
 *   2. rerank those candidates against the query, keep topN (narrow, careful)
 *
 * Returns both lists so you can log them side by side and SEE what reranking
 * changed on a given query.
 */

import type { SearchResult } from './pinecone';
import { createEmbedding } from './openai';
import { pinecone } from './pinecone';

export type VectorSearchOptions = {
	topK?: number; // candidates the cosine search fetches
	topN?: number; // candidates kept after reranking
};

export async function searchClinicalNotes(
	query: string,
	options: VectorSearchOptions = {},
): Promise<string> {
	// query -> string[]
	const embedding = await createEmbedding(query);
	// search pinecone
	const results = await pinecone.index(process.env.PINECONE_INDEX!).query({
		vector: embedding, //query represented as 1536 vector
		topK: 10,
		includeMetadata: true, // contnet we got race / gender / age / etc.
	});

	const matchesWithScores = results.matches.map((match) => ({
		id: match.id,
		score: match.score,
		content: match.metadata?.content as string,
		metadata: match.metadata,
	}));

	// filter -> terrible matches

	// cosine similarity agains the query and the doc

	console.log(JSON.stringify(matchesWithScores, null, 2));

	// filter out scores below 0.3
	const filteredMatches = matchesWithScores.filter(
		(match) => match?.score && match.score > 0.3,
	);

	const docs: string[] = filteredMatches.map(
		(match) =>
			`note: ${match.metadata?.content} \n\n metadata: ${JSON.stringify(match.metadata)}`,
	);

	const reranked = await pinecone.inference.rerank({
		model: 'bge-reranker-v2-m3',
		query: query, //text
		documents: docs, //text
		topN: 5,
	});

	// scores against the query and the doc

	console.log(JSON.stringify(reranked.data, null, 2));

	return reranked.data.map((result) => result.document?.text).join('\n');
}
