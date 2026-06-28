"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type Domain,
  type Trace,
  type TraceDrilldown,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import { formatMs, formatScore, formatTime } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Microscope,
} from "lucide-react";

export default function TracesPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState("");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportSummary, setExportSummary] = useState<Record<string, unknown> | null>(null);
  const [drilldowns, setDrilldowns] = useState<Record<string, TraceDrilldown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getDomains().then((d) => {
      setDomains(d.domains ?? []);
      if (d.domains?.length > 0 && !domain) setDomain(d.domains[0].name);
    }).catch(() => {});
  }, [domain]);

  useEffect(() => {
    if (!domain) return;
    setLoading(true);
    setError(null);
    setExportSummary(null);
    api.getTraces(domain)
      .then((r) => setTraces(r.traces ?? []))
      .catch((e) =>
        setError(e instanceof ApiError ? `API error ${e.status}` : String(e)),
      )
      .finally(() => setLoading(false));
  }, [domain]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleExport() {
    if (!domain) return;
    setBusy("export");
    setError(null);
    try {
      const exported = await api.exportTraces(domain);
      setExportSummary(exported.summary);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleDrilldown(id: string) {
    setBusy(id);
    setError(null);
    try {
      const drilldown = await api.getTraceDrilldown(id);
      setDrilldowns((prev) => ({ ...prev, [id]: drilldown }));
      setExpanded((prev) => new Set(prev).add(id));
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Traces"
        description="Query history, citations, and answer support drilldown"
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={!domain || busy === "export"}
            onClick={handleExport}
          >
            {busy === "export" ? (
              <Loader2 className="size-4 spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export
          </Button>
        }
      />
      <div className="flex flex-col gap-6 p-6">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <label className="flex max-w-xs flex-col gap-1.5">
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

        {exportSummary && (
          <Card>
            <CardTitle>Export summary</CardTitle>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(exportSummary).map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-lg border border-border bg-background/50 px-3 py-2"
                >
                  <div className="text-xs text-muted-foreground">{key}</div>
                  <div className="truncate font-mono text-sm text-foreground">
                    {typeof value === "object" ? JSON.stringify(value) : String(value)}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading traces…</div>
        ) : traces.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              No traces for this domain yet. Run a query to generate one.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {traces.slice(0, 50).map((t) => {
              const isOpen = expanded.has(t.id);
              const drilldown = drilldowns[t.id];
              const quality = drilldown?.quality ?? {};
              const supportScore = quality.support_score;
              return (
                <div
                  key={t.id}
                  className="overflow-hidden rounded-lg border border-border bg-card"
                >
                  <button
                    onClick={() => toggle(t.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate text-sm text-foreground">
                      {t.question}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {t.mode}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {t.citations.length} cites
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {formatMs(t.latency_ms)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTime(t.created_at)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="expand-down flex flex-col gap-4 border-t border-border px-4 py-3">
                      {t.answer && (
                        <p className="text-sm leading-relaxed text-foreground">
                          {t.answer}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">{t.id.slice(0, 12)}</span>
                        {typeof supportScore === "number" && (
                          <span className="rounded border border-border px-2 py-1 font-mono">
                            support {formatScore(supportScore)}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === t.id}
                          onClick={() => handleDrilldown(t.id)}
                        >
                          {busy === t.id ? (
                            <Loader2 className="size-4 spin" />
                          ) : (
                            <Microscope className="size-4" />
                          )}
                          Drilldown
                        </Button>
                      </div>

                      {t.citations.length > 0 && (
                        <div className="flex flex-col gap-2">
                          {t.citations.map((citation, i) => (
                            <div
                              key={`${citation.chunk_id}-${i}`}
                              className="rounded-lg border border-border bg-background/50 px-3 py-2"
                            >
                              <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                                <span className="truncate font-mono text-foreground">
                                  {citation.document}
                                </span>
                                <span className="font-mono text-muted-foreground">
                                  {formatScore(citation.score)}
                                </span>
                              </div>
                              <p className="line-clamp-3 text-sm text-muted-foreground">
                                {citation.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {drilldown && (
                        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-background/50 p-3 font-mono text-xs text-foreground">
                          {JSON.stringify(quality, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
