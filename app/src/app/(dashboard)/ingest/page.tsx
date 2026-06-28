"use client";

import { useState, useEffect, useCallback } from "react";
import { api, type Domain, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import {
  Upload,
  FileText,
  Loader2,
  Check,
  FileSpreadsheet,
  FileCode,
  FileImage,
  Globe,
  Type,
  Play,
} from "lucide-react";

const FORMAT_GROUPS = [
  {
    label: "Documents",
    icon: FileText,
    formats: ["PDF", "HTML", "DOCX", "PPTX", "TXT", "MD"],
    hint: "Digital text + scanned OCR",
  },
  {
    label: "Spreadsheets",
    icon: FileSpreadsheet,
    formats: ["XLSX", "CSV"],
    hint: "Rows → records with field types",
  },
  {
    label: "Structured data",
    icon: FileCode,
    formats: ["JSON", "NDJSON", "JSONL"],
    hint: "Nested up to 6 levels, auto-flattened",
  },
  {
    label: "Images & scanned",
    icon: FileImage,
    formats: ["JPEG", "PNG", "WebP"],
    hint: "Vision OCR via Llama 3.2 / 4",
  },
  {
    label: "Live sources",
    icon: Globe,
    formats: ["URL", "SEC EDGAR"],
    hint: "Import by URL or ticker + form",
  },
  {
    label: "Free-form text",
    icon: Type,
    formats: ["Inline", "Records"],
    hint: "Paste text or POST structured records",
  },
];

export default function IngestPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domain, setDomain] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [textTitle, setTextTitle] = useState("");
  const [text, setText] = useState("");
  const [markdownConversion, setMarkdownConversion] = useState("");
  const [sourceKind, setSourceKind] = useState<"url" | "edgar">("url");
  const [sourceUrls, setSourceUrls] = useState("");
  const [edgarTickers, setEdgarTickers] = useState("NVDA,AAPL,MSFT");
  const [edgarForms, setEdgarForms] = useState("10-K,10-Q,8-K");
  const [autoIngest, setAutoIngest] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    api.getDomains().then((d) => {
      setDomains(d.domains ?? []);
      if (d.domains?.length > 0 && !domain) setDomain(d.domains[0].name);
    }).catch(() => {});
  }, [domain]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }, []);

  async function handleUpload() {
    if (!domain || !file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      await api.uploadFile(domain, file, {
        markdown_conversion: markdownConversion || undefined,
      });
      setSuccess(`Uploaded ${file.name}`);
      setFile(null);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function handleIngestText() {
    if (!domain || !text.trim()) return;
    setIngesting(true);
    setError(null);
    setSuccess(null);
    try {
      await api.ingestText({
        domain,
        text: text.trim(),
        title: textTitle.trim() || undefined,
      });
      setSuccess("Text ingested");
      setText("");
      setTextTitle("");
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setIngesting(false);
    }
  }

  async function handleInferSchemaDraft() {
    if (!domain || !text.trim()) return;
    setInferring(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await api.inferSchema({
        domain,
        sample_texts: [text.trim()],
        name: textTitle.trim() || undefined,
        save_draft: true,
      });
      setSuccess(
        r.draft_id
          ? `Schema draft saved (${r.draft_id.slice(0, 8)})`
          : "Schema inferred",
      );
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setInferring(false);
    }
  }

  async function handleSourceImport() {
    if (!domain) return;
    setImporting(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await api.importSource({
        domain,
        source: sourceKind,
        auto_ingest: autoIngest,
        config:
          sourceKind === "url"
            ? {
                urls: sourceUrls
                  .split(/\n|,/)
                  .map((url) => url.trim())
                  .filter(Boolean),
              }
            : {
                tickers: edgarTickers
                  .split(",")
                  .map((ticker) => ticker.trim())
                  .filter(Boolean),
                forms: edgarForms
                  .split(",")
                  .map((form) => form.trim())
                  .filter(Boolean),
                limit_total: 12,
              },
      });
      setSuccess(
        `Imported ${r.files.length} file${r.files.length === 1 ? "" : "s"} from ${r.source}` +
          (r.jobs.length ? `, queued ${r.jobs.length} job${r.jobs.length === 1 ? "" : "s"}` : "") +
          (r.errors.length ? `, ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}` : ""),
      );
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function handleIngestRun() {
    if (!domain) return;
    setIngesting(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await api.ingestRun({
        domain,
        async: true,
        markdown_conversion: markdownConversion || undefined,
      });
      setSuccess(
        r.run_id
          ? `Ingest queued (run ${r.run_id.slice(0, 8)})`
          : "Ingest started",
      );
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setIngesting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Ingest"
        description="Upload files or text — any format, any structure"
      />
      <div className="flex flex-col gap-6 p-6 max-w-3xl">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {success && (
          <div className="result-card flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
            <Check className="size-4" /> {success}
          </div>
        )}

        {/* Format showcase */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FORMAT_GROUPS.map((group, i) => {
            const Icon = group.icon;
            return (
              <div
                key={group.label}
                className="result-card card-lift flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-accent" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    {group.label}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.formats.map((f) => (
                    <span
                      key={f}
                      className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {f}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{group.hint}</p>
              </div>
            );
          })}
        </div>

        {/* Config */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Domain</span>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
            >
              {domains.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              Markdown conversion
            </span>
            <select
              value={markdownConversion}
              onChange={(e) => setMarkdownConversion(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="">env/default</option>
              <option value="auto">auto</option>
              <option value="always">always</option>
              <option value="off">off</option>
            </select>
          </label>
        </div>

        {/* Upload — drag and drop */}
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Upload className="size-4" /> Upload file
            </span>
          </CardTitle>
          <div className="flex flex-col gap-3">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
                dragOver
                  ? "border-accent bg-accent/5"
                  : "border-border bg-background/50"
              }`}
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
            <Button onClick={handleUpload} disabled={uploading || !domain || !file}>
              {uploading ? (
                <>
                  <Loader2 className="size-4 spin" /> Uploading…
                </>
              ) : (
                <>
                  <Upload className="size-4" /> Upload to R2
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* Ingest text */}
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <FileText className="size-4" /> Ingest text
            </span>
          </CardTitle>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Title (optional)</span>
              <input
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="note"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Text</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Paste free-form domain text, JSON, CSV, NDJSON…"
                className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground"
              />
            </label>
            <Button
              variant="secondary"
              onClick={handleIngestText}
              disabled={ingesting || !domain || !text.trim()}
            >
              {ingesting ? (
                <>
                  <Loader2 className="size-4 spin" /> Ingesting…
                </>
              ) : (
                "Ingest text"
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={handleInferSchemaDraft}
              disabled={inferring || !domain || !text.trim()}
            >
              {inferring ? (
                <>
                  <Loader2 className="size-4 spin" /> Inferring…
                </>
              ) : (
                <>
                  <FileCode className="size-4" /> Infer schema draft
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* Source import */}
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Globe className="size-4" /> Import source
            </span>
          </CardTitle>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Source</span>
                <select
                  value={sourceKind}
                  onChange={(e) => setSourceKind(e.target.value as "url" | "edgar")}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  <option value="url">URL</option>
                  <option value="edgar">SEC EDGAR</option>
                </select>
              </label>
              <label className="flex items-center gap-2 pt-6 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={autoIngest}
                  onChange={(e) => setAutoIngest(e.target.checked)}
                  className="size-4"
                />
                Auto-queue ingest
              </label>
            </div>

            {sourceKind === "url" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  URLs
                </span>
                <textarea
                  value={sourceUrls}
                  onChange={(e) => setSourceUrls(e.target.value)}
                  rows={4}
                  placeholder="https://example.com/report.pdf"
                  className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground"
                />
              </label>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Tickers
                  </span>
                  <input
                    value={edgarTickers}
                    onChange={(e) => setEdgarTickers(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Forms
                  </span>
                  <input
                    value={edgarForms}
                    onChange={(e) => setEdgarForms(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
                  />
                </label>
              </div>
            )}

            <Button
              variant="secondary"
              onClick={handleSourceImport}
              disabled={
                importing ||
                !domain ||
                (sourceKind === "url" && !sourceUrls.trim()) ||
                (sourceKind === "edgar" && !edgarTickers.trim())
              }
            >
              {importing ? (
                <>
                  <Loader2 className="size-4 spin" /> Importing…
                </>
              ) : (
                <>
                  <Globe className="size-4" /> Import source
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* Run ingestion */}
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Play className="size-4" /> Run ingestion
            </span>
          </CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Trigger ingestion of all staged files for this domain. Uses
            Cloudflare Queue + Workflow for durable async processing.
          </p>
          <Button
            variant="secondary"
            onClick={handleIngestRun}
            disabled={ingesting || !domain}
          >
            {ingesting ? (
              <>
                <Loader2 className="size-4 spin" /> Queuing…
              </>
            ) : (
              "Queue ingest run"
            )}
          </Button>
        </Card>
      </div>
    </>
  );
}
