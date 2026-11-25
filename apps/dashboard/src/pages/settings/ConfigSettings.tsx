/**
 * Settings / Config as code.
 *
 * Downloads the product's configuration (GET /v1/config) as
 * claros.config.json: settings, topics, templates, routing, flows and
 * webhooks, without secrets. Apply an edited file with `claros apply`.
 */
import { useState } from "react";
import { fetchConfigDocument, downloadJson } from "../../webhooks.js";
import { selectedProductSlug } from "../../product.js";
import { Button } from "../../components/ui/button.js";
import { Section, FormError, errorMessage } from "./shared.js";

export default function ConfigSettings() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const product = selectedProductSlug();

  async function download() {
    setErr(null);
    setBusy(true);
    try {
      const doc = await fetchConfigDocument();
      downloadJson("claros.config.json", {
        $schema: "https://github.com/claroshq/claros/blob/main/docs/reference/claros.config.schema.json",
        ...doc,
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Config as code"
      description="Keep this product's flows, templates, topics, routing, settings and webhooks in one JSON file in your repository and apply it with one command."
      configured={null}
    >
      <div className="space-y-4">
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          The export holds the current configuration{product ? ` of ${product}` : ""} without secrets (webhook, analytics
          and data source secrets stay on the server). Edit it, then preview and apply it:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-sunken p-4 font-mono text-[13px] text-foreground">
{`npx @claroshq/claros apply -f claros.config.json --dry-run
npx @claroshq/claros apply -f claros.config.json`}
        </pre>
        <FormError message={err} />
        <Button type="button" onClick={() => void download()} disabled={busy}>
          {busy ? "Exporting..." : "Download claros.config.json"}
        </Button>
      </div>
    </Section>
  );
}
