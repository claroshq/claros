/**
 * First-run setup checklist.
 *
 * A fresh install has no LLM provider and no transport, so the product
 * cannot do anything yet. This panel tells the operator exactly that, in
 * the place they land (the flows list), with each missing piece linked to
 * where it is fixed. It also offers the business-model templates, because
 * an empty flows list plus a working install is still an empty product.
 *
 * Shape reasoning: a checklist on the landing page, not a wizard. A wizard
 * blocks the experienced user and punishes the operator who installs to
 * look around. This panel blocks nothing, dismisses permanently
 * (localStorage), and stays one click away via a quiet "Finish setup"
 * affordance in the flows header while anything is missing.
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Check, X } from "lucide-react";
import { useSetupState, useTemplates, useApplyTemplate } from "../settings.js";
import { useIngestStatus } from "../ingestion.js";
import type { FlowApiError } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Select } from "../components/ui/select.js";
import { cn } from "../lib/utils.js";

const DISMISS_KEY = "claros-setup-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function ChecklistItem({
  done,
  label,
  action,
}: {
  done: boolean;
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          done
            ? "border-success bg-success-soft text-success"
            : "border-border-strong",
        )}
      >
        {done && <Check size={11} strokeWidth={2.5} />}
      </span>
      <span
        className={cn(
          "text-[15px]",
          done ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {label}
      </span>
      {!done && action && <span className="ml-auto">{action}</span>}
    </li>
  );
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

export function useSetupChecklist(flowCount: number | null) {
  const setup = useSetupState();
  const [dismissed, setDismissed] = useState(readDismissed);

  // The panel matters while the install cannot do its job, or while it has
  // no flows at all. A configured install with flows sees nothing.
  const relevant =
    !setup.isLoading &&
    !setup.isError &&
    (!setup.complete || flowCount === 0);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // storage unavailable; dismissal lasts for this render only
    }
    setDismissed(true);
  }

  function reopen() {
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      // ignore
    }
    setDismissed(false);
  }

  return {
    setup,
    visible: relevant && !dismissed,
    showReopen: relevant && dismissed,
    dismiss,
    reopen,
  };
}

export function SetupChecklist({
  setup,
  flowCount,
  onDismiss,
}: {
  setup: ReturnType<typeof useSetupState>;
  flowCount: number | null;
  onDismiss: () => void;
}) {
  const templates = useTemplates();
  const apply = useApplyTemplate();
  const ingestStatus = useIngestStatus(false);
  const [templateId, setTemplateId] = useState("");
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const checks = [
    {
      key: "llm",
      done: setup.checks.llm,
      label: "Add an LLM provider so flows can compile and drafts can be written",
      to: "/settings/llm",
      linkLabel: "Settings",
    },
    {
      key: "transport",
      done: setup.checks.transport,
      label: "Add an email transport so approved messages can be delivered",
      to: "/settings/transport",
      linkLabel: "Settings",
    },
    {
      key: "postal",
      done: setup.checks.postalAddress,
      label: "Set a postal address, required by law on every outgoing email",
      to: "/settings/postal",
      linkLabel: "Settings",
    },
    {
      key: "events",
      done: ingestStatus.data?.last_event != null,
      label: "Send your first event so contacts and flows have something to act on",
      to: "/integrate",
      linkLabel: "Integrate",
    },
  ];

  const doneCount = checks.filter((c) => c.done).length;
  const totalCount = checks.length;
  const showTemplates = flowCount === 0;

  function handleApply() {
    if (!templateId) return;
    setTemplateNote(null);
    setTemplateError(null);
    apply.mutate(templateId, {
      onSuccess: (data) => {
        setTemplateNote(
          `Applied "${data.template_name}": ${data.flows_created.length} draft flows created. Review them in the list below.`,
        );
      },
      onError: (err) => {
        setTemplateError(errorMessage(err));
      },
    });
  }

  return (
    <div className="mb-8 rounded-lg border border-border bg-card shadow-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-medium text-foreground">
            Finish setting up
          </h2>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {doneCount === 0
              ? "This install cannot compile, send, or legally deliver email yet, and no events are arriving. Four things fix that."
              : doneCount < totalCount
                ? `${doneCount} of ${totalCount} done. The product works when all four are in place.`
                : "The install is ready. Start with a set of proven flows, or write your own."}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss setup checklist"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <ul className="mt-4">
        {checks.map((c) => (
          <ChecklistItem
            key={c.key}
            done={c.done}
            label={c.label}
            action={
              <Link
                to={c.to}
                className="text-[15px] text-accent-text underline underline-offset-4"
              >
                {c.linkLabel}
              </Link>
            }
          />
        ))}
      </ul>

      {showTemplates && (
        <div className="mt-5 border-t border-border pt-5">
          <p className="text-[15px] font-medium text-foreground">
            Start from a template
          </p>
          <p className="mt-1 text-[15px] text-muted-foreground">
            A business-model template installs a set of draft flows matched
            to how your SaaS charges. They are drafts: nothing sends until
            you compile and activate them.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <div className="w-72">
              <Select
                aria-label="Business model template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={apply.isPending || templates.isLoading}
              >
                <option value="">
                  {templates.isLoading ? "Loading templates..." : "Choose a template"}
                </option>
                {(templates.data?.templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.flow_count} flows)
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!templateId || apply.isPending}
              onClick={handleApply}
            >
              {apply.isPending ? "Applying..." : "Apply template"}
            </Button>
          </div>
          {templateId && (
            <p className="mt-2 text-[14px] text-muted-foreground">
              {(templates.data?.templates ?? []).find((t) => t.id === templateId)?.description}
            </p>
          )}
          {templateNote && (
            <p
              className="mt-3 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[15px] text-foreground"
              role="status"
            >
              {templateNote}
            </p>
          )}
          {templateError && (
            <div
              className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
              role="alert"
            >
              <p className="text-[15px] text-foreground">{templateError}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
