/**
 * Suppressions page.
 *
 * Lists all suppressed email addresses and allows CSV import. A suppressed
 * address is why an email did not arrive, so this screen lives next to the
 * sent-mail log rather than buried in settings.
 *
 * Import accepts:
 *   - Plain text: one email per line
 *   - CSV: first column is the email address; additional columns are ignored
 *   - A header row starting with "email" (case-insensitive) is auto-detected and skipped
 *   - Malformed rows (no @, empty local/domain, domain without a dot) are counted
 *     as invalid and reported in the result
 *   - Duplicate addresses (already suppressed) are counted as skipped
 *   - Maximum 10,000 rows per import call
 */
import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Upload, ShieldOff, Check, ArrowLeft, Plus } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";
import {
  useSuppressions,
  useImportSuppressions,
  useAddSuppression,
} from "../suppressions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reasonLabel(reason: string): string {
  switch (reason) {
    case "hard_bounce":
      return "Hard bounce";
    case "complaint":
      return "Complaint";
    case "unsubscribe":
      return "Unsubscribed";
    case "manual":
      return "Manual";
    case "imported":
      return "Imported";
    default:
      return reason;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SuppressionsPage() {
  const list = useSuppressions();
  const importMutation = useImportSuppressions();
  const addMutation = useAddSuppression();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [addNote, setAddNote] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    invalid: number;
    total_rows: number;
  } | null>(null);

  const allSuppressions = list.data?.pages.flatMap((p) => p.suppressions) ?? [];

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = address.trim();
    if (!email) return;
    setAddNote(null);
    setAddError(null);
    addMutation.mutate(email, {
      onSuccess: (result) => {
        setAddress("");
        setAddNote(
          result.added
            ? `${result.email} is now suppressed. It will never receive mail.`
            : `${result.email} was already suppressed.`,
        );
      },
      onError: (err) => setAddError(err.message),
    });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    importMutation.mutate(text, {
      onSuccess: (result) => {
        setImportResult(result);
      },
    });
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        to="/sent"
        className="mb-4 inline-flex items-center gap-1.5 text-[15px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back to Sent Mail
      </Link>

      <PageHeader
        eyebrow="Delivery"
        title="Suppressions"
        subtitle="Addresses that will never receive mail. Hard bounces, complaints, unsubscribes, and manual blocks."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={importMutation.isPending}
          >
            <Upload size={14} />
            {importMutation.isPending ? "Importing..." : "Import CSV"}
          </Button>
        }
      />

      {/* Manual add */}
      <form onSubmit={handleAdd} className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Add an address to suppress"
          className="w-full sm:max-w-xs"
          aria-label="Email address to suppress"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={addMutation.isPending || address.trim().length === 0}
        >
          <Plus size={14} />
          {addMutation.isPending ? "Adding..." : "Suppress address"}
        </Button>
      </form>

      {addNote && (
        <div
          className="mb-4 rounded-md border border-border bg-secondary px-4 py-3"
          role="status"
        >
          <p className="text-[15px] text-foreground">{addNote}</p>
        </div>
      )}
      {addError && (
        <div
          className="mb-4 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[16px] text-foreground">{addError}</p>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Import result banner */}
      {importResult && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-success bg-success-soft px-4 py-3" role="status">
          <Check size={16} className="mt-0.5 shrink-0 text-success" />
          <div>
            <p className="text-[15px] text-foreground">
              Import complete: {importResult.imported} added, {importResult.skipped} already
              suppressed, {importResult.invalid} invalid
              {importResult.total_rows > 0 && ` (${importResult.total_rows} total rows)`}.
            </p>
            <button
              onClick={() => setImportResult(null)}
              className="mt-1 text-[14px] text-muted-foreground underline underline-offset-4"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Import error */}
      {importMutation.isError && (
        <div
          className="mb-4 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[16px] text-foreground">
            Import failed: {importMutation.error.message}
          </p>
        </div>
      )}

      {/* Loading */}
      {list.isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-32" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {list.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[16px] text-foreground">
            Failed to load suppressions:{" "}
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {/* Empty state */}
      {list.isSuccess && allSuppressions.length === 0 && (
        <EmptyState
          icon={ShieldOff}
          title="No suppressed addresses"
          description="Hard bounces and complaints land here automatically. Add a single address above, or import a suppression list from a previous provider."
        />
      )}

      {/* Table */}
      {list.isSuccess && allSuppressions.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allSuppressions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-[14px]">
                    {s.email}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.reason === "hard_bounce" || s.reason === "complaint"
                          ? "danger"
                          : s.reason === "unsubscribe"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {reasonLabel(s.reason)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[14px] text-muted-foreground">
                    {s.source ?? "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-[14px] text-muted-foreground">
                    {formatDate(s.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Load more */}
          {list.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
