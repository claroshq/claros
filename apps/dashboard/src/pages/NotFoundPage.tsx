/**
 * Not found page.
 *
 * Rendered inside the shell for any unmatched child route, so the chrome
 * (sidebar, user footer) stays put and only the content region reports the
 * miss. The shell's own auth gate runs first: an unauthenticated visitor to
 * an unknown path is redirected to /login before this page can render.
 */
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="font-mono text-[14px] text-muted-foreground">404</p>
      <h1 className="mt-2 text-[22px] font-semibold tracking-[-0.015em] text-foreground">
        This page does not exist
      </h1>
      <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
        The route you opened matches nothing in this workspace. It may have
        moved, or the link may be wrong.
      </p>
      <Link
        to="/"
        className="mt-6 text-[16px] text-accent-text underline underline-offset-4"
      >
        Back to home
      </Link>
    </div>
  );
}
