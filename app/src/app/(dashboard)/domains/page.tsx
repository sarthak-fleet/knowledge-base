"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ApiError,
  api,
  type Domain,
  type EmbeddingModel,
  type EntityRecord,
  type FileEntry,
  type Job,
  type RelationshipRecord,
  type SchemaDraft,
  type SchemaRecord,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import { formatTime } from "@/lib/utils";
import {
  Briefcase,
  Database,
  FileText,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [models, setModels] = useState<EmbeddingModel[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [schemas, setSchemas] = useState<SchemaRecord[]>([]);
  const [drafts, setDrafts] = useState<SchemaDraft[]>([]);
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newModel, setNewModel] = useState("");
  const [creating, setCreating] = useState(false);

  const loadDomains = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        api.getDomains(),
        api.getEmbeddingModels(),
      ]);
      setDomains(d.domains ?? []);
      setModels((m.free_ai_models ?? []).filter((model) => model.selectable));
      if (!selected && d.domains?.length > 0) setSelected(d.domains[0].name);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const loadDetail = useCallback(async (domain: string) => {
    setDetailLoading(true);
    try {
      const [f, j, s, d, e, r] = await Promise.all([
        api.getFiles(domain),
        api.getJobs(domain),
        api.getSchemas(domain),
        api.getSchemaDrafts(domain),
        api.getEntities(domain),
        api.getRelationships(domain),
      ]);
      setFiles(f.files ?? []);
      setJobs(j.jobs ?? []);
      setSchemas(s);
      setDrafts(d);
      setEntities(e);
      setRelationships(r);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
      setFiles([]);
      setJobs([]);
      setSchemas([]);
      setDrafts([]);
      setEntities([]);
      setRelationships([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [loadDetail, selected]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const name = newName.trim();
      await api.createDomain({
        name,
        description: newDesc.trim() || undefined,
        embedding_model: newModel || undefined,
      });
      setNewName("");
      setNewDesc("");
      setNewModel("");
      setShowCreate(false);
      await loadDomains();
      setSelected(name);
      setNotice(`Created domain ${name}`);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    if (!selected) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(label);
      await loadDetail(selected);
    } catch (e) {
      setError(e instanceof ApiError ? `API error ${e.status}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  const activeSchema = schemas.find((schema) => schema.is_active === 1);

  return (
    <>
      <PageHeader
        title="Domains"
        description="Operate corpora, schemas, ingestion, and graph metadata"
        action={
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="size-4" /> New domain
          </Button>
        }
      />
      <div className="flex flex-col gap-6 p-6">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
            {notice}
          </div>
        )}

        {showCreate && (
          <Card className="result-card">
            <CardTitle>Create domain</CardTitle>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Name</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-domain"
                  className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground"
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Description</span>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Optional description"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
                />
              </label>
              {models.length > 0 && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-foreground">
                    Embedding model
                  </span>
                  <select
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    <option value="">env default</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} · {m.dimensions}d · {m.provider}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    Can&apos;t be changed after ingestion.
                  </span>
                </label>
              )}
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                  {creating ? (
                    <>
                      <Loader2 className="size-4 spin" /> Creating…
                    </>
                  ) : (
                    "Create"
                  )}
                </Button>
                <Button variant="secondary" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 spin" /> Loading domains…
          </div>
        ) : domains.length === 0 ? (
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
                  No domains yet
                </h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Create your first domain to start ingesting files,
                  inferring schemas, and running cited queries.
                </p>
              </div>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="size-4" /> Create your first domain
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
            <div className="flex flex-col gap-2">
              {domains.map((d) => (
                <button
                  key={d.name}
                  onClick={() => setSelected(d.name)}
                  className={`card-lift flex flex-col gap-1 rounded-lg border px-4 py-3 text-left ${
                    selected === d.name
                      ? "border-accent/40 bg-accent/5"
                      : "border-border bg-card"
                  }`}
                >
                  <span className="flex items-center gap-2 font-mono text-sm font-medium text-foreground">
                    <Database className="size-4 text-muted-foreground" />
                    {d.name}
                  </span>
                  {d.description && (
                    <span className="text-xs text-muted-foreground">
                      {d.description}
                    </span>
                  )}
                  {d.embedding_model && (
                    <span className="text-xs text-muted-foreground">
                      {d.embedding_model} · {d.embedding_provider}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {selected && (
              <div className="flex flex-col gap-6">
                {detailLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 spin" /> Refreshing domain…
                  </div>
                )}

                <Card>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle>
                        <span className="flex items-center gap-2">
                          <Database className="size-4" /> Schema state
                        </span>
                      </CardTitle>
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="font-mono text-foreground">
                          {activeSchema
                            ? `${activeSchema.name} v${activeSchema.version}`
                            : "No active schema"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {drafts.length} pending draft{drafts.length === 1 ? "" : "s"} · {schemas.length} total schema version{schemas.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!activeSchema || busy !== null}
                      onClick={() =>
                        runAction("Queued schema reprocess", () =>
                          api.reprocessDomainSchema(selected),
                        )
                      }
                    >
                      <RefreshCw className="size-4" /> Reprocess
                    </Button>
                  </div>
                  {drafts.length > 0 && (
                    <div className="mt-4 flex flex-col gap-2">
                      {drafts.map((draft) => (
                        <div
                          key={draft.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-mono text-xs text-foreground">
                              {draft.name} · {draft.source}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {draft.sample_count} samples · {formatTime(draft.created_at)}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                runAction("Applied schema draft", () =>
                                  api.applySchemaDraft(draft.id),
                                )
                              }
                            >
                              Apply
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() =>
                                runAction("Discarded schema draft", () =>
                                  api.discardSchemaDraft(draft.id),
                                )
                              }
                            >
                              Discard
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <div className="grid gap-6 xl:grid-cols-2">
                  <Card>
                    <CardTitle>
                      <span className="flex items-center gap-2">
                        <FileText className="size-4" /> Files
                      </span>
                    </CardTitle>
                    {files.length === 0 ? (
                      <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                          No files in this domain yet.
                        </p>
                        <Link
                          href="/ingest"
                          className="inline-flex h-9 w-fit items-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                        >
                          <Upload className="size-4" /> Ingest files
                        </Link>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {files.slice(0, 12).map((f) => (
                          <div
                            key={f.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono text-xs text-foreground">
                                {f.filename}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {(f.size / 1024).toFixed(1)}KB · {f.status} · {formatTime(f.created_at)}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() =>
                                runAction("Queued file reprocess", () =>
                                  api.reprocessFile(f.id),
                                )
                              }
                            >
                              <Play className="size-3.5" /> Replay
                            </Button>
                          </div>
                        ))}
                        {files.length > 12 && (
                          <span className="text-xs text-muted-foreground">
                            +{files.length - 12} more files
                          </span>
                        )}
                      </div>
                    )}
                  </Card>

                  <Card>
                    <CardTitle>
                      <span className="flex items-center gap-2">
                        <Briefcase className="size-4" /> Jobs
                      </span>
                    </CardTitle>
                    {jobs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No jobs for this domain yet.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {jobs.slice(0, 12).map((j) => (
                          <div
                            key={j.id}
                            className="rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2">
                                <span
                                  className={`size-2 rounded-full ${
                                    j.status === "done"
                                      ? "bg-emerald-500"
                                      : j.status === "failed"
                                        ? "bg-red-500"
                                        : "bg-yellow-500"
                                  }`}
                                />
                                <span className="font-mono text-xs text-foreground">
                                  {j.stage}
                                </span>
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {j.status} · {formatTime(j.created_at)}
                              </span>
                            </div>
                            {j.error && (
                              <p className="mt-1 line-clamp-2 text-xs text-destructive">
                                {j.error}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                  <Card>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <CardTitle>
                        <span className="flex items-center gap-2">
                          <Database className="size-4" /> Entities
                        </span>
                      </CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {entities.length} shown
                      </span>
                    </div>
                    {entities.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No extracted entities for this domain yet.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {entities.slice(0, 10).map((entity) => (
                          <div
                            key={entity.id}
                            className="rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                          >
                            <div className="truncate text-foreground">
                              {entity.display_name ?? entity.identity_key}
                            </div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {entity.type} · {entity.identity_key}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <CardTitle>
                        <span className="flex items-center gap-2">
                          <GitBranch className="size-4" /> Relationships
                        </span>
                      </CardTitle>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!activeSchema || busy !== null}
                        onClick={() =>
                          runAction("Backfilled relationships", () =>
                            api.backfillRelationships(selected),
                          )
                        }
                      >
                        Backfill
                      </Button>
                    </div>
                    {relationships.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No relationships for this domain yet.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {relationships.slice(0, 10).map((rel) => (
                          <div
                            key={rel.id}
                            className="rounded-lg border border-border bg-background/50 px-3 py-2 text-sm"
                          >
                            <div className="truncate text-foreground">
                              {rel.source_display_name ?? rel.src_id} → {rel.target_display_name ?? rel.dst_id}
                            </div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {rel.rel_type}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
