/**
 * Shared pieces for the settings sub-pages: the section card, the notice
 * banner, the read-only summary list, and small helpers every section
 * reuses.
 */
import * as React from "react";
import { AlertTriangle, Info, type LucideIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge.js";
import type { FlowApiError } from "../../api.js";
import { cn } from "../../lib/utils.js";

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

export function Section({
  title,
  description,
  configured,
  actions,
  children,
}: {
  title: string;
  description?: string;
  configured: boolean | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card shadow-card p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-[22px] font-semibold leading-[30px] tracking-[-0.015em] text-foreground">{title}</h2>
            {configured !== null && (
              <Badge variant={configured ? "success" : "warning"}>
                {configured ? "configured" : "not configured"}
              </Badge>
            )}
          </div>
          {description && (
            <p className="mt-1 max-w-prose text-[16px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const NOTICE_STYLES: Record<"warning" | "info", { box: string; icon: LucideIcon }> = {
  warning: { box: "border-warning bg-warning-soft", icon: AlertTriangle },
  info: { box: "border-border bg-sunken", icon: Info },
};

export function Notice({
  variant = "warning",
  children,
  className,
}: {
  variant?: "warning" | "info";
  children: React.ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = NOTICE_STYLES[variant];
  return (
    <div
      role={variant === "warning" ? "alert" : "note"}
      className={cn("flex items-start gap-2.5 rounded-md border px-4 py-3", box, className)}
    >
      <Icon size={14} className={cn("mt-0.5 shrink-0", variant === "warning" ? "text-warning" : "text-muted-foreground")} />
      <p className="text-[16px] leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

/**
 * Read-only label/value summary for a configured section. Labels sit above
 * values; the grid keeps columns aligned without a table.
 */
export function SummaryList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3", className)}>
      {children}
    </dl>
  );
}

export function SummaryItem({
  label,
  mono = false,
  span = false,
  children,
}: {
  label: string;
  mono?: boolean;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={span ? "col-span-full" : undefined}>
      <dt className="text-[15px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-[16px] text-foreground",
          mono && "font-mono text-[14px]",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="mt-4 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
      role="alert"
    >
      <p className="text-[16px] text-foreground">{message}</p>
    </div>
  );
}
