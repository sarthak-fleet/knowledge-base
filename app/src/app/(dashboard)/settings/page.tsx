"use client";

import { useState, useEffect } from "react";
import {
  getServiceKey,
  setServiceKey,
  getServiceUrl,
  setServiceUrl,
  api,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Card, CardTitle } from "@/components/card";
import { Button } from "@/components/button";
import { Check, AlertCircle, Loader2, LogOut, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/components/onboarding";

export default function SettingsPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  useEffect(() => {
    setUrl(getServiceUrl());
    setKey(getServiceKey());
  }, []);

  function handleSave() {
    setServiceUrl(url.trim());
    setServiceKey(key.trim());
    setSaved(true);
    setTestResult(null);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTest() {
    setServiceUrl(url.trim());
    setServiceKey(key.trim());
    setTesting(true);
    setTestResult(null);
    try {
      await api.getStatus();
      setTestResult({ ok: true, message: "Connection successful" });
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : "Connection failed",
      });
    } finally {
      setTesting(false);
    }
  }

  function handleDisconnect() {
    setServiceUrl("");
    setServiceKey("");
    setUrl("");
    setKey("");
    setTestResult(null);
    // Reload to trigger the config guard
    window.location.href = "/";
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configure your RAG service connection"
      />
      <div className="flex flex-col gap-6 p-6 max-w-2xl">
        <Card>
          <CardTitle>Connection</CardTitle>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                Service URL
              </span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://knowledgebase.sarthakagrawal927.workers.dev"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
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
                placeholder="RAG_SERVICE_KEY"
                autoComplete="off"
                className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground"
              />
              <span className="text-xs text-muted-foreground">
                Stored in your browser localStorage. Never sent anywhere
                except the RAG service.
              </span>
            </label>
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={handleSave}>
                {saved ? (
                  <>
                    <Check className="size-4" /> Saved
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              <Button
                variant="secondary"
                onClick={handleTest}
                disabled={testing || !url || !key}
              >
                {testing ? (
                  <>
                    <Loader2 className="size-4 spin" /> Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
              <Button
                variant="ghost"
                onClick={handleDisconnect}
                className="ml-auto text-destructive hover:text-destructive"
              >
                <LogOut className="size-4" /> Disconnect
              </Button>
            </div>
            {testResult && (
              <div
                className={`result-card flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  testResult.ok
                    ? "bg-accent/10 text-accent"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {testResult.ok ? (
                  <Check className="size-4" />
                ) : (
                  <AlertCircle className="size-4" />
                )}
                {testResult.message}
                {testResult.ok && (
                  <button
                    onClick={() => router.push("/")}
                    className="ml-auto text-xs font-medium underline-offset-4 hover:underline"
                  >
                    Go to dashboard →
                  </button>
                )}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardTitle>About</CardTitle>
          <p className="text-sm text-muted-foreground">
            The Knowledgebase dashboard talks directly to the RAG Worker
            API from your browser. Your service key is stored locally
            and used only for API authentication. No data is sent to any
            third party.
          </p>
        </Card>

        <Card>
          <CardTitle>Onboarding</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Replay the first-run setup wizard (create domain, ingest
            data, run a query).
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              resetOnboarding();
              router.push("/");
            }}
          >
            <RotateCcw className="size-4" /> Reset onboarding
          </Button>
        </Card>
      </div>
    </>
  );
}
