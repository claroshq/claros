/**
 * Revise with AI: the reviewer's conversation with the drafter about one
 * draft. Each instruction sends the draft back to the content worker, which
 * rewrites it to apply the feedback under the product's usual rules (named
 * links, knowledge base, text rules, language). The thread is stored on the
 * message, so it survives a reload and shows who asked for what.
 *
 * Enter sends, Shift+Enter starts a new line. The textarea grows with its
 * content up to a limit, then scrolls.
 */
import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Sparkles } from "lucide-react";
import type { Message } from "../api.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";

/** Same limit as the API (REVISION_MAX_CHARS). */
export const REVISION_MAX_CHARS = 2000;

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RevisePanel({
  message,
  drafting,
  disabled,
  submitting,
  onSubmit,
  inputRef,
}: {
  message: Message;
  /** The worker is writing the revised draft. */
  drafting: boolean;
  /** Another action on the message is running. */
  disabled: boolean;
  submitting: boolean;
  onSubmit: (instruction: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? ownRef;
  const threadEnd = useRef<HTMLLIElement | null>(null);
  const thread = message.revisions ?? [];
  const busy = drafting || submitting;
  const trimmed = text.trim();
  const tooLong = trimmed.length > REVISION_MAX_CHARS;
  const canSend = trimmed.length > 0 && !tooLong && !busy && !disabled;

  // A new message under review starts with an empty box.
  useEffect(() => setText(""), [message.id]);

  // Grow with the content, up to about eight lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, ref]);

  // Keep the latest turn in view.
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "nearest" });
  }, [thread.length, drafting]);

  function send() {
    if (!canSend) return;
    onSubmit(trimmed);
    setText("");
  }

  return (
    <section aria-label="Revise with AI" className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Sparkles className="size-4 text-accent-text" aria-hidden />
        <h3 className="text-body font-semibold text-foreground">Revise with AI</h3>
        <span className="truncate text-small text-muted-foreground">
          Say what should change. The AI rewrites this draft and it comes back here for review.
        </span>
      </header>

      {thread.length > 0 && (
        <ol className="max-h-72 space-y-3 overflow-y-auto px-4 py-3.5">
          {thread.map((turn, i) => {
            const last = i === thread.length - 1;
            const pending = last && drafting;
            return (
              <React.Fragment key={`${turn.at}-${i}`}>
                <li className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-secondary px-3.5 py-2">
                    <p className="whitespace-pre-wrap text-body leading-relaxed text-foreground">{turn.instruction}</p>
                    <p className="mt-1 text-right font-mono text-micro text-subtle-foreground">{timeAgo(turn.at)}</p>
                  </div>
                </li>
                <li
                  ref={last ? threadEnd : undefined}
                  className="flex items-center gap-2 text-small text-muted-foreground"
                  aria-live={last ? "polite" : undefined}
                >
                  {pending ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden />
                      Rewriting the draft...
                    </>
                  ) : (
                    <>
                      <Check className="size-4 text-success" aria-hidden />
                      Draft revised
                    </>
                  )}
                </li>
              </React.Fragment>
            );
          })}
        </ol>
      )}

      <form
        className={cn("px-3 pb-3", thread.length > 0 ? "border-t border-border pt-3" : "pt-3")}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div
          className={cn(
            "flex items-end gap-2 rounded-md border border-input bg-card py-1.5 pl-3 pr-1.5 transition-[border-color,box-shadow] duration-(--dur-fast)",
            "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background",
            busy && "bg-sunken",
          )}
        >
          <textarea
            ref={ref}
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") {
                e.currentTarget.blur();
              }
            }}
            disabled={busy || disabled}
            placeholder={
              busy
                ? "Wait for the revised draft..."
                : thread.length > 0
                  ? "Anything else to change?"
                  : "For example: there is no /mcp page, link to the docs instead, and keep it shorter."
            }
            aria-label="Instruction for the AI"
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-body leading-relaxed text-foreground placeholder:text-subtle-foreground focus:outline-none disabled:cursor-not-allowed"
          />
          <Button type="submit" size="sm" disabled={!canSend} aria-label="Send to the AI">
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
            Revise
          </Button>
        </div>
        <p className="mt-1.5 flex justify-between gap-3 px-0.5 text-caption text-subtle-foreground">
          <span>Enter sends, Shift+Enter adds a line. Links, facts and writing rules of the product still apply.</span>
          {trimmed.length > REVISION_MAX_CHARS * 0.8 && (
            <span className={cn("font-mono", tooLong && "text-danger")}>
              {trimmed.length}/{REVISION_MAX_CHARS}
            </span>
          )}
        </p>
      </form>
    </section>
  );
}
