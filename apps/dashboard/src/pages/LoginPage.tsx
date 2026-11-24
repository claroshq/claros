/**
 * Login page.
 *
 * Split layout: a brand panel on the left, the form on the right. The panel
 * carries the only large-scale typography on this screen; the form side is
 * deliberately quiet.
 *
 * States:
 *   - idle: email form
 *   - submitting: pending label in button
 *   - sent: "check your inbox" message
 *   - error: banner above the form (from ?error=invalid_link or submit failure)
 */
import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useLogin } from "../auth.js";
import { BrandLockup } from "../components/brand-lockup.js";
import { ThemeToggle } from "../components/theme-toggle.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

function BrandPanel() {
  return (
    <div className="relative hidden w-[44%] flex-col justify-between border-r border-border bg-sunken p-12 lg:flex">
      <BrandLockup markSize={26} />
      <div>
        {/* Flow motif: a contact enters, the plan compiles. Decorative. */}
        <svg
          width="150"
          height="24"
          viewBox="0 0 150 24"
          fill="none"
          aria-hidden="true"
          className="mb-8"
        >
          <circle cx="4" cy="12" r="3" className="fill-accent" />
          <path d="M16 12 H128" className="stroke-border-strong" strokeWidth="1.5" strokeDasharray="1 6" strokeLinecap="round" />
          <circle cx="139" cy="12" r="6" className="stroke-accent" strokeWidth="2" />
        </svg>
        <p className="font-display text-[40px] font-bold leading-[46px] tracking-[-0.02em] text-foreground">
          Lifecycle email,
          <br />
          compiled.
        </p>
        <p className="mt-4 max-w-[320px] text-[15px] leading-relaxed text-muted-foreground">
          Describe the flow in plain language. Claros compiles it into a
          deterministic plan, drafts the emails, and waits for your approval.
        </p>
      </div>
      <p className="text-[13px] text-subtle-foreground">
        Open-source lifecycle email for SaaS.
      </p>
    </div>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const login = useLogin();

  // Session-expiry notice: apiFetch sets this flag when a 401 forces the
  // redirect. Read once and clear so later visits do not show it.
  const [sessionExpired] = useState(() => {
    try {
      const flag = sessionStorage.getItem("claros-session-expired");
      if (flag) sessionStorage.removeItem("claros-session-expired");
      return flag === "1";
    } catch {
      return false;
    }
  });

  // ?error=invalid_link is set by the server when /auth/verify fails.
  const urlError = searchParams.get("error") === "invalid_link"
    ? "That login link was invalid or has expired. Please request a new one."
    : null;

  const errorMessage = localError ?? urlError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    try {
      await login.mutateAsync(email.trim());
      setSent(true);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    }
  }

  return (
    <div className="flex h-full min-h-screen overflow-y-auto overscroll-contain bg-background">
      <BrandPanel />

      <div className="relative flex flex-1 items-center justify-center p-6">
        <ThemeToggle className="absolute right-6 top-6" />

        <div className="w-full max-w-[360px]">
          {/* Compact lockup for narrow viewports where the panel is hidden. */}
          <div className="mb-10 lg:hidden">
            <BrandLockup markSize={24} />
          </div>

          {sent ? (
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.015em] text-foreground">
                Check your inbox
              </h1>
              <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                A login link has been sent to{" "}
                <strong className="font-medium text-foreground">{email}</strong>.
                Click it to sign in. The link expires in 10 minutes.
              </p>
              <p className="mt-6 text-[15px] text-muted-foreground">
                No email? Check your spam folder, or{" "}
                <button
                  className="cursor-pointer border-none bg-transparent p-0 text-[15px] text-accent-text underline underline-offset-4"
                  onClick={() => { setSent(false); setLocalError(null); }}
                >
                  try again
                </button>
                .
              </p>
            </div>
          ) : (
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.015em] text-foreground">
                Sign in
              </h1>
              <p className="mt-2 text-[15px] text-muted-foreground">
                Enter your email to receive a login link.
              </p>

              {sessionExpired && !errorMessage && (
                <p
                  className="mt-6 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[15px] text-foreground"
                  role="status"
                >
                  Your session has expired. Sign in again to continue.
                </p>
              )}

              {errorMessage && (
                <p
                  className="mt-6 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[15px] text-foreground"
                  role="alert"
                >
                  {errorMessage}
                </p>
              )}

              <form onSubmit={handleSubmit} noValidate className="mt-8">
                <label
                  className="mb-1.5 block text-[14px] font-medium text-foreground"
                  htmlFor="email"
                >
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={login.isPending}
                  placeholder="you@example.com"
                />
                <Button
                  type="submit"
                  className="mt-4 w-full"
                  disabled={login.isPending || email.trim().length === 0}
                >
                  {login.isPending ? "Sending..." : "Send login link"}
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
