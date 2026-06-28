"use client";

import { useState, useEffect, useCallback } from "react";
import {
  api,
  type Domain,
  type SearchResults,
  type QueryResult,
  ApiError,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import { formatMs, formatScore, cn } from "@/lib/utils";
import { Search, Sparkles, Loader2, Database } from "lucide-react";
import Link from "next/link";

type Tab = "search" | "answer";

export default function QueryPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState("");
  const [query, setQuery] = useState("What is this corpus about?");
  const [mode, setMode] = useState("hybrid");
  const [topK, setTopK] = useState(5);
  const [answerMode, setAnswerMode] = useState("extractive");
  const [tab, setTab] = useState<Tab>("answer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  useEffect(() => {
    api.getDomains().then((d) => {
      setDomains(d.domains ?? []);
      if (d.domains?.length > 0 && !domain) setDomain(d.domains[0].name);
    }).catch(() => {});
  }, [domain]);

  const runSearch = useCallback(async () => {
    if (!domain || !query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.search({
        domain,
        query: query.trim(),
        mode,
        top_k: topK,
        rerank: true,
        mmr: true,
      });
      setSearchResults(r);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setLoading(false);
    }
  }, [domain, query, mode, topK]);

  const runQuery = useCallback(async () => {
    if (!domain || !query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.query({
        domain,
        question: query.trim(),
        mode,
        top_k: topK,
        answer_mode: answerMode,
        rerank: true,
        mmr: true,
        query_rewrite: true,
        query_decompose: true,
      });
      setQueryResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setLoading(false);
    }
  }, [domain, query, mode, topK, answerMode]);

  function handleRun() {
    if (tab === "search") runSearch();
    else runQuery();
  }

  return (
    <>
      <PageHeader
        title="Query"
        description="Search your corpus or get cited answers"
      />
      <div className="flex flex-col gap-6 p-6">
        {domains.length === 0 && (
          <Card>
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div
                className="flex size-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: "var(--accent)", color: "var(--accent-foreground)" }}
              >
                <Database className="size-6" />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold text-foreground">
                  No domains to query
                </h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Create a domain and ingest some files first, then
                  come back to run queries.
                </p>
              </div>
              <Link
                href="/domains"
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Database className="size-4" /> Go to domains
              </Link>
            </div>
          </Card>
        )}

        {domains.length > 0 && (
        <>
        {/* Query bar */}
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Domain</span>
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {domains.map((d) => (
                    <option key={d.name} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Mode</span>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <option value="auto">auto</option>
                  <option value="hybrid">hybrid</option>
                  <option value="lexical">lexical</option>
                  <option value="semantic">semantic</option>
                </select>
              </label>
              <label className="flex w-20 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Top K</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {tab === "search" ? "Query" : "Question"}
              </span>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={3}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
            </label>

            {/* Tab toggle */}
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-border p-0.5">
                <button
                  onClick={() => setTab("search")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    tab === "search"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Search className="size-3.5" /> Search
                </button>
                <button
                  onClick={() => setTab("answer")}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    tab === "answer"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Sparkles className="size-3.5" /> Answer
                </button>
              </div>
              {tab === "answer" && (
                <select
                  value={answerMode}
                  onChange={(e) => setAnswerMode(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <option value="extractive">extractive</option>
                  <option value="workers_ai">Workers AI</option>
                </select>
              )}
              <div className="flex-1" />
              <Button onClick={handleRun} disabled={loading || !domain || !query.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Running…
                  </>
                ) : tab === "search" ? (
                  <>
                    <Search className="size-4" /> Search
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" /> Answer
                  </>
                )}
              </Button>
            </div>
          </div>
        </Card>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Search results */}
        {tab === "search" && searchResults && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{searchResults.results.length} results · {searchResults.mode}</span>
              <span>{formatMs(searchResults.latency_ms)}</span>
            </div>
            {searchResults.results.map((r, i) => (
              <Card key={r.chunk_id} className="result-card" style={{ animationDelay: `${i * 0.06}s` }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded font-mono text-xs font-bold bg-accent text-accent-foreground">
                        {i + 1}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.document}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-foreground">
                      {r.content}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatScore(r.score)}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Answer results */}
        {tab === "answer" && queryResult && (
          <div className="flex flex-col gap-4">
            <Card>
              <CardTitle>Answer</CardTitle>
              <p className="text-sm leading-relaxed text-foreground">
                {queryResult.answer}
              </p>
              <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Mode: {queryResult.mode}</span>
                <span>Latency: {formatMs(queryResult.latency_ms)}</span>
                {queryResult.confidence !== null && (
                  <span>Confidence: {formatScore(queryResult.confidence)}</span>
                )}
                {queryResult.trace_id && (
                  <Link
                    href="/traces"
                    className="text-accent underline-offset-4 hover:underline"
                  >
                    Trace: {queryResult.trace_id.slice(0, 8)}
                  </Link>
                )}
              </div>
            </Card>

            {queryResult.citations.length > 0 && (
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Sources ({queryResult.citations.length})
                </h3>
                {queryResult.citations.map((c, i) => (
                  <Card key={c.chunk_id} className="result-card" style={{ animationDelay: `${i * 0.08}s` }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex size-5 items-center justify-center rounded font-mono text-xs font-bold bg-accent text-accent-foreground">
                            {i + 1}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.document}
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed text-foreground">
                          {c.content}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {formatScore(c.score)}
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>
    </>
  );
}
