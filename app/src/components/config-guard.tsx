"use client";

import { useEffect, useState } from "react";
import {
  isConfigured,
  getServiceUrl,
  getServiceKey,
  setServiceUrl,
  setServiceKey,
  api,
  ApiError,
} from "@/lib/api";
import { Button } from "@/components/button";
import { Loader2, AlertCircle, ArrowRight } from "lucide-react";

export function ConfigGuard({ children }: { children: React.ReactNode }) {
  const [configured, setConfigured] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Inline connection form state
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const configuredNow = isConfigured();
    setConfigured(configuredNow);
    if (!configuredNow) {
      // Pre-fill URL from env default if available
      setUrl(getServiceUrl());
      setKey(getServiceKey());
    }
  }, []);

  // Listen for storage changes (e.g. user saves in settings page)
  useEffect(() => {
    function onStorage() {
      setConfigured(isConfigured());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  async function handleConnect() {
    if (!url.trim() || !key.trim()) return;
    setConnecting(true);
    setError(null);
    // Save first so the API client can use them
    setServiceUrl(url.trim());
    setServiceKey(key.trim());
    try {
      await api.getStatus();
      setConfigured(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `API error ${e.status} — check URL and key`
          : e instanceof Error
            ? e.message
            : "Connection failed",
      );
    } finally {
      setConnecting(false);
    }
  }

  if (!mounted) {
    return (
      <div className="flex h-svh items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="page-fade flex min-h-svh items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className="flex size-12 items-center justify-center rounded-xl font-mono text-lg font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-foreground)",
              }}
            >
              KB
            </span>
            <h1 className="text-xl font-semibold text-foreground">
              Connect your Knowledgebase
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter your RAG service URL and service key to start
              managing domains, ingesting files, and running queries.
            </p>
          </div>

          {/* Connection form */}
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                Service URL
              </span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                placeholder="https://knowledgebase.sarthakagrawal927.workers.dev"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                Service Key
              </span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                placeholder="RAG_SERVICE_KEY"
                autoComplete="off"
                className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground"
              />
              <span className="text-xs text-muted-foreground">
                Stored in your browser localStorage. Never sent anywhere
                except the RAG service.
              </span>
            </label>

            {error && (
              <div className="result-card flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              onClick={handleConnect}
              disabled={connecting || !url.trim() || !key.trim()}
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 spin" /> Connecting…
                </>
              ) : (
                <>
                  Connect <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </div>

          {/* Help text */}
          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have a service key? Run the Worker locally with{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
              pnpm dev
            </code>{" "}
            and check the Worker logs, or set{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
              RAG_SERVICE_KEY
            </code>{" "}
            in your Worker secrets.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
