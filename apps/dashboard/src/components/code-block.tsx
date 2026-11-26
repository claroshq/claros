/**
 * A code sample with a Copy button, and the clipboard hook behind it.
 * Used by the Integrate page and the knowledge base import page.
 */
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/button.js";

export function useCopy(): { copied: string | null; copy: (id: string, text: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  }
  return { copied, copy };
}

export function CodeBlock({ id, code }: { id: string; code: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-sunken p-4 font-mono text-[13px] leading-5 text-foreground">
        {code}
      </pre>
      <Button
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3"
        onClick={() => copy(id, code)}
      >
        {copied === id ? (
          <Check size={16} strokeWidth={1.5} />
        ) : (
          <Copy size={16} strokeWidth={1.5} />
        )}
        {copied === id ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
