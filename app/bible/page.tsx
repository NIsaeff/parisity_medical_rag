"use client";

import { useState } from "react";

type Row = {
  rank: number;
  reference: string;
  text: string;
  score: number;
  cosineRank?: number;
};
type Result = { searchMs: number; rerankMs: number; plain: Row[]; reranked: Row[] };

const EXAMPLES = [
  "what does it say about forgiving your enemies",
  "dealing with anxiety and worry",
  "a rich man's trouble getting into heaven",
  "being humble when you succeed",
];

const field = "px-3 py-2 bg-copilot-input border border-copilot-border rounded text-copilot-text text-sm";

function Column({ title, sub, rows, final }: { title: string; sub: string; rows: Row[]; final?: boolean }) {
  return (
    <div className="flex-1 min-w-0">
      <h2 className="font-semibold text-white">{title}</h2>
      <p className="text-xs text-copilot-muted mb-3">{sub}</p>
      <ol className="space-y-2">
        {rows.map((r, i) => {
          const moved = final && r.cosineRank ? r.cosineRank - (i + 1) : 0;
          return (
            <li key={r.reference + i} className="border border-copilot-border rounded-lg p-3 text-sm bg-copilot-sidebar">
              <div className="flex justify-between gap-2 font-medium text-white">
                <span>{i + 1}. {r.reference}</span>
                <span className="text-xs text-copilot-muted whitespace-nowrap">
                  {final && r.cosineRank && (
                    <span className={moved > 0 ? "text-green-400" : moved < 0 ? "text-red-400" : ""}>
                      {moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : "="} was #{r.cosineRank}{" "}
                    </span>
                  )}
                  {r.score.toFixed(4)}
                </span>
              </div>
              <p className="text-copilot-text mt-1">{r.text}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default function BiblePage() {
  const [query, setQuery] = useState(EXAMPLES[0]);
  const [collection, setCollection] = useState("bible_smart");
  const [candidates, setCandidates] = useState(25);
  const [top, setTop] = useState(5);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run(q = query) {
    setQuery(q);
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/bible-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, collection, candidates, top }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const moved = data?.reranked.filter((r, i) => r.cosineRank !== i + 1).length ?? 0;

  return (
    <div className="flex flex-col h-screen bg-copilot-bg">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-copilot-border bg-copilot-sidebar">
        <div className="w-8 h-8 rounded-lg bg-copilot-accent flex items-center justify-center text-white font-semibold">B</div>
        <h1 className="text-lg font-semibold text-white">Bible search: cosine vs. reranked</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-6xl mx-auto">
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-wrap gap-2 mb-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} className={field + " flex-1 min-w-64"} />
        <select value={collection} onChange={(e) => setCollection(e.target.value)} className={field}>
          <option value="bible_smart">bible_smart</option>
          <option value="bible_fixed">bible_fixed</option>
        </select>
        <label className="text-sm text-copilot-muted flex items-center gap-1">candidates
          <input type="number" value={candidates} onChange={(e) => setCandidates(+e.target.value)} className={field + " w-20"} />
        </label>
        <label className="text-sm text-copilot-muted flex items-center gap-1">top
          <input type="number" value={top} onChange={(e) => setTop(+e.target.value)} className={field + " w-16"} />
        </label>
        <button disabled={loading} className="px-4 py-2 bg-copilot-accent text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 text-sm font-medium transition-colors">
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="flex flex-wrap gap-2 mb-6">
        {EXAMPLES.map((q) => (
          <button key={q} onClick={() => run(q)} className="px-3 py-2 text-sm rounded-lg border border-copilot-border bg-copilot-sidebar text-copilot-text hover:border-copilot-accent transition-colors">{q}</button>
        ))}
      </div>
      {error && <p className="text-red-400 mb-4">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-copilot-muted mb-4">
            {moved} of {data.reranked.length} positions changed · search {data.searchMs}ms · rerank +{data.rerankMs}ms
          </p>
          <div className="flex flex-col md:flex-row gap-6">
            <Column title="Without reranking" sub={`Qdrant cosine, top ${top}`} rows={data.plain} />
            <Column title="With reranking" sub={`top ${candidates} candidates → Cohere rerank-v3.5 → top ${top}`} rows={data.reranked} final />
          </div>
        </>
      )}
      </div>
      </div>
    </div>
  );
}
