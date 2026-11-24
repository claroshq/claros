/**
 * PageHeader component.
 *
 * The one-focal-point pattern (docs/BRAND.md sections 4 and 12): an
 * optional eyebrow micro label, the single Bricolage page title, an
 * optional one-line muted subtitle, and the page's primary action top
 * right. Every page renders this block in every state (loading, empty,
 * error, populated) so the verb never disappears.
 */
import React from "react";

interface PageHeaderProps {
  /** Micro label above the title, in accent-text. Optional. */
  eyebrow?: string;
  title: string;
  /** One muted line below the title. Optional. */
  subtitle?: string;
  /** The primary action (and at most one quiet secondary). Optional. */
  actions?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-text">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 font-display text-[24px] leading-[30px] font-bold tracking-[-0.02em] text-foreground sm:text-[28px] sm:leading-[34px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 text-[14px] leading-[22px] text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
