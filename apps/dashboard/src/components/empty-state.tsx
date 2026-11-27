/**
 * Empty state.
 *
 * The one sanctioned empty-state pattern (docs/BRAND.md section 5): a
 * dashed border-strong frame saying "content will live here", an icon in
 * an accent-soft container so the state has a face, a 16px medium title,
 * one or two lines of muted copy, and an optional primary action. List
 * pages render this instead of ad-hoc centered text so every empty screen
 * in the product reads as the same voice.
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
  /** Tighter vertical rhythm for inline (non-page) empties. */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong text-center ${
        compact ? "px-6 py-12" : "px-6 py-24"
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
        <Icon size={20} strokeWidth={1.5} />
      </span>
      <p className="mt-4 text-[18px] font-medium text-foreground">{title}</p>
      <p className="mt-2 max-w-md text-[16px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
