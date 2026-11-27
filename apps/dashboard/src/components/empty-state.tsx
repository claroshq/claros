/**
 * Empty state.
 *
 * The one sanctioned empty-state pattern (docs/BRAND.md section 5): a
 * regular card (bg-card, 1px border, shadow-card), left-aligned like every
 * other screen. An icon in an accent-soft tile gives the state a face, then
 * a medium title, one or two lines of muted copy and an optional action, all
 * on the same left edge as the page header above it. List pages render this
 * instead of ad-hoc text so every empty screen reads as the same voice.
 */
import React from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
  /** Tighter padding for inline (non-page) empties. */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-4 rounded-lg border border-border bg-card shadow-card ${
        compact ? "p-5" : "p-6"
      }`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
        <Icon size={20} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-title font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-2xl text-body leading-relaxed text-muted-foreground">
          {description}
        </p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
