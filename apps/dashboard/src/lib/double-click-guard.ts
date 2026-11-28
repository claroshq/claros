/**
 * Double-click protection for every button in the dashboard.
 *
 * A double click delivers two click events; the second carries
 * `event.detail === 2` (3 for a triple click, and so on). Most buttons act
 * on what is on screen, and the first click can change that before the
 * second lands: Approve moves the review to the next draft, so the second
 * click would approve that one too. A save or create can also fire twice
 * before React re-renders the button as disabled.
 *
 * One capture-phase listener on the document drops those follow-up clicks
 * before React sees them, for `<button>` elements and `role="button"`.
 * Keyboard activation (Enter, Space) reports `detail === 0` and is never
 * dropped. A button where quick repeated clicks are the point (previous,
 * next, move earlier, move later) opts out with `data-repeatable`.
 *
 * Buttons that start a request still show it themselves: they are disabled
 * while it runs (mutation `isPending` or a local busy flag). This guard
 * covers the gap before that re-render and the actions that are instant.
 */

/** The parts of a click event the guard reads. */
export interface ClickLike {
  detail: number;
  target: EventTarget | null;
}

/** The parts of an element the guard reads. */
interface ElementLike {
  closest(selector: string): ElementLike | null;
  hasAttribute(name: string): boolean;
}

const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';

/** True when this click is the second (or later) click of a multi-click on a guarded button. */
export function isRepeatClick(event: ClickLike): boolean {
  if (event.detail < 2) return false;
  const target = event.target as unknown as Partial<ElementLike> | null;
  if (!target || typeof target.closest !== "function") return false;
  const button = target.closest(BUTTON_SELECTOR);
  if (!button) return false;
  return !button.hasAttribute("data-repeatable");
}

/** Installs the guard once on the document. Returns a function that removes it. */
export function installDoubleClickGuard(doc: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (!isRepeatClick(event)) return;
    // preventDefault also stops a submit button from submitting its form again.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  doc.addEventListener("click", onClick, { capture: true });
  return () => doc.removeEventListener("click", onClick, { capture: true });
}
