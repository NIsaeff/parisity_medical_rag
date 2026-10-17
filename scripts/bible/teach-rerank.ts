/**
 * INSTRUCTOR DEMO — Week 2: chunk the KJV by CHAPTER, then show search
 * results WITHOUT vs WITH reranking, side by side, on real data.
 *
 *   npm run bible:teach -- --dry-run     # chunk only: stats + a sample chunk (no API calls, free)
 *   npm run bible:teach                  # build the collection if it's empty, run the curated queries
 *   npm run bible:teach -- "a storm goes quiet the moment he tells it to"   # your own query(ies)
 *   npm run bible:teach -- --reindex     # drop the collection and rebuild it with chapter chunks
 *
 * Flags: --collection <name>  Qdrant collection (default $BIBLE_COLLECTION, else "bible_chapters")
 *        --fetch <n>          candidates pulled by cosine search      (default 25)
 *        --keep <n>           results you'd hand the LLM              (default 5)
 *
 * Same split as the homework (store.ts / search.ts): vectors in Qdrant, the
 * reranker is Pinecone's hosted cross-encoder on PINECONE_API_KEY. Writes
 * data/bible/rerank-demo.html — open it in a browser for the slopegraph
 * (cosine rank → reranked rank). Prereqs: `npm run bible:fetch`,
 * OPENAI_API_KEY, QDRANT_URL (+ QDRANT_API_KEY for Qdrant Cloud), PINECONE_API_KEY.
 *
 * The strategy: one chapter = one chunk. Chapters are the Bible's own unit of
 * "one story / one argument", so boundaries rarely cut a thought in half and
 * we need no overlap. Every chunk carries its reference ("Luke 15") as
 * payload so results are citable and filterable (by book, testament...).
 * The cost: a big chunk is a blurry embedding (one vector for 30 verses), and
 * the reranker only reads the first ~1024 tokens of each candidate. Watch for
 * both in the output — they're the tradeoff, not bugs.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Pinecone } from '@pinecone-database/pinecone';
import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIMENSIONS, createEmbedding, createEmbeddings } from '../../lib/openai';
import { loadVerses, Verse } from './parse';

// Created in main() AFTER --dry-run returns, so a dry run needs no keys
let qdrant: QdrantClient;
let pinecone: Pinecone;

const RERANK_MODEL = 'bge-reranker-v2-m3';
// bge-reranker-v2-m3 reads at most 1024 tokens of (query + document); at ~4
// chars/token, a chapter much past ~3,800 chars gets its tail cut off.
const RERANK_WINDOW_CHARS = 3800;
const REPORT_TEMPLATE = path.join(__dirname, 'teach-rerank-report.html');
const REPORT_OUT = path.join('data', 'bible', 'rerank-demo.html');

// Modern phrasing on purpose — almost no words in common with the KJV text,
// so any hit is meaning, not keywords. Each carries the chapter we expect and
// the lesson it teaches. Cosine ranks noted below were measured against
// text-embedding-3-small with these exact chapter chunks; rerank results are
// whatever the model says on the day — run it before class and narrate those.
type DemoQuery = { query: string; expect: string | null; lesson: string | null };
const CURATED_QUERIES: DemoQuery[] = [
	// Control: cosine already nails it (#1). Reranking mostly agrees — say so.
	{
		query: 'a son blows his inheritance partying, and his dad throws him a party when he comes home',
		expect: 'Luke 15',
		lesson: 'Control: cosine already gets this right. A reranker that agrees is fine; it isn\'t magic on every query.',
	},
	// Buried by cosine (#10–#20) in SHORT chapters the reranker reads in full —
	// the best shots at "rerank pulled it into the top 5".
	{
		query: 'a father is told to sacrifice his son, then an animal is provided instead',
		expect: 'Genesis 22',
		lesson: 'Cosine is fooled by vocabulary. "Sacrifice" and "animal" pull up the Leviticus offering rules. The reranker reads the story.',
	},
	{
		query: 'joy, peace, patience, gentleness and self-control',
		expect: 'Galatians 5',
		lesson: 'Near-duplicates. Several epistles list virtues, and cosine can\'t tell which list this is. The reranker compares closely.',
	},
	{
		query: 'a prophet is fed by birds while hiding by a stream',
		expect: '1 Kings 17',
		lesson: 'Cosine ranks it around #20, so with topK=5 and no rerank the LLM never sees it.',
	},
	{
		query: 'a short guy climbs a tree to see over the crowd',
		expect: 'Luke 19',
		lesson: 'The story sits in the first 10 verses, inside the reranker\'s window, even though the chapter is long.',
	},
	// The costs of big chunks — reranking can't fix these.
	{
		query: 'a teenager takes down a giant warrior with a slingshot',
		expect: '1 Samuel 17',
		lesson: 'Truncation: the sling is in verse 49 of a 9,000-char chapter, past the reranker\'s ~1,024-token window. It judges the chapter on its opening.',
	},
	{
		query: 'a bush on fire that does not burn up',
		expect: 'Exodus 3',
		lesson: 'Dilution: the burning bush is 3 verses of a 22-verse chapter, so the chapter vector is "about" Moses\' commission. Cosine ranks it ~#331. Retrieval never fetched it, so reranking can\'t help.',
	},
	{
		query: "a humble tax collector's prayer beats a religious leader's bragging",
		expect: 'Luke 18',
		lesson: 'Dilution again: Luke 18 has five separate stories in one chunk. Cosine ranks it ~#121. This is the case for smaller chunks.',
	},
];

// The Gutenberg titles are long ("The First Book of Moses: Called Genesis").
// Books appear in canonical order, so map by position to the names people cite.
const SHORT_NAMES = [
	'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
	'1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
	'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
	'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
	'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
	'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
	'2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
	'2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
	'1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation',
];

type ChapterChunk = {
	id: number; // Qdrant point ids must be integers or UUIDs — the reference lives in the payload
	text: string; // verses, one per line, each prefixed with its number
	metadata: {
		reference: string; // "1 Samuel 17"
		book: string;
		chapter: number;
		verseCount: number;
		testament: 'Old' | 'New';
		chars: number;
		strategy: 'chapter';
	};
};

type Candidate = {
	id: string;
	reference: string;
	text: string;
	cosineRank: number;
	cosineScore: number;
	rerankRank: number | null;
	rerankScore: number | null;
	truncated: boolean;
};

type QueryResult = {
	query: string;
	expect: string | null;
	lesson: string | null;
	candidates: Candidate[];
	rerankError: string | null;
};

function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

function option(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
}

/** Positional args (not flags or flag values) are custom queries */
function customQueries(): string[] {
	const valued = new Set(['--collection', '--fetch', '--keep']);
	const args = process.argv.slice(2);
	return args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
}

// ─── 1. Chunk: one chapter = one chunk ──────────────────────────────────────

function chunkByChapter(verses: Verse[]): ChapterChunk[] {
	const bookOrder: string[] = [];
	const groups = new Map<string, Verse[]>();
	for (const v of verses) {
		if (!bookOrder.includes(v.book)) bookOrder.push(v.book);
		const key = `${v.book}|${v.chapter}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(v);
	}
	if (bookOrder.length !== SHORT_NAMES.length) {
		throw new Error(`Expected 66 books, parsed ${bookOrder.length} — is data/bible/kjv.txt the Gutenberg KJV?`);
	}

	return [...groups.values()].map((group, id) => {
		const bookIndex = bookOrder.indexOf(group[0].book);
		const book = SHORT_NAMES[bookIndex];
		const chapter = group[0].chapter;
		const text = group.map((v) => `${v.verse} ${v.text}`).join('\n');
		return {
			id,
			text,
			metadata: {
				reference: `${book} ${chapter}`,
				book,
				chapter,
				verseCount: group.length,
				testament: bookIndex < 39 ? 'Old' : 'New',
				chars: text.length,
				strategy: 'chapter',
			},
		};
	});
}

function printChunkStats(chunks: ChapterChunk[]) {
	const sizes = chunks.map((c) => c.metadata.chars).sort((a, b) => a - b);
	const biggest = [...chunks].sort((a, b) => b.metadata.chars - a.metadata.chars)[0];
	const smallest = [...chunks].sort((a, b) => a.metadata.chars - b.metadata.chars)[0];
	const overWindow = chunks.filter((c) => c.metadata.chars > RERANK_WINDOW_CHARS).length;

	console.log('\n━━ Chunking strategy: one chapter = one chunk ━━');
	console.log(`  chunks:              ${chunks.length.toLocaleString()} (one per chapter)`);
	console.log(`  size min/median/max: ${sizes[0]} / ${sizes[sizes.length >> 1]} / ${sizes[sizes.length - 1]} chars`);
	console.log(`  smallest:            ${smallest.metadata.reference} (${smallest.metadata.verseCount} verses)`);
	console.log(`  biggest:             ${biggest.metadata.reference} (${biggest.metadata.verseCount} verses, ≈${Math.round(biggest.metadata.chars / 4)} tokens)`);
	console.log(`  past rerank window:  ${overWindow} chapters (> ~${RERANK_WINDOW_CHARS} chars — reranker only sees their opening)`);
	console.log(`  overlap:             none — chapter boundaries are natural breaks`);

	const sample = chunks.find((c) => c.metadata.reference === 'Psalms 23')!;
	console.log(`\n  Sample chunk  id=${sample.id}`);
	console.log(`  metadata: ${JSON.stringify(sample.metadata)}`);
	console.log(
		sample.text
			.split('\n')
			.slice(0, 3)
			.map((l) => `  │ ${l}`)
			.join('\n') + '\n  │ …',
	);
}

// ─── 2. Store: make sure the collection exists and holds the chapters ───────

async function ensureCollection(name: string, chunks: ChapterChunk[], reindex: boolean) {
	const { exists } = await qdrant.collectionExists(name);
	const count = exists ? (await qdrant.count(name, { exact: true })).count : 0;

	if (count > 0 && !reindex) {
		// Something's already here — probably your homework collection. Use it, but
		// say so if it isn't chapter-chunked, since the demo narrative assumes it.
		const { points } = await qdrant.scroll(name, { limit: 1, with_payload: true });
		const isChapters = points[0]?.payload?.strategy === 'chapter';
		console.log(`\nCollection "${name}" already has ${count.toLocaleString()} points — reusing it.`);
		if (!isChapters) {
			console.log("  ⚠ These don't look like this script's chapter chunks. Results still work if each");
			console.log('    point stores its text in payload.text — or rebuild with --reindex (or point');
			console.log('    --collection at a fresh name).');
		}
		return;
	}

	console.log(`\n${exists ? 'Recreating' : 'Creating'} Qdrant collection "${name}" (${EMBEDDING_DIMENSIONS}d, Cosine)…`);
	await qdrant.recreateCollection(name, { vectors: { size: EMBEDDING_DIMENSIONS, distance: 'Cosine' } });
	// Qdrant Cloud's strict mode errors on filtering an unindexed field, so index
	// the ones you'd filter on ("only the New Testament") up front.
	for (const field_name of ['book', 'testament']) {
		await qdrant.createPayloadIndex(name, { field_name, field_schema: 'keyword', wait: true });
	}

	// Embed "Luke 15\n<verses>": the reference header gives the vector a little
	// context, and costs nothing. Whole Bible ≈ 1M tokens ≈ $0.02.
	console.log(`Embedding + upserting ${chunks.length} chapters…`);
	const BATCH = 50; // worst-case batch stays well under OpenAI's per-request token cap
	for (let i = 0; i < chunks.length; i += BATCH) {
		const batch = chunks.slice(i, i + BATCH);
		const vectors = await createEmbeddings(batch.map((c) => `${c.metadata.reference}\n${c.text}`));
		await qdrant.upsert(name, {
			wait: true, // otherwise the first query can run before the points are searchable
			points: batch.map((c, j) => ({
				id: c.id,
				vector: vectors[j],
				payload: { ...c.metadata, text: c.text },
			})),
		});
		process.stdout.write(`  ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\r`);
	}
	console.log(`\nCollection "${name}" ready.`);
}

// ─── 3. Search: cosine top-N, then rerank the same candidates ───────────────

async function runQuery(
	collection: string,
	{ query, expect, lesson }: DemoQuery,
	fetchCount: number,
): Promise<QueryResult> {
	const { points } = await qdrant.query(collection, {
		query: await createEmbedding(query),
		limit: fetchCount,
		with_payload: true,
	});

	const candidates: Candidate[] = points.map((p, i) => {
		const payload = (p.payload ?? {}) as Record<string, unknown>;
		const text = String(payload.text ?? payload.content ?? '');
		return {
			id: String(p.id),
			reference: String(payload.reference ?? `point ${p.id}`),
			text,
			cosineRank: i + 1,
			cosineScore: p.score,
			rerankRank: null,
			rerankScore: null,
			truncated: text.length > RERANK_WINDOW_CHARS,
		};
	});
	if (candidates.length > 0 && candidates.every((c) => !c.text)) {
		throw new Error('Points have no text in payload.text — nothing for the reranker to read.');
	}

	// Rerank ALL candidates (topN = fetchCount) so we know where every one of
	// them landed, not just the winners — that's what makes the movement visible.
	// If the reranker fails, degrade to cosine order instead of crashing the demo.
	let rerankError: string | null = null;
	try {
		const reranked = await pinecone.inference.rerank({
			model: RERANK_MODEL,
			query,
			documents: candidates.map((c) => `${c.reference}\n${c.text}`),
			topN: candidates.length,
			returnDocuments: false,
			parameters: { truncate: 'END' },
		});
		reranked.data.forEach((r, i) => {
			candidates[r.index].rerankRank = i + 1;
			candidates[r.index].rerankScore = r.score;
		});
	} catch (err) {
		rerankError = err instanceof Error ? err.message : String(err);
	}

	return { query, expect, lesson, candidates, rerankError };
}

function printComparison(result: QueryResult, keep: number) {
	const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
	const mark = (ref: string) => (ref === result.expect ? '★' : ' ');
	const byCosine = result.candidates.slice(0, keep);
	const byRerank = result.candidates
		.filter((c) => c.rerankRank !== null)
		.sort((a, b) => a.rerankRank! - b.rerankRank!)
		.slice(0, keep);

	console.log(`\n━━ "${result.query}"`);
	if (result.expect) console.log(`   expecting ★ ${result.expect}`);
	if (result.lesson) console.log(`   lesson: ${result.lesson}`);
	if (result.rerankError) {
		console.log(`   ⚠ rerank failed (${result.rerankError}) — showing cosine order only`);
	}
	console.log(`   ${pad('WITHOUT rerank (cosine)', 34)}  WITH rerank (${RERANK_MODEL})`);
	for (let i = 0; i < keep; i++) {
		const a = byCosine[i];
		const b = byRerank[i];
		const left = a ? `${i + 1}.${mark(a.reference)}${pad(a.reference, 20)} ${a.cosineScore.toFixed(3)}` : '';
		let right = '';
		if (b) {
			const move = b.cosineRank === i + 1 ? '  =' : b.cosineRank > i + 1 ? `  ▲ was #${b.cosineRank}` : `  ▼ was #${b.cosineRank}`;
			right = `${i + 1}.${mark(b.reference)}${pad(b.reference, 20)} ${b.rerankScore!.toFixed(3)}${move}${b.truncated ? ' ✂' : ''}`;
		}
		console.log(`   ${pad(left, 34)}  ${right}`);
	}

	// The money shot: something cosine buried that the reranker pulled into the top-K
	const rescued = byRerank.filter((c) => c.cosineRank > keep);
	const promoted =
		rescued.find((c) => c.reference === result.expect) ?? rescued.sort((a, b) => b.cosineRank - a.cosineRank)[0];
	if (promoted) {
		console.log(`   → reranker pulled ${promoted.reference} up from #${promoted.cosineRank} to #${promoted.rerankRank} — cosine alone would never have shown it`);
	}
	if (result.expect) {
		const hit = result.candidates.find((c) => c.reference === result.expect);
		if (!hit) console.log(`   → ${result.expect} wasn't in the top ${result.candidates.length} cosine candidates — reranking can't rescue what retrieval never fetched`);
	}
}

function writeReport(results: QueryResult[], meta: Record<string, unknown>) {
	const template = fs.readFileSync(REPORT_TEMPLATE, 'utf-8');
	// Escape "<" so verse text can never close the <script> tag early
	const data = JSON.stringify({ meta, results }).replace(/</g, '\\u003c');
	fs.writeFileSync(REPORT_OUT, template.replace('/*__DEMO_DATA__*/null', data));
	console.log(`\nWrote ${REPORT_OUT} — open it in a browser for the before/after visual.`);
}

async function main() {
	if (!fs.existsSync('data/bible/kjv.txt')) {
		throw new Error('data/bible/kjv.txt not found — run `npm run bible:fetch` first.');
	}
	const collection = option('collection', process.env.BIBLE_COLLECTION || 'bible_chapters');
	const fetchCount = parseInt(option('fetch', '25'), 10);
	const keep = parseInt(option('keep', '5'), 10);

	const chunks = chunkByChapter(loadVerses());
	printChunkStats(chunks);
	if (flag('dry-run')) return;

	for (const key of ['QDRANT_URL', 'PINECONE_API_KEY']) {
		if (!process.env[key]) throw new Error(`${key} is not set (see .env.example).`);
	}
	// apiKey is required by Qdrant Cloud and ignored by a local Docker instance
	qdrant = new QdrantClient({ url: process.env.QDRANT_URL!, apiKey: process.env.QDRANT_API_KEY });
	pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

	await ensureCollection(collection, chunks, flag('reindex'));

	const custom = customQueries();
	const queries: DemoQuery[] =
		custom.length > 0 ? custom.map((query) => ({ query, expect: null, lesson: null })) : CURATED_QUERIES;

	const results: QueryResult[] = [];
	for (const q of queries) {
		const result = await runQuery(collection, q, fetchCount);
		printComparison(result, keep);
		results.push(result);
	}

	writeReport(results, {
		collection,
		fetchCount,
		keep,
		model: RERANK_MODEL,
		chunkCount: chunks.length,
		rerankWindowChars: RERANK_WINDOW_CHARS,
		generatedAt: new Date().toISOString(),
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
