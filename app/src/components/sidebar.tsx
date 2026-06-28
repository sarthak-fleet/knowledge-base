"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Database,
  Search,
  FileUp,
  FlaskConical,
  Activity,
  Settings,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/domains", label: "Domains", icon: Database },
  { href: "/query", label: "Query", icon: Search },
  { href: "/ingest", label: "Ingest", icon: FileUp },
  { href: "/evals", label: "Evals", icon: FlaskConical },
  { href: "/traces", label: "Traces", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex h-svh w-60 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <span
          className="flex size-8 items-center justify-center rounded-lg font-mono text-sm font-bold"
          style={{ backgroundColor: "var(--accent)", color: "var(--accent-foreground)" }}
        >
          KB
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">Knowledgebase</span>
          <span className="text-xs text-muted-foreground">Dashboard</span>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
                active
                  ? "nav-item-active bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground hover:translate-x-0.5",
              )}
            >
              <Icon className={cn("size-4 transition-transform", active && "text-accent")} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-3">
        <a
          href="https://knowledgebase-landing.pages.dev/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to landing
        </a>
      </div>
    </aside>
  );
}
