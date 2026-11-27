/**
 * Lazy entry for the HTML code editor. CodeMirror downloads in its own
 * chunk the first time an editor mounts; until then a plain textarea with
 * the same value stands in, so typing is never blocked.
 */
import { Suspense, forwardRef, lazy } from "react";
import { Textarea } from "../ui/textarea.js";
import type { CodeEditorHandle, HtmlCodeEditorProps } from "./html-code-editor.js";

export type { CodeEditorHandle } from "./html-code-editor.js";

const Editor = lazy(() => import("./html-code-editor.js"));

export const HtmlCodeEditor = forwardRef<CodeEditorHandle, HtmlCodeEditorProps>(function HtmlCodeEditorLazy(props, ref) {
  const fallback = (
    <Textarea
      id={props.id}
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={props.onFocus}
      placeholder={props.placeholder}
      style={{ minHeight: (props.minHeight ?? 260) + 18 }}
      className="font-mono text-small leading-relaxed"
    />
  );
  return (
    <Suspense fallback={fallback}>
      <Editor ref={ref} {...props} />
    </Suspense>
  );
});
