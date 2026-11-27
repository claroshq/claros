/**
 * Preview of a fixed-copy email with sample values in place of variables.
 * The body renders in a sandboxed iframe (no scripts, no same-origin), so
 * whatever HTML the person types cannot touch the dashboard.
 */
import { useMemo } from "react";
import { fillSample } from "../../lib/flow-editor-model.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface PreviewSample {
  values: Record<string, string>;
  /** How the sample contact is introduced above the preview. */
  label: string;
}

export function sampleValues(productName: string, flowName: string, links: Array<{ name: string; url: string }>): PreviewSample {
  const values: Record<string, string> = {
    "contact.first_name": "Ada",
    "contact.last_name": "Lovelace",
    "contact.email": "ada@example.com",
    "contact.external_id": "user_123",
    "tenant.name": productName || "Your product",
    "flow.name": flowName || "This flow",
  };
  for (const l of links) values[`links.${l.name}`] = l.url;
  return { values, label: "Sample contact: Ada Lovelace, ada@example.com" };
}

export function EmailPreview({
  subject,
  preheader,
  bodyHtml,
  sample,
  height = 340,
}: {
  subject: string;
  preheader?: string;
  bodyHtml: string;
  sample: PreviewSample;
  /** Height of the body frame in px. */
  height?: number;
}) {
  const escaped = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(sample.values)) out[k] = esc(v);
    return out;
  }, [sample]);
  const doc = useMemo(
    () =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:18px 20px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d2230;background:#fff;word-wrap:break-word}
p{margin:0 0 14px}a{color:#2f5fb3}img{max-width:100%}
</style></head><body>${bodyHtml.trim() === "" ? '<p style="color:#6b7180">The body appears here as you write it.</p>' : fillSample(bodyHtml, escaped)}</body></html>`,
    [bodyHtml, escaped],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-sunken px-3 py-2 text-[14px] text-muted-foreground">{sample.label}</div>
      <div className="border-b border-border bg-white px-4 py-3 text-[15px] text-[#4b5160]">
        <p className="truncate text-[17px] font-semibold text-[#1d2230]">
          {subject.trim() === "" ? <span className="font-normal text-[#6b7180]">No subject yet</span> : fillSample(subject, sample.values)}
        </p>
        {preheader && <p className="truncate">{fillSample(preheader, sample.values)}</p>}
      </div>
      <iframe title="Email preview" sandbox="" srcDoc={doc} style={{ height }} className="block w-full bg-white" />
      <p className="border-t border-border bg-sunken px-3 py-2 text-[14px] text-muted-foreground">
        Body only. Your brand layout, footer and unsubscribe link are added when it sends.
      </p>
    </div>
  );
}
