"use client";

import { useState, useEffect } from "react";
import {
  api,
  type Domain,
  type EvalReport,
  ApiError,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import { formatTime, formatMs } from "@/lib/utils";
import { Loader2, FlaskConical } from "lucide-react";

export default function EvalsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState("");
  const [reports, setReports] = useState<EvalReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [kind, setKind] = useState<"answer" | "search">("answer");
  const [mode, setMode] = useState("hybrid");
  const [cases, setCases] = useState(
    '[\n  { "id": "q1", "query": "example", "expected_text": "example" }\n]',
  );
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api.getDomains().then((d) => {
      setDomains(d.domains ?? []);
      if (d.domains?.length > 0 && !domain) setDomain(d.domains[0].name);
    }).catch(() => {});
  }, [domain]);

  useEffect(() => {
    if (!domain) return;
    setLoading(true);
    api.getEvalReports(domain)
      .then((r) => setReports(r.reports ?? []))
      .catch((e) =>
        setError(e instanceof ApiError ? `API error ${e.status}` : String(e)),
      )
      .finally(() => setLoading(false));
  }, [domain]);

  async function handleRunEval() {
    if (!domain) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      let parsed: Array<{ id: string; query: string; expected_text?: string }> = [];
      try {
        parsed = JSON.parse(cases);
      } catch {
        setError("Invalid JSON in eval cases");
        setRunning(false);
        return;
      }
      const r =
        kind === "answer"
          ? await api.runAnswerEval({
              domain,
              cases: parsed,
              mode,
              answer_mode: "extractive",
            })
          : await api.runSearchEval({
              domain,
              cases: parsed,
              mode,
              top_k: 5,
            });
      setResult(JSON.stringify(r, null, 2));
      const reports = await api.getEvalReports(domain);
      setReports(reports.reports ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Evals"
        description="Run and review retrieval quality evaluations"
      />
      <div className="flex flex-col gap-6 p-6">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <label className="flex flex-col gap-1.5 max-w-xs">
          <span className="text-sm font-medium text-foreground">Domain</span>
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

        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <FlaskConical className="size-4" /> Run eval
            </span>
          </CardTitle>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Kind
                </span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "answer" | "search")}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <option value="answer">answer</option>
                  <option value="search">search</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Mode
                </span>
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
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Eval cases (JSON)
              </span>
              <textarea
                value={cases}
                onChange={(e) => setCases(e.target.value)}
                rows={6}
                className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
            </label>
            <Button onClick={handleRunEval} disabled={running || !domain}>
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Running eval…
                </>
              ) : (
                "Run eval"
              )}
            </Button>
            {result && (
              <pre className="overflow-x-auto rounded-lg border border-border bg-background/50 p-3 font-mono text-xs text-foreground">
                {result}
              </pre>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            Eval reports
          </h3>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : reports.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">
                No eval reports for this domain yet.
              </p>
            </Card>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Kind</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Hit rate</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Citation rate</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Avg latency</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {reports.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/50">
                      <td className="px-4 py-2.5 font-mono text-xs text-foreground">{r.kind}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-foreground">
                        {r.hit_rate !== null ? `${(r.hit_rate * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-foreground">
                        {r.citation_rate !== null ? `${(r.citation_rate * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-foreground">
                        {formatMs(r.avg_latency_ms)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {formatTime(r.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
