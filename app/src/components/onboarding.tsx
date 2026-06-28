"use client";

import { useState, useEffect, useCallback } from "react";
import {
  api,
  type Domain,
  type EmbeddingModel,
  ApiError,
} from "@/lib/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import {
  Check,
  Loader2,
  Database,
  Upload,
  Search,
  ArrowRight,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ONBOARDING_KEY = "kb_onboarding_done";
const STEPS = ["domain", "ingest", "query"] as const;
type Step = (typeof STEPS)[number];

export function Onboarding({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [step, setStep] = useState<Step>("domain");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [models, setModels] = useState<EmbeddingModel[]>([]);
  const [loading, setLoading] = useState(true);

  // Step 1: domain creation
  const [domainName, setDomainName] = useState("");
  const [domainDesc, setDomainDesc] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdDomain, setCreatedDomain] = useState<string | null>(null);

  // Step 2: ingest
  const [file, setFile] = useState<File | null>(null);
  const [sampleText, setSampleText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [ingested, setIngested] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Step 3: query
  const [query, setQuery] = useState("What is this corpus about?");
  const [querying, setQuerying] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<number>(0);

  // Error
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getDomains(), api.getEmbeddingModels()])
      .then(([d, m]) => {
        setDomains(d.domains ?? []);
        const selectable = (m.free_ai_models ?? []).filter(
          (model) => model.selectable,
        );
        setModels(selectable);
        if (selectable.length > 0 && !embeddingModel) {
          setEmbeddingModel(selectable[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [embeddingModel]);

  async function handleCreateDomain() {
    if (!domainName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.createDomain({
        name: domainName.trim(),
        description: domainDesc.trim() || undefined,
        embedding_model: embeddingModel || undefined,
      });
      setCreatedDomain(domainName.trim());
      setStep("ingest");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Failed to create domain: API error ${e.status}`
          : e instanceof Error
            ? e.message
            : "Failed to create domain",
      );
    } finally {
      setCreating(false);
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }, []);

  async function handleIngest() {
    const domain = createdDomain;
    if (!domain) return;
    setUploading(true);
    setError(null);
    try {
      if (file) {
        await api.uploadFile(domain, file);
        // Trigger ingestion
        await api.ingestRun({ domain, async: true });
      } else if (sampleText.trim()) {
        await api.ingestText({
          domain,
          text: sampleText.trim(),
          title: "onboarding-sample",
        });
      } else {
        return;
      }
      setIngested(true);
      setStep("query");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Failed to ingest: API error ${e.status}`
          : e instanceof Error
            ? e.message
            : "Failed to ingest",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleQuery() {
    const domain = createdDomain;
    if (!domain) return;
    setQuerying(true);
    setError(null);
    try {
      const r = await api.query({
        domain,
        question: query.trim(),
        mode: "hybrid",
        answer_mode: "extractive",
        top_k: 5,
      });
      setAnswer(r.answer);
      setCitations(r.citations.length);
      // Mark onboarding done
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Query failed: API error ${e.status}`
          : e instanceof Error
            ? e.message
            : "Query failed",
      );
    } finally {
      setQuerying(false);
    }
  }

  function handleSkip() {
    localStorage.setItem(ONBOARDING_KEY, "1");
    onComplete();
  }

  function handleFinish() {
    onComplete();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 spin text-muted-foreground" />
      </div>
    );
  }

  // If domains already exist, skip onboarding entirely
  if (domains.length > 0) {
    localStorage.setItem(ONBOARDING_KEY, "1");
    onComplete();
    return null;
  }

  return (
    <div className="page-fade flex flex-col gap-6 p-6 max-w-2xl">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">
            Welcome to Knowledgebase
          </h1>
          <button
            onClick={handleSkip}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Skip onboarding"
          >
            <X className="size-5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Let&apos;s get your first domain set up. Takes about a minute.
        </p>
      </div>

      {/* Progress indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => {
          const isComplete = STEPS.indexOf(step) > i;
          const isCurrent = step === s;
          return (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors",
                  isComplete && "bg-accent text-accent-foreground",
                  isCurrent && "border-2 border-accent text-foreground",
                  !isComplete && !isCurrent && "border border-border text-muted-foreground",
                )}
              >
                {isComplete ? <Check className="size-3.5" /> : i + 1}
              </div>
              <span
                className={cn(
                  "text-xs font-medium",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {s === "domain" ? "Create domain" : s === "ingest" ? "Add data" : "Query"}
              </span>
              {i < STEPS.length - 1 && (
                <div
                  className={cn(
                    "h-px flex-1 transition-colors",
                    isComplete ? "bg-accent" : "bg-border",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="result-card flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <X className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step 1: Create domain */}
      {step === "domain" && (
        <Card className="result-card">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Database className="size-5 text-accent" />
              <h2 className="text-base font-semibold text-foreground">
                Create your first domain
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              A domain is a private corpus — your files, schemas, and
              entities live inside it. Name it after your project or
              data type.
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Name</span>
              <input
                value={domainName}
                onChange={(e) => setDomainName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateDomain()}
                placeholder="my-project"
                className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                Description (optional)
              </span>
              <input
                value={domainDesc}
                onChange={(e) => setDomainDesc(e.target.value)}
                placeholder="What's in this corpus?"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </label>
            {models.length > 0 && (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  Embedding model
                </span>
                <select
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.dimensions}d · {m.provider}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  Determines vector dimensions. Can&apos;t be changed after
                  ingestion.
                </span>
              </label>
            )}
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={handleCreateDomain} disabled={creating || !domainName.trim()}>
                {creating ? (
                  <>
                    <Loader2 className="size-4 spin" /> Creating…
                  </>
                ) : (
                  <>
                    Create domain <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
              <Button variant="ghost" onClick={handleSkip}>
                Skip setup
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 2: Ingest data */}
      {step === "ingest" && (
        <Card className="result-card">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Upload className="size-5 text-accent" />
              <h2 className="text-base font-semibold text-foreground">
                Add data to {createdDomain}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Upload a file (PDF, DOCX, XLSX, JSON, CSV, HTML, images)
              or paste text. You can add more later.
            </p>

            {/* Drag and drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
                dragOver
                  ? "border-accent bg-accent/5"
                  : "border-border bg-background/50",
              )}
            >
              <Upload className="size-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Drag a file here, or
              </span>
              <label className="cursor-pointer text-sm font-medium text-accent underline-offset-4 hover:underline">
                browse
                <input
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
              {file && (
                <span className="mt-2 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground">
                  {file.name} · {(file.size / 1024).toFixed(1)}KB
                </span>
              )}
            </div>

            {/* Or paste text */}
            {!file && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  or paste text
                  <div className="h-px flex-1 bg-border" />
                </div>
                <textarea
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                  rows={4}
                  placeholder="Paste any text — notes, JSON, CSV, transcripts…"
                  className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={handleIngest}
                disabled={uploading || (!file && !sampleText.trim())}
              >
                {uploading ? (
                  <>
                    <Loader2 className="size-4 spin" /> Ingesting…
                  </>
                ) : (
                  <>
                    {file ? "Upload & ingest" : "Ingest text"} <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
              <Button variant="ghost" onClick={() => setStep("query")}>
                Skip for now
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 3: Query */}
      {step === "query" && (
        <Card className="result-card">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Search className="size-5 text-accent" />
              <h2 className="text-base font-semibold text-foreground">
                Run your first query
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {ingested
                ? "Your data is ingesting. Try a query — it may take a moment for chunks to be indexed."
                : "Try a query against your domain. If you skipped ingestion, this will return empty results."}
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Question</span>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={2}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>

            {answer && (
              <div className="result-card flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-accent">
                  <Sparkles className="size-4" /> Answer
                </div>
                <p className="text-sm leading-relaxed text-foreground">
                  {answer}
                </p>
                {citations > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {citations} citation{citations !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Button onClick={handleQuery} disabled={querying || !query.trim()}>
                {querying ? (
                  <>
                    <Loader2 className="size-4 spin" /> Querying…
                  </>
                ) : answer ? (
                  "Run again"
                ) : (
                  <>
                    <Search className="size-4" /> Run query
                  </>
                )}
              </Button>
              {answer !== null && (
                <Button variant="secondary" onClick={handleFinish}>
                  <Check className="size-4" /> Done — go to dashboard
                </Button>
              )}
              <Button variant="ghost" onClick={handleFinish}>
                Skip
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

export function isOnboardingDone(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ONBOARDING_KEY) === "1";
}

export function resetOnboarding(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ONBOARDING_KEY);
}
