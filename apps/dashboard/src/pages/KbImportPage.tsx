/**
 * Knowledge base import page (/kb/import).
 *
 * Three steps, each saying what happens next:
 *
 *   1. Choose: drop or pick files (Markdown, text, CSV, JSONL, JSON) or
 *      paste text. The page explains each format, offers example files,
 *      and shows how to import from your own system with the API or CLI.
 *   2. Check: the files are read in the browser (kb-import.ts), rows that
 *      cannot be imported are listed with the reason, and the rest go to
 *      POST /v1/kb/import?dry_run=1, which reports how many entries would
 *      be created, updated, left unchanged, or skipped because someone
 *      edited them in Claros (with the option to overwrite those).
 *   3. Import: the same request without dry_run, in batches; the result
 *      and what happens next (embeddings) are shown.
 *
 * The import never deletes and matches on external_key, so running it
 * again with the same files changes nothing; the page says so, because
 * that is what makes a failed batch safe to retry.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ClipboardPaste,
  Download,
  FileSpreadsheet,
  FileText,
  Upload,
} from "lucide-react";
import { importKb, type FlowApiError, type KbImportResponse } from "../api.js";
import { KB_QUERY_KEY } from "../kb.js";
import { useEmbeddings } from "../settings.js";
import {
  KB_IMPORT_ACCEPT,
  KB_IMPORT_EXAMPLES,
  KB_IMPORT_LIMITS,
  KB_IMPORT_MAX_FILE_BYTES,
  batchEntries,
  formatOf,
  parseImportFiles,
  parsePasted,
  type KbImportEntry,
  type KbImportParse,
  type KbImportRow,
} from "../kb-import.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { CodeBlock } from "../components/code-block.js";
import { cn } from "../lib/utils.js";

type Stage = "choose" | "check" | "done";

/** Counts summed over every batch, with server errors mapped back to rows. */
interface Totals {
  created: number;
  updated: number;
  unchanged: number;
  skipped_edited: number;
  skipped_keys: string[];
  /** Rows the server refused, with its reason. */
  serverErrors: Array<{ row: KbImportRow; error: string }>;
}

const EMPTY_TOTALS: Totals = { created: 0, updated: 0, unchanged: 0, skipped_edited: 0, skipped_keys: [], serverErrors: [] };

/** Rows shown in the check table before "and N more". */
const TABLE_ROWS = 200;

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") return apiErr.issues.map((i) => i.message).join("; ");
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

function n(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Send the entries in batches and sum the answers. */
async function runImport(
  rows: KbImportRow[],
  opts: { dryRun: boolean; force: boolean },
  onProgress: (done: number, total: number) => void,
): Promise<Totals> {
  const valid = rows.filter((r): r is KbImportRow & { entry: KbImportEntry } => r.entry !== null);
  const batches = batchEntries(valid.map((r) => r.entry));
  const totals: Totals = { ...EMPTY_TOTALS, skipped_keys: [], serverErrors: [] };
  let offset = 0;
  for (let b = 0; b < batches.length; b++) {
    onProgress(b, batches.length);
    let res: KbImportResponse;
    try {
      res = await importKb(batches[b]!, opts);
    } catch (err) {
      const where = batches.length > 1 ? `Batch ${b + 1} of ${batches.length} failed: ` : "";
      const done = b > 0 && !opts.dryRun
        ? ` The ${n(offset, "entry", "entries")} before it ${offset === 1 ? "was" : "were"} imported. Run the import again: entries already in Claros are left unchanged, so nothing is duplicated.`
        : "";
      throw new Error(`${where}${errorMessage(err)}${done}`);
    }
    totals.created += res.created;
    totals.updated += res.updated;
    totals.unchanged += res.unchanged;
    totals.skipped_edited += res.skipped_edited;
    totals.skipped_keys.push(...res.skipped_keys);
    for (const e of res.errors) {
      const row = valid[offset + e.index];
      if (row) totals.serverErrors.push({ row, error: e.error });
    }
    offset += batches[b]!.length;
  }
  onProgress(batches.length, batches.length);
  return totals;
}

function download(example: { name: string; type: string; text: string }) {
  const url = URL.createObjectURL(new Blob([example.text], { type: example.type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = example.name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Steps({ stage }: { stage: Stage }) {
  const steps: Array<[Stage, string]> = [["choose", "Choose files"], ["check", "Check"], ["done", "Import"]];
  const current = steps.findIndex(([s]) => s === stage);
  return (
    <ol className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]" aria-label="Import steps">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-3">
          <span
            className={cn(
              "flex items-center gap-2",
              i === current ? "font-medium text-foreground" : i < current ? "text-muted-foreground" : "text-subtle-foreground",
            )}
            aria-current={i === current ? "step" : undefined}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px]",
                i === current ? "bg-accent-soft text-accent-text" : "bg-sunken",
              )}
            >
              {i + 1}
            </span>
            {label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-6 bg-border" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function FormatCard({
  icon: Icon,
  title,
  children,
  example,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  example?: { name: string; type: string; text: string };
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <Icon size={16} strokeWidth={1.5} className="text-accent-text" />
        <p className="text-[14px] font-medium text-foreground">{title}</p>
      </div>
      <div className="mt-2 flex-1 space-y-2 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
      {example && (
        <Button variant="ghost" size="sm" className="mt-3 w-fit px-2" onClick={() => download(example)}>
          <Download size={14} strokeWidth={1.5} />
          Example file
        </Button>
      )}
    </div>
  );
}

function Stat({ value, label, hint, tone }: { value: number; label: string; hint: string; tone?: "warning" }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className={cn("font-display text-[24px] font-bold leading-none tabular-nums", tone === "warning" && value > 0 ? "text-warning" : "text-foreground")}>
        {value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 text-[14px] font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}

function ProblemList({ title, items }: { title: string; items: Array<{ source: string; message: string }> }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 8);
  return (
    <div className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
      <p className="flex items-center gap-2 text-[14px] font-medium text-foreground">
        <AlertTriangle size={16} strokeWidth={1.5} className="text-danger" />
        {title}
      </p>
      <ul className="mt-2 space-y-1 text-[13px] text-foreground">
        {shown.map((p, i) => (
          <li key={i}>
            <span className="font-mono text-[12px] text-muted-foreground">{p.source}</span>: {p.message}
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button type="button" className="mt-2 text-[13px] font-medium text-foreground underline underline-offset-2" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      )}
    </div>
  );
}

function AutomateSection() {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://claros.example.com";
  const curl = `curl -X POST "${origin}/v1/kb/import?dry_run=1" \\
  -H "Authorization: Bearer clr_ak_..." \\
  -H "Content-Type: application/x-ndjson" \\
  --data-binary @kb.jsonl`;
  const cli = `export CLAROS_URL=${origin}
export CLAROS_ADMIN_KEY=clr_ak_...
npx @claroshq/claros kb import kb.jsonl --dry-run
npx @claroshq/claros kb import kb.jsonl`;
  return (
    <section className="mt-12 border-t border-border pt-8">
      <h2 className="text-[16px] font-medium text-foreground">Keep it in sync from your own system</h2>
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
        If your help center, docs or product data live somewhere else, send them on a schedule instead of uploading by hand. The API takes the
        same entries as this page (JSONL or a JSON array, up to 1,000 per request) and follows the same rules: matched by{" "}
        <code className="font-mono text-[13px]">external_key</code>, entries edited in Claros are protected, nothing is deleted. It needs an
        admin key with the <code className="font-mono text-[13px]">kb</code> scope: a product owner creates one on{" "}
        <Link to="/integrate" className="font-medium text-foreground underline underline-offset-2">
          Integrate
        </Link>
        . Remove <code className="font-mono text-[13px]">dry_run=1</code> to write.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted-foreground">API</p>
          <CodeBlock id="kb-import-curl" code={curl} />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted-foreground">CLI (JSONL or JSON files)</p>
          <CodeBlock id="kb-import-cli" code={cli} />
        </div>
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">
        One entry at a time: <code className="font-mono text-[12px]">POST /v1/kb</code> with the same key. Reference:{" "}
        <a
          href="https://github.com/claroshq/claros/blob/main/docs/guide/KB.md#import"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Knowledge base guide
        </a>
        .
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KbImportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const embeddings = useEmbeddings();
  const fileInput = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("choose");
  const [parsed, setParsed] = useState<KbImportParse | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");

  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<Totals | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<Totals | null>(null);
  const previewRun = useRef(0);

  const rows = parsed?.rows ?? [];
  const ready = useMemo(() => rows.filter((r) => r.entry !== null), [rows]);
  const localProblems = useMemo(
    () => rows.filter((r) => r.entry === null).map((r) => ({ source: r.source, message: r.problems.join("; ") })),
    [rows],
  );

  function begin(result: KbImportParse, label: string) {
    setParsed(result);
    setSourceLabel(label);
    setForce(false);
    setPreview(null);
    setPreviewError(null);
    setImportError(null);
    setResult(null);
    setStage("check");
  }

  async function readFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    setReading(true);
    try {
      const texts: Array<{ name: string; text: string }> = [];
      const fileErrors: string[] = [];
      for (const f of files) {
        if (formatOf(f.name) === null) {
          fileErrors.push(`${f.name}: not a format the import reads (use .md, .txt, .csv, .jsonl or .json)`);
        } else if (f.size > KB_IMPORT_MAX_FILE_BYTES) {
          fileErrors.push(`${f.name}: larger than 10 MB; split it or use the CLI`);
        } else {
          texts.push({ name: f.name, text: await f.text() });
        }
      }
      const result = parseImportFiles(texts);
      result.fileErrors.unshift(...fileErrors);
      begin(result, files.length === 1 ? files[0]!.name : n(files.length, "file"));
    } finally {
      setReading(false);
    }
  }

  function readPasted() {
    const result = parsePasted(pasted);
    const what = { markdown: "Markdown", text: "text", csv: "CSV", jsonl: "JSONL", json: "JSON" }[result.format];
    begin(result, `pasted text, read as ${what}`);
  }

  // Step 2: ask the server what would change (dry run), again when force changes.
  const runPreview = useCallback(async () => {
    const run = ++previewRun.current;
    setPreview(null);
    setPreviewError(null);
    if (ready.length === 0) return;
    try {
      const totals = await runImport(rows, { dryRun: true, force }, (done, total) => {
        if (run === previewRun.current) setProgress(total > 1 ? { done, total } : null);
      });
      if (run === previewRun.current) setPreview(totals);
    } catch (err) {
      if (run === previewRun.current) setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      if (run === previewRun.current) setProgress(null);
    }
  }, [rows, ready.length, force]);

  useEffect(() => {
    if (stage === "check") void runPreview();
  }, [stage, runPreview]);

  async function doImport() {
    setImporting(true);
    setImportError(null);
    try {
      const totals = await runImport(rows, { dryRun: false, force }, (done, total) => setProgress(total > 1 ? { done, total } : null));
      setResult(totals);
      setStage("done");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
      setImporting(false);
      void qc.invalidateQueries({ queryKey: KB_QUERY_KEY });
    }
  }

  function startOver() {
    setParsed(null);
    setPasted("");
    setPasteOpen(false);
    setPreview(null);
    setResult(null);
    setStage("choose");
  }

  const skippedKeys = new Set(preview?.skipped_keys ?? []);
  const serverErrorByRow = new Map((preview?.serverErrors ?? []).map((e) => [e.row, e.error]));
  const willWrite = preview ? preview.created + preview.updated : 0;
  const noEmbeddingProvider = embeddings.data !== undefined && embeddings.data.embeddings === null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <Link to="/kb" className="text-[14px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
          &larr; Knowledge Base
        </Link>
        <h1 className="mt-2 font-display text-[28px] font-bold leading-[34px] tracking-[-0.02em] text-foreground">Import entries</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
          Bring in what you already have written: help articles, FAQ rows, product facts. Each entry has a key, so importing the same files again
          updates what changed and never duplicates or deletes anything. Nothing is written until you confirm.
        </p>
      </div>

      <Steps stage={stage} />

      {/* ------------------------------------------------------------ choose */}
      {stage === "choose" && (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void readFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center transition-colors duration-(--dur-fast)",
              dragging ? "border-accent bg-accent-soft" : "border-border-strong",
            )}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
              <Upload size={20} strokeWidth={1.5} />
            </span>
            <p className="mt-4 text-[16px] font-medium text-foreground">Drop files here</p>
            <p className="mt-1 text-[14px] text-muted-foreground">Markdown, text, CSV, JSONL or JSON. Several files at once are fine.</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" disabled={reading} onClick={() => fileInput.current?.click()}>
                <Upload size={16} strokeWidth={1.5} />
                {reading ? "Reading..." : "Choose files"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPasteOpen((v) => !v)}>
                <ClipboardPaste size={16} strokeWidth={1.5} />
                Paste text
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={KB_IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void readFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {pasteOpen && (
            <div className="mt-4">
              <label htmlFor="kb-paste" className="mb-1.5 block text-[14px] font-medium text-foreground">
                Paste text
              </label>
              <Textarea
                id="kb-paste"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                className="min-h-56 font-mono text-[13px]"
                placeholder={"# Refund policy\n\nRefunds within 30 days of payment, no questions asked.\n\nOr paste CSV rows with a title,content header, or JSONL."}
              />
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                Markdown becomes one entry (start with a <code className="font-mono">#</code> title line). CSV with a header row, JSONL and JSON
                arrays are read like files.
              </p>
              <Button className="mt-3" size="sm" disabled={pasted.trim() === ""} onClick={readPasted}>
                Read pasted text
              </Button>
            </div>
          )}

          <h2 className="mt-10 text-[16px] font-medium text-foreground">What to import</h2>
          <p className="mt-1 text-[14px] text-muted-foreground">
            Pick the format closest to where your material lives now. Every entry needs a title and its content (up to{" "}
            {KB_IMPORT_LIMITS.content.toLocaleString("en-US")} characters).
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <FormatCard icon={FileText} title="Markdown or text files" example={KB_IMPORT_EXAMPLES.markdown}>
              <p>Docs or help articles: one entry per file. The first <code className="font-mono">#</code> heading is the title, else the file name.</p>
              <p>
                Longer files are split at their <code className="font-mono">##</code> headings, one entry per section. Front matter sets{" "}
                <code className="font-mono">category</code>, <code className="font-mono">tags</code> and <code className="font-mono">pinned</code>.
              </p>
            </FormatCard>
            <FormatCard icon={FileSpreadsheet} title="CSV from a spreadsheet" example={KB_IMPORT_EXAMPLES.csv}>
              <p>
                A FAQ or fact sheet, one entry per row. The first row names the columns: <code className="font-mono">title</code> and{" "}
                <code className="font-mono">content</code>, optionally <code className="font-mono">external_key</code>,{" "}
                <code className="font-mono">category</code>, <code className="font-mono">tags</code>, <code className="font-mono">pinned</code>,{" "}
                <code className="font-mono">active</code>.
              </p>
              <p>Other columns are kept with the entry as reference data. Export from Excel, Google Sheets or Numbers as CSV.</p>
            </FormatCard>
            <FormatCard icon={Braces} title="JSONL or JSON" example={KB_IMPORT_EXAMPLES.jsonl}>
              <p>
                Generated by a script from your own system: one entry per line (JSONL) or an array. Same fields as the API, with{" "}
                <code className="font-mono">external_key</code> required.
              </p>
              <p>Use this when you will import again later: your keys stay stable however titles change.</p>
            </FormatCard>
          </div>

          <h2 className="mt-10 text-[16px] font-medium text-foreground">How importing again works</h2>
          <ul className="mt-2 max-w-3xl list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-muted-foreground">
            <li>
              Entries are matched by <code className="font-mono text-[13px]">external_key</code>. A Markdown file is keyed on its file name and a CSV
              row without that column on its title, so renaming the file or the title creates a new entry.
            </li>
            <li>An entry someone edited in Claros since its last import is left alone, unless you choose to overwrite it in the next step.</li>
            <li>Nothing is deleted: entries missing from the files stay. Delete or deactivate them in the Knowledge Base.</li>
            <li>Rows with a problem are listed with the reason and skipped; the rest are imported.</li>
          </ul>

          <AutomateSection />
        </>
      )}

      {/* ------------------------------------------------------------- check */}
      {stage === "check" && parsed && (
        <>
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-[15px] text-foreground">
              Read {n(rows.length, "entry", "entries")} from <span className="font-medium">{sourceLabel}</span>
              {localProblems.length > 0 && (
                <span className="text-muted-foreground">, {localProblems.length} with a problem</span>
              )}
              .
            </p>
            <Button variant="ghost" size="sm" onClick={startOver} disabled={importing}>
              Choose other files
            </Button>
          </div>

          {parsed.fileErrors.length > 0 && (
            <ProblemList
              title={parsed.fileErrors.length === 1 ? "A file could not be read" : `${parsed.fileErrors.length} files could not be read`}
              items={parsed.fileErrors.map((e) => {
                const i = e.indexOf(": ");
                return i > 0 ? { source: e.slice(0, i), message: e.slice(i + 2) } : { source: "file", message: e };
              })}
            />
          )}
          <ProblemList
            title={`${n(localProblems.length, "entry", "entries")} will be skipped. Fix ${localProblems.length === 1 ? "it" : "them"} in the file and choose it again, or import the rest now.`}
            items={localProblems}
          />

          {ready.length === 0 ? (
            <p className="rounded-md border border-border bg-secondary px-4 py-3 text-[14px] text-foreground">
              Nothing to import yet. Fix the problems above, or{" "}
              <button type="button" className="font-medium underline underline-offset-2" onClick={startOver}>
                choose other files
              </button>
              .
            </p>
          ) : (
            <>
              <h2 className="mb-3 text-[16px] font-medium text-foreground">What the import will do</h2>
              {previewError && (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
                  <p className="text-[14px] text-foreground">Could not check against the knowledge base: {previewError}</p>
                  <Button variant="outline" size="sm" onClick={() => void runPreview()}>
                    Try again
                  </Button>
                </div>
              )}
              {!preview && !previewError && (
                <p className="mb-4 text-[14px] text-muted-foreground" role="status">
                  Checking {n(ready.length, "entry", "entries")} against the knowledge base
                  {progress ? ` (batch ${progress.done + 1} of ${progress.total})` : ""}... Nothing is written yet.
                </p>
              )}
              {preview && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Stat value={preview.created} label="New" hint="Keys not in the knowledge base yet" />
                    <Stat value={preview.updated} label="Updated" hint="Same key, the file has changed text or fields" />
                    <Stat value={preview.unchanged} label="Unchanged" hint="Already the same; not written" />
                    <Stat
                      value={preview.skipped_edited}
                      label="Edited in Claros"
                      hint={force ? "Will be overwritten with the file" : "Kept as edited; the file's version is skipped"}
                      tone="warning"
                    />
                  </div>
                  {(preview.skipped_edited > 0 || force) && (
                    <label className="mt-4 flex w-fit cursor-pointer items-start gap-2 text-[14px] text-foreground">
                      <input
                        type="checkbox"
                        checked={force}
                        onChange={(e) => setForce(e.target.checked)}
                        className="mt-1 h-3.5 w-3.5 accent-[var(--accent)]"
                        disabled={importing}
                      />
                      <span>
                        Overwrite entries edited in Claros with the file's version
                        <span className="block text-[13px] text-muted-foreground">
                          Changes made in the dashboard since the last import of these entries are lost.
                        </span>
                      </span>
                    </label>
                  )}
                  {preview.serverErrors.length > 0 && (
                    <div className="mt-4">
                      <ProblemList
                        title={`The server refused ${n(preview.serverErrors.length, "entry", "entries")}; ${preview.serverErrors.length === 1 ? "it is" : "they are"} skipped`}
                        items={preview.serverErrors.map((e) => ({ source: e.row.source, message: e.error }))}
                      />
                    </div>
                  )}
                </>
              )}

              {importError && (
                <div className="mt-6 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
                  <p className="text-[14px] text-foreground">{importError}</p>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
                <Button disabled={!preview || importing || willWrite === 0} onClick={() => void doImport()}>
                  {importing
                    ? progress
                      ? `Importing batch ${progress.done + 1} of ${progress.total}...`
                      : "Importing..."
                    : preview && willWrite === 0
                      ? "Nothing to change"
                      : `Import ${n(willWrite, "entry", "entries")}`}
                </Button>
                <Button variant="ghost" disabled={importing} onClick={() => navigate("/kb")}>
                  Cancel
                </Button>
                {preview && willWrite === 0 && (
                  <p className="text-[14px] text-muted-foreground">Everything that can be imported is already in the knowledge base.</p>
                )}
              </div>

              <h2 className="mb-2 mt-10 text-[16px] font-medium text-foreground">Entries in the files</h2>
              <div className="overflow-x-auto border-t border-b border-border">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 font-medium">Title</th>
                      <th className="px-2 py-2 font-medium">Key</th>
                      <th className="px-2 py-2 font-medium">Category</th>
                      <th className="px-2 py-2 text-right font-medium">Characters</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.slice(0, TABLE_ROWS).map((r, i) => {
                      const serverError = serverErrorByRow.get(r);
                      const status = r.entry === null || serverError
                        ? <Badge variant="danger">skipped</Badge>
                        : skippedKeys.has(r.external_key)
                          ? <Badge variant="warning">edited in Claros</Badge>
                          : <Badge variant="success">ready</Badge>;
                      return (
                        <tr key={i} title={r.source}>
                          <td className="px-2 py-2">{status}</td>
                          <td className="max-w-72 px-2 py-2 text-foreground">
                            <span className="line-clamp-1">{r.title || <span className="text-muted-foreground">(no title)</span>}</span>
                            {(r.entry?.pinned || r.entry?.active === false || r.entry?.is_active === false) && (
                              <span className="mt-0.5 flex gap-1.5">
                                {r.entry?.pinned && <Badge variant="neutral">pinned</Badge>}
                                {(r.entry?.active === false || r.entry?.is_active === false) && <Badge variant="muted">inactive</Badge>}
                              </span>
                            )}
                          </td>
                          <td className="max-w-64 truncate px-2 py-2 font-mono text-[12px] text-muted-foreground">{r.external_key}</td>
                          <td className="px-2 py-2 font-mono text-[12px] text-muted-foreground">{r.entry?.category ?? ""}</td>
                          <td className="px-2 py-2 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                            {r.entry ? r.entry.content.length.toLocaleString("en-US") : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length > TABLE_ROWS && (
                <p className="mt-2 text-[13px] text-muted-foreground">and {n(rows.length - TABLE_ROWS, "more entry", "more entries")}</p>
              )}
            </>
          )}
        </>
      )}

      {/* -------------------------------------------------------------- done */}
      {stage === "done" && result && (
        <>
          <div className="rounded-lg border border-border p-6">
            <p className="flex items-center gap-2 text-[16px] font-medium text-foreground">
              <CheckCircle2 size={20} strokeWidth={1.5} className="text-success" />
              Import finished
            </p>
            <p className="mt-2 text-[14px] text-foreground">
              {n(result.created, "entry", "entries")} created, {result.updated.toLocaleString("en-US")} updated,{" "}
              {result.unchanged.toLocaleString("en-US")} unchanged
              {result.skipped_edited > 0 && <>, {result.skipped_edited.toLocaleString("en-US")} kept as edited in Claros</>}
              {localProblems.length + result.serverErrors.length > 0 && (
                <>, {(localProblems.length + result.serverErrors.length).toLocaleString("en-US")} skipped because of a problem</>
              )}
              .
            </p>
            <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
              {noEmbeddingProvider ? (
                <>
                  Drafts can use the new entries right away. Without an embedding provider they are found by shared words; pinned entries and
                  kb_select work either way. To search by meaning, add a provider in{" "}
                  <Link to="/settings/llm" className="font-medium text-foreground underline underline-offset-2">
                    Settings, AI providers
                  </Link>
                  .
                </>
              ) : (
                <>
                  New and changed entries are being embedded for search; their badges in the list switch to "embedded" as the jobs finish. Drafts
                  can use them right away through pinning and kb_select.
                </>
              )}
            </p>
            {result.serverErrors.length > 0 && (
              <div className="mt-4">
                <ProblemList
                  title={`The server refused ${n(result.serverErrors.length, "entry", "entries")}`}
                  items={result.serverErrors.map((e) => ({ source: e.row.source, message: e.error }))}
                />
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-3">
              <Button onClick={() => navigate("/kb")}>View knowledge base</Button>
              <Button variant="outline" onClick={startOver}>
                Import more
              </Button>
            </div>
          </div>
          <AutomateSection />
        </>
      )}
    </div>
  );
}
