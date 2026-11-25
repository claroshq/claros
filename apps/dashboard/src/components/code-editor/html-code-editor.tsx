/**
 * HTML code editor for email bodies, built on CodeMirror 6 (MIT).
 *
 * Loaded lazily (see ./index.tsx) so the editor's code only downloads on
 * pages that show it. HTML syntax highlighting, line wrapping, undo
 * history, and a highlight on {{variable|fallback}} tokens. Colors come
 * from the dashboard's CSS variables, so light and dark themes both work.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  keymap,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LRLanguage, LanguageSupport, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { parser as htmlParser } from "@lezer/html";
import { tags as t } from "@lezer/highlight";

export interface CodeEditorHandle {
  /** Replace the selection with `text` and put the cursor after it. */
  insert(text: string): void;
  focus(): void;
}

export interface HtmlCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  /** Minimum editor height in px. */
  minHeight?: number;
}

const variableMark = Decoration.mark({ class: "cm-claros-var" });
const variableMatcher = new MatchDecorator({ regexp: /\{\{[^{}\n]*\}\}/g, decoration: () => variableMark });
const variables = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = variableMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = variableMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// HTML only: email bodies carry no scripts, and inline styles read fine as
// attribute values. Skipping the nested CSS and JS parsers keeps the chunk small.
const html = new LanguageSupport(LRLanguage.define({ name: "html", parser: htmlParser }));

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: "var(--accent-text)" },
  { tag: t.attributeName, color: "var(--fg-muted)" },
  { tag: [t.attributeValue, t.string], color: "oklch(0.55 0.12 150)" },
  { tag: t.comment, color: "var(--fg-subtle)", fontStyle: "italic" },
  { tag: [t.propertyName, t.keyword], color: "var(--accent-text)" },
  { tag: [t.number, t.unit], color: "oklch(0.6 0.13 60)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": {
    fontSize: "13px",
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
  },
  "&.cm-focused": { outline: "none", boxShadow: "0 0 0 2px var(--ring)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft) !important",
  },
  ".cm-placeholder": { color: "var(--fg-subtle)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-claros-var": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--accent-text)",
    borderRadius: "3px",
  },
  "&.cm-claros-disabled": { backgroundColor: "var(--bg-sunken)", color: "var(--fg-muted)", borderColor: "var(--border)" },
});

const HtmlCodeEditor = forwardRef<CodeEditorHandle, HtmlCodeEditorProps>(function HtmlCodeEditor(
  { value, onChange, onFocus, disabled, placeholder, id, ariaLabel, minHeight = 260 },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  // Latest callbacks without rebuilding the editor on every render.
  const cb = useRef({ onChange, onFocus });
  cb.current = { onChange, onFocus };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          html,
          syntaxHighlighting(highlight),
          bracketMatching(),
          EditorView.lineWrapping,
          variables,
          theme,
          EditorView.theme({ ".cm-content, .cm-gutter": { minHeight: `${minHeight}px` } }),
          cmPlaceholder(placeholder ?? ""),
          editable.current.of(editableExt(!disabled)),
          EditorView.contentAttributes.of({ ...(id ? { id } : {}), ...(ariaLabel ? { "aria-label": ariaLabel } : {}), "aria-multiline": "true" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.focusChanged && u.view.hasFocus) cb.current.onFocus?.();
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is built once; value and disabled sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside changes (AI draft, insert buttons, step switch) replace the doc.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(editableExt(!disabled)) });
  }, [disabled]);

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      v.focus();
    },
    focus() {
      view.current?.focus();
    },
  }));

  return <div ref={host} />;
});

function editableExt(on: boolean) {
  return [EditorView.editable.of(on), EditorState.readOnly.of(!on), EditorView.editorAttributes.of({ class: on ? "" : "cm-claros-disabled" })];
}

export default HtmlCodeEditor;
