"use client";

import { useEffect, useState } from "react";
import { api, type KbStatus, type Domain, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { StatCard, Card, CardTitle, Skeleton } from "@/components/card";
import { formatTime } from "@/lib/utils";
import Link from "next/link";
import { Database, Search, FlaskConical, ArrowRight } from "lucide-react";
import { Onboarding, isOnboardingDone } from "@/components/onboarding";

export default function OverviewPage() {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [s, d] = await Promise.all([api.getStatus(), api.getDomains()]);
        setStatus(s);
        setDomains(d.domains ?? []);
        // Show onboarding if first run and no domains
        if (!isOnboardingDone() && (d.domains ?? []).length === 0) {
          setShowOnboarding(true);
        }
      } catch (e) {
        setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (showOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          setShowOnboarding(false);
          // Reload data after onboarding
          setLoading(true);
          Promise.all([api.getStatus(), api.getDomains()])
            .then(([s, d]) => {
              setStatus(s);
              setDomains(d.domains ?? []);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description="Fleet RAG service status at a glance"
      />
      <div className="flex flex-col gap-6 p-6">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-7 w-16" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Domains" value={status?.domains ?? 0} />
              <StatCard label="Files" value={status?.files ?? 0} />
              <StatCard
                label="Active Schemas"
                value={status?.schemas ?? 0}
                hint={`${status?.schema_drafts ?? 0} pending drafts`}
              />
              <StatCard label="Entities" value={status?.entities ?? 0} />
              <StatCard label="Jobs" value={status?.jobs ?? 0} />
              <StatCard
                label="Relationships"
                value={status?.relationships ?? 0}
              />
              <StatCard
                label="Recent Traces"
                value={status?.recent_traces ?? 0}
                hint="last 50"
              />
              <StatCard
                label="Recent Eval Reports"
                value={status?.recent_eval_reports ?? 0}
                hint="last 50"
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardTitle>Domains</CardTitle>
                {domains.length === 0 ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      No domains yet. Create one to start ingesting
                      files and running queries.
                    </p>
                    <Link
                      href="/domains"
                      className="inline-flex h-9 w-fit items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <Database className="size-4" /> Create a domain
                    </Link>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {domains.slice(0, 5).map((d) => (
                      <Link
                        key={d.name}
                        href={`/domains?domain=${encodeURIComponent(d.name)}`}
                        className="card-lift flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2.5">
                          <Database className="size-4 text-muted-foreground" />
                          <span className="font-mono font-medium text-foreground">
                            {d.name}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(d.created_at)}
                        </span>
                      </Link>
                    ))}
                    {domains.length > 5 && (
                      <Link
                        href="/domains"
                        className="flex items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        View all {domains.length} domains
                        <ArrowRight className="size-3" />
                      </Link>
                    )}
                  </div>
                )}
              </Card>

              <Card>
                <CardTitle>Quick actions</CardTitle>
                <div className="flex flex-col gap-2">
                  <Link
                    href="/query"
                    className="card-lift flex items-center gap-3 rounded-lg border border-border bg-background/50 px-3 py-2.5 text-sm"
                  >
                    <Search className="size-4 text-muted-foreground" />
                    <span className="text-foreground">Run a query</span>
                  </Link>
                  <Link
                    href="/ingest"
                    className="card-lift flex items-center gap-3 rounded-lg border border-border bg-background/50 px-3 py-2.5 text-sm"
                  >
                    <FlaskConical className="size-4 text-muted-foreground" />
                    <span className="text-foreground">Ingest files</span>
                  </Link>
                  <Link
                    href="/evals"
                    className="card-lift flex items-center gap-3 rounded-lg border border-border bg-background/50 px-3 py-2.5 text-sm"
                  >
                    <FlaskConical className="size-4 text-muted-foreground" />
                    <span className="text-foreground">Run an eval</span>
                  </Link>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
