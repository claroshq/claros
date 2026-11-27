/**
 * Flows list page.
 *
 * The page header (title, count, primary action) renders in every state:
 * a list screen must always offer its verb, even while loading, empty, or
 * failed.
 *
 * Columns:
 *   name         - primary identifier, links to the editor
 *   status       - operational state (dot badge), acted on via row actions
 *   compile_status - whether the plan is ready (dot badge, pulse while pending)
 *   trigger_type - how contacts enter the flow (mono)
 *   approval_mode - whether drafts need manual approval
 *   created_at   - temporal orientation (mono)
 *   (actions)    - pause/resume/activate; archive lives in the editor,
 *                  destructive actions are not one click from a list
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Pause, Play, Plus, Workflow } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFlows, FLOWS_QUERY_KEY } from "../flows.js";
import { updateFlow, type Flow, type FlowApiError } from "../api.js";
import { SetupChecklist, useSetupChecklist } from "../components/setup-checklist.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";

// ---------------------------------------------------------------------------
// Badge tone mappings
// ---------------------------------------------------------------------------

/** Flow source -> content badge label and variant. */
function contentInfo(flow: Flow): { label: string; variant: BadgeVariant } {
  if (flow.source === "library") {
    return { label: "Fixed copy", variant: "muted" };
  }
  if (flow.content_mode === "fixed_content") {
    return { label: "Person-written", variant: "muted" };
  }
  return { label: "AI-drafted", variant: "neutral" };
}

/** Flow status -> badge tone. */
function statusVariant(status: Flow["status"]): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "draft": return "neutral";
    case "paused": return "warning";
    case "archived": return "muted";
  }
}

/** compile_status -> badge tone. */
function compileVariant(cs: Flow["compile_status"]): BadgeVariant {
  switch (cs) {
    case null: return "muted";
    case "pending": return "warning";
    case "ready": return "success";
    case "failed": return "danger";
  }
}

// ---------------------------------------------------------------------------
// Page header (always rendered, every state)
// ---------------------------------------------------------------------------

function FlowsHeader({ count }: { count: number | null }) {
  return (
    <PageHeader
      eyebrow="Automation"
      title="Flows"
      subtitle={
        count === null || count === 0
          ? "AI-drafted email sequences, compiled from plain language."
          : `${count} ${count === 1 ? "flow" : "flows"}`
      }
      actions={
        <Link to="/flows/new">
          <Button size="sm">
            <Plus size={16} strokeWidth={1.5} />
            New flow
          </Button>
        </Link>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div>
      <div className="border-b border-border pb-3">
        <Skeleton className="h-3 w-full max-w-xl" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-6 py-4">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowsEmptyState() {
  return (
    <EmptyState
      icon={Workflow}
      title="No flows yet"
      description="Flows define the automated email sequences your contacts receive based on lifecycle transitions and events. Create your first flow to start engaging your users."
      action={
        <Link to="/flows/new">
          <Button size="sm">
            <Plus size={16} strokeWidth={1.5} />
            New flow
          </Button>
        </Link>
      }
    />
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
      role="alert"
    >
      <p className="text-[17px] text-foreground">
        Failed to load flows: {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function actionErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

/** The action a row offers, or null. Archive is intentionally absent. */
function rowAction(flow: Flow): { label: string; status: "active" | "paused" } | null {
  if (flow.status === "active") return { label: "Pause", status: "paused" };
  if (flow.status === "paused") {
    return flow.compile_status === "ready" && flow.compiled_plan !== null
      ? { label: "Resume", status: "active" }
      : null;
  }
  if (flow.status === "draft") {
    return flow.compile_status === "ready" && flow.compiled_plan !== null
      ? { label: "Activate", status: "active" }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FlowsPage() {
  const { data, isLoading, isError, error, refetch } = useFlows();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "paused" }) =>
      updateFlow(id, { status }),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
    },
    onError: (err) => {
      setActionError(actionErrorMessage(err));
    },
  });

  const flows = data?.flows ?? [];
  const count = isLoading || isError ? null : flows.length;
  const checklist = useSetupChecklist(count);

  return (
    <div className="mx-auto max-w-[90rem]">
      <FlowsHeader count={count} />

      {checklist.visible && (
        <SetupChecklist
          setup={checklist.setup}
          flowCount={count}
          onDismiss={checklist.dismiss}
        />
      )}
      {checklist.showReopen && (
        <div className="mb-6 -mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={checklist.reopen}>
            Finish setup
          </Button>
        </div>
      )}

      {actionError && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">{actionError}</p>
        </div>
      )}

      {isLoading && <LoadingSkeleton />}

      {isError && (
        <ErrorState
          message={error instanceof Error ? error.message : "Unknown error"}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && flows.length === 0 && <FlowsEmptyState />}

      {!isLoading && !isError && flows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Compiled</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Approval</TableHead>
              <TableHead className="hidden text-right 2xl:table-cell">Created</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flows.map((flow) => {
              const action = rowAction(flow);
              return (
                <TableRow
                  key={flow.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/flows/${flow.id}/edit`)}
                >
                  <TableCell className="min-w-[15rem] font-semibold text-foreground">
                    <Link
                      to={`/flows/${flow.id}/edit`}
                      className="text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {flow.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={contentInfo(flow).variant}>
                      {contentInfo(flow).label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(flow.status)}>
                      {flow.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={compileVariant(flow.compile_status)}
                      pulse={flow.compile_status === "pending"}
                    >
                      {flow.compile_status ?? "not compiled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[14px] text-muted-foreground">
                    {flow.trigger_type}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {flow.approval_mode}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right font-mono text-[14px] text-muted-foreground 2xl:table-cell">
                    {formatDate(flow.created_at)}
                  </TableCell>
                  <TableCell
                    className="w-px whitespace-nowrap text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {action && (
                      <Button
                        variant={action.status === "paused" ? "ghost" : "outline"}
                        size="sm"
                        disabled={statusMutation.isPending}
                        onClick={() =>
                          statusMutation.mutate({ id: flow.id, status: action.status })
                        }
                      >
                        {action.status === "paused" ? (
                          <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
                        ) : (
                          <Play size={16} strokeWidth={1.5} aria-hidden="true" />
                        )}
                        {action.label}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
