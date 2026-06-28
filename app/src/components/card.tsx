import { cn } from "@/lib/utils";

export function Card({
  className,
  children,
  lift = false,
  style,
}: {
  className?: string;
  children: React.ReactNode;
  lift?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-5",
        lift && "card-lift",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-sm font-semibold text-foreground">{children}</h3>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card lift>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-2xl font-bold text-foreground">
          {value}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </Card>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} />;
}
