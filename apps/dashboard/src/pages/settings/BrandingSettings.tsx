/**
 * Settings / Email branding + test send.
 *
 * Every outgoing email is wrapped in a branded shell. All fields are
 * optional - a fresh install produces clean emails with sensible
 * defaults. The test-send form lives here because what it exercises is
 * exactly this configuration (plus transport and postal address).
 */
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useSetupState,
  usePatchTenant,
  useSendTestEmail,
  useBrandLogo,
  useBrandLogoMutations,
  useBrandLogoDark,
  useBrandLogoDarkMutations,
} from "../../settings.js";
import type { BrandLogo, BrandSettingsData } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, errorMessage } from "./shared.js";
import { decodeLogo, prepareLogo, type DecodedLogo, type PreparedLogo } from "../../lib/logo-image.js";
import { lowContrastShare } from "../../lib/logo-background.js";

/** Same limits as the upload route (packages/core/src/brand-logo.ts). */
const LOGO_TYPES = ["image/png", "image/jpeg"];
const LOGO_MAX_BYTES = 256 * 1024;
/** Body color of the built-in layouts in dark mode (packages/core/src/email-shell.ts). */
const DARK_PREVIEW_BG = "#1a1a1a";
/** Share of low-contrast pixels on the dark body above which the review panel says so. */
const LOW_CONTRAST_NOTE_SHARE = 0.2;

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

export default function BrandingSettings() {
  const { tenant, isLoading } = useSetupState();
  const logoQuery = useBrandLogo();
  const logoMutations = useBrandLogoMutations();
  const uploaded: BrandLogo | null = logoQuery.data?.logo ?? null;
  const darkQuery = useBrandLogoDark();
  const darkMutations = useBrandLogoDarkMutations();
  const uploadedDark: BrandLogo | null = darkQuery.data?.logo ?? null;
  const patch = usePatchTenant();
  const testEmail = useSendTestEmail();
  const [brandName, setBrandName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [footerText, setFooterText] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [testTo, setTestTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Initialize form from fetched data
  useEffect(() => {
    if (!tenant || logoQuery.isLoading || initialized) return;
    const b = tenant.brand;
    setBrandName(b.brand_name ?? "");
    // The URL field is for an external logo; an uploaded logo in use is shown above it.
    setLogoUrl(uploaded?.in_use ? "" : (b.logo_url ?? ""));
    setAccentColor(b.accent_color ?? "");
    setFooterText(b.footer_text ?? "");
    setReplyTo(b.reply_to ?? "");
    setInitialized(true);
  }, [tenant, initialized, logoQuery.isLoading, uploaded]);

  if (isLoading || !tenant) return <Skeleton className="h-48 w-full" />;

  const hasAnyBrand = !!(tenant.brand.brand_name || tenant.brand.logo_url || tenant.brand.accent_color);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const brand: Partial<BrandSettingsData> = {};
      brand.brand_name = brandName.trim() || null;
      // An empty URL field keeps an uploaded logo that is in use.
      if (logoUrl.trim() || !uploaded?.in_use) brand.logo_url = logoUrl.trim() || null;
      brand.accent_color = accentColor.trim() || null;
      brand.footer_text = footerText.trim() || null;
      brand.reply_to = replyTo.trim() || null;
      await patch.mutateAsync({ brand });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleTestSend(e: React.FormEvent) {
    e.preventDefault();
    setTestError(null);
    setTestSent(false);
    try {
      await testEmail.mutateAsync(testTo.trim());
      setTestSent(true);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Send failed");
    }
  }

  return (
    <Section
      title="Email branding"
      configured={hasAnyBrand ? true : null}
      description="Every outgoing email is wrapped in a branded shell. All fields are optional - a fresh install produces clean emails with sensible defaults."
    >
      <form onSubmit={handleSave} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-body font-medium text-foreground">
              Brand name
            </label>
            <Input
              value={brandName}
              onChange={(e) => { setBrandName(e.target.value); setSaved(false); }}
              placeholder={tenant.name}
              disabled={patch.isPending}
            />
            <p className="mt-1 text-caption text-muted-foreground">
              Shown in the email header. Defaults to workspace name.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-body font-medium text-foreground">
              Accent color
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={accentColor}
                onChange={(e) => { setAccentColor(e.target.value); setSaved(false); }}
                placeholder="#2563eb"
                disabled={patch.isPending}
                className="flex-1"
              />
              {accentColor && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accentColor) && (
                <span
                  className="inline-block h-8 w-8 shrink-0 rounded-md border border-border"
                  style={{ backgroundColor: accentColor }}
                  aria-hidden
                />
              )}
            </div>
            <p className="mt-1 text-caption text-muted-foreground">
              Hex color for the top accent bar. Default: blue.
            </p>
          </div>
        </div>

        <LogoUpload
          logo={uploaded}
          darkLogo={uploadedDark?.in_use ? uploadedDark : null}
          height={tenant.brand.logo_height}
          slug={tenant.slug}
          mutations={logoMutations}
          darkMutations={darkMutations}
          onUploaded={() => { setLogoUrl(""); setSaved(false); }}
          onUse={async (url) => {
            await patch.mutateAsync({ brand: { logo_url: url } });
            setLogoUrl("");
          }}
        />

        <div>
          <label className="mb-1.5 block text-body font-medium text-foreground">
            External logo URL
          </label>
          <Input
            value={logoUrl}
            onChange={(e) => { setLogoUrl(e.target.value); setSaved(false); }}
            placeholder="https://example.com/logo.png"
            disabled={patch.isPending}
          />
          <p className="mt-1 text-caption text-muted-foreground">
            Optional: an absolute URL to a logo hosted elsewhere. When set, it replaces the uploaded logo in mail. If there is no logo, the brand name is shown as text.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-body font-medium text-foreground">
            Footer text
          </label>
          <Input
            value={footerText}
            onChange={(e) => { setFooterText(e.target.value); setSaved(false); }}
            placeholder="You are receiving this because you have an account with us."
            disabled={patch.isPending}
          />
          <p className="mt-1 text-caption text-muted-foreground">
            Custom explanation in the email footer. Default: generic account message.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-body font-medium text-foreground">
              Reply-to address
            </label>
            <Input
              value={replyTo}
              onChange={(e) => { setReplyTo(e.target.value); setSaved(false); }}
              placeholder="support@example.com"
              disabled={patch.isPending}
            />
            <p className="mt-1 text-caption text-muted-foreground">
              If set, replies go here instead of the from address.
            </p>
          </div>
        </div>

        <div>
          <p className="mb-1.5 block text-body font-medium text-foreground">Template</p>
          <p className="text-small text-muted-foreground">
            The layout around every email (narrow or wide, header, footer) is chosen and edited on the{" "}
            <Link to="/templates" className="text-accent-text underline">Templates</Link> page. These brand settings fill it in.
          </p>
        </div>

        <FormError message={error} />
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" size="sm" disabled={patch.isPending}>
            {patch.isPending ? "Saving..." : "Save brand"}
          </Button>
          {saved && (
            <span className="text-small text-success" role="status">Saved.</span>
          )}
        </div>
      </form>

      {/* Test send */}
      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-body font-medium text-foreground">
          Send a test email
        </h3>
        <p className="mt-1 text-small text-muted-foreground">
          See what your emails look like in a real inbox. Requires transport and postal address to be configured.
        </p>
        <form onSubmit={handleTestSend} className="mt-3 flex items-end gap-3">
          <div className="flex-1">
            <Input
              value={testTo}
              onChange={(e) => { setTestTo(e.target.value); setTestSent(false); }}
              placeholder="your@email.com"
              type="email"
              disabled={testEmail.isPending}
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={testEmail.isPending || !testTo.includes("@")}>
            {testEmail.isPending ? "Sending..." : "Send test"}
          </Button>
        </form>
        {testSent && (
          <p className="mt-2 text-small text-success" role="status">
            Test email sent to {testTo}. Check your inbox.
          </p>
        )}
        {testError && (
          <p className="mt-2 text-small text-danger">{testError}</p>
        )}
      </div>
    </Section>
  );
}

/**
 * Upload control for the brand logo and its dark-mode version: preview on
 * light and dark, replace and remove. The images are stored by Claros and
 * served from this instance (or the product's public host), so mail does
 * not depend on another site.
 *
 * A chosen logo on a solid light background, or a transparent one that is
 * hard to read on dark, opens LogoReview first: it removes the background
 * and makes the dark-mode version (lib/logo-background.ts) before upload.
 */
function LogoUpload({
  logo,
  darkLogo,
  height,
  slug,
  mutations,
  darkMutations,
  onUploaded,
  onUse,
}: {
  logo: BrandLogo | null;
  darkLogo: BrandLogo | null;
  height: number | null;
  slug: string;
  mutations: ReturnType<typeof useBrandLogoMutations>;
  darkMutations: ReturnType<typeof useBrandLogoDarkMutations>;
  onUploaded: () => void;
  onUse: (url: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const darkInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogo | null>(null);
  const [preparing, setPreparing] = useState(false);
  const busy =
    mutations.upload.isPending || mutations.remove.isPending || darkMutations.upload.isPending || darkMutations.remove.isPending;

  function checkFile(file: File): string | null {
    if (!LOGO_TYPES.includes(file.type)) return "The logo must be a PNG or JPEG image.";
    if (file.size > LOGO_MAX_BYTES) {
      return `The logo must be at most ${formatBytes(LOGO_MAX_BYTES)} (this file is ${formatBytes(file.size)}).`;
    }
    return null;
  }

  /** Open the review when the logo would look wrong in dark mode; true when it did. */
  function review(file: File, decoded: DecodedLogo | null): boolean {
    if (!decoded) return false;
    const { analysis } = decoded;
    if (
      analysis.kind === "light-background" ||
      (analysis.kind === "transparent" && lowContrastShare(decoded.data, decoded.width, decoded.height) >= LOW_CONTRAST_NOTE_SHARE)
    ) {
      setPending({ file, decoded });
      return true;
    }
    return false;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const problem = checkFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    if (review(file, await decodeLogo(file))) return;
    await finish({ logo: file, dark: null });
  }

  /** Upload the logo, then its dark-mode version (or remove a stale one). */
  async function finish(files: { logo: File; dark: File | null }): Promise<boolean> {
    setError(null);
    for (const f of [files.logo, files.dark]) {
      if (f && f.size > LOGO_MAX_BYTES) {
        setError(`The logo must be at most ${formatBytes(LOGO_MAX_BYTES)} (this file is ${formatBytes(f.size)}).`);
        return false;
      }
    }
    try {
      await mutations.upload.mutateAsync(files.logo);
      if (files.dark) await darkMutations.upload.mutateAsync(files.dark);
      else if (darkLogo) await darkMutations.remove.mutateAsync();
      onUploaded();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  /** Run the review on the logo already uploaded. */
  async function handlePrepare() {
    setError(null);
    setPreparing(true);
    try {
      const res = await fetch(`/brand/${encodeURIComponent(slug)}/logo`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not read the uploaded logo.");
      const blob = await res.blob();
      const file = new File([blob], blob.type === "image/jpeg" ? "logo.jpg" : "logo.png", { type: blob.type });
      const decoded = await decodeLogo(file);
      if (!decoded) throw new Error("Could not read the uploaded logo.");
      if (decoded.analysis.kind === "other") {
        setError(
          "This logo has neither a transparent nor a plain light background, so Claros cannot make a dark-mode version of it. Upload one with Upload dark version.",
        );
        return;
      }
      setPending({ file, decoded });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreparing(false);
    }
  }

  async function handleDarkFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const problem = checkFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await darkMutations.upload.mutateAsync(file);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-body font-medium text-foreground">Logo</label>
      <input
        ref={input}
        type="file"
        accept={LOGO_TYPES.join(",")}
        className="hidden"
        onChange={handleFile}
        aria-label="Logo file"
      />
      <input
        ref={darkInput}
        type="file"
        accept={LOGO_TYPES.join(",")}
        className="hidden"
        onChange={handleDarkFile}
        aria-label="Dark-mode logo file"
      />
      <div className="flex flex-wrap items-center gap-4">
        {logo && <LogoSwatches src={logo.url} darkSrc={darkLogo?.url} alt="Uploaded logo" height={height} />}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || !!pending} onClick={() => input.current?.click()}>
            {mutations.upload.isPending ? "Uploading..." : logo ? "Replace" : "Upload logo"}
          </Button>
          {logo && !logo.in_use && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(() => onUse(logo.url))}>
              Use in mail
            </Button>
          )}
          {logo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !!pending}
              onClick={() =>
                run(async () => {
                  await mutations.remove.mutateAsync();
                  if (darkLogo) await darkMutations.remove.mutateAsync();
                })
              }
            >
              {mutations.remove.isPending ? "Removing..." : "Remove"}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-caption text-muted-foreground">
        PNG or JPEG, up to {formatBytes(LOGO_MAX_BYTES)}. Served by Claros, so mail does not depend on another site.
        {logo && ` Current: ${logo.content_type === "image/png" ? "PNG" : "JPEG"}, ${logo.width} x ${logo.height} px, ${formatBytes(logo.size)}.`}
        {logo && !logo.in_use && " Not used in mail: the external logo URL below replaces it."}
      </p>
      {logo && !pending && (
        <div className="mt-3">
          <p className="text-small font-medium text-foreground">Dark mode</p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {darkLogo
              ? "Apple Mail and Outlook show the right-hand version when the reader uses dark mode. Gmail and other apps show the logo."
              : "No dark-mode version: every mail app shows the logo as it is, also in dark mode."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!darkLogo && (
              <Button type="button" variant="outline" size="sm" disabled={busy || preparing} onClick={handlePrepare}>
                {preparing ? "Reading..." : "Prepare for dark mode"}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => darkInput.current?.click()}>
              {darkMutations.upload.isPending ? "Uploading..." : darkLogo ? "Replace dark version" : "Upload dark version"}
            </Button>
            {darkLogo && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(() => darkMutations.remove.mutateAsync())}>
                {darkMutations.remove.isPending ? "Removing..." : "Remove dark version"}
              </Button>
            )}
          </div>
        </div>
      )}
      {pending && (
        <LogoReview
          pending={pending}
          height={height}
          uploading={busy}
          onCancel={() => setPending(null)}
          onUpload={async (files) => {
            if (await finish(files)) setPending(null);
          }}
          onError={setError}
        />
      )}
      <FormError message={error} />
    </div>
  );
}

interface PendingLogo {
  file: File;
  decoded: DecodedLogo;
}

/** A logo shown on a light and a dark mail background, the two ways readers see it. */
function LogoSwatches({ src, darkSrc, alt, height }: { src: string; darkSrc?: string | null; alt: string; height: number | null }) {
  const style = { height: `${Math.min(64, height ?? 32)}px`, width: "auto" };
  return (
    <div className="flex gap-2">
      <div className="flex h-20 min-w-32 items-center justify-center rounded-md border border-border bg-white px-4" title="Light mode">
        <img src={src} alt={alt} style={style} />
      </div>
      <div
        className="flex h-20 min-w-32 items-center justify-center rounded-md border border-border px-4"
        style={{ backgroundColor: DARK_PREVIEW_BG }}
        title="Dark mode"
      >
        <img src={darkSrc || src} alt="" style={style} />
      </div>
    </div>
  );
}

/** An object URL for a file, revoked when the file changes or the component unmounts. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

/**
 * Shown when a chosen logo would look wrong in dark mode: it sits on a
 * solid light background, or it is transparent but too dark to read on a
 * dark background. Previews what gets uploaded on light and dark, with the
 * background made transparent and a dark-mode version made from it.
 */
function LogoReview({
  pending,
  height,
  uploading,
  onCancel,
  onUpload,
  onError,
}: {
  pending: PendingLogo;
  height: number | null;
  uploading: boolean;
  onCancel: () => void;
  onUpload: (files: { logo: File; dark: File | null }) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { analysis } = pending.decoded;
  const background = analysis.kind === "light-background" ? analysis.background : null;
  const [removeBg, setRemoveBg] = useState(true);
  const [clearEnclosed, setClearEnclosed] = useState(true);
  /** null: decided from the result (on when the logo is hard to read on dark). */
  const [makeDark, setMakeDark] = useState<boolean | null>(null);
  const [prepared, setPrepared] = useState<PreparedLogo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    prepareLogo(
      pending.file,
      pending.decoded,
      { background: background && removeBg ? background : null, remove: { clearEnclosed }, dark: true },
      LOGO_MAX_BYTES,
    ).then(
      (result) => {
        if (!cancelled) setPrepared(result);
      },
      (err) => {
        if (!cancelled) onError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pending, background, removeBg, clearEnclosed, onError]);

  const darkAvailable = !!prepared?.dark;
  const hardOnDark = (prepared?.lowContrast ?? 0) >= LOW_CONTRAST_NOTE_SHARE;
  const useDark = darkAvailable && (makeDark ?? hardOnDark);
  const logoUrl = useObjectUrl(prepared?.logo ?? null);
  const darkUrl = useObjectUrl(useDark ? (prepared?.dark ?? null) : null);

  const bgName = background && background.r >= 250 && background.g >= 250 && background.b >= 250 ? "white" : "light";

  return (
    <div className="mt-3 rounded-md border border-border p-4">
      <p className="text-body font-medium text-foreground">
        {background ? `This logo has a solid ${bgName} background` : "This logo is hard to read in dark mode"}
      </p>
      <p className="mt-1 text-small text-muted-foreground">
        {background
          ? `In dark mode, mail apps darken the email but not images, so the background shows as a ${bgName} box around the logo. Claros can make it transparent and add a light version for dark mode. Check both previews.`
          : "Parts of it are dark, so they get lost on a dark background. Claros can add a light version for dark mode. Check both previews."}
      </p>
      <div className="mt-3">{logoUrl && <LogoSwatches src={logoUrl} darkSrc={darkUrl} alt="Logo to upload" height={height} />}</div>
      <div className="mt-3 space-y-1.5 text-small text-foreground">
        {background && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
              Make the background transparent
            </label>
            <label className={`flex items-center gap-2 ${removeBg ? "" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={clearEnclosed}
                disabled={!removeBg}
                onChange={(e) => setClearEnclosed(e.target.checked)}
              />
              Also clear the background color inside the logo, such as the holes in letters
            </label>
            <p className="pl-6 text-caption text-muted-foreground">
              Turn this off if the logo has white parts of its own that should stay.
            </p>
          </>
        )}
        <label className={`flex items-center gap-2 ${darkAvailable ? "" : "opacity-50"}`}>
          <input
            type="checkbox"
            checked={useDark}
            disabled={!darkAvailable}
            onChange={(e) => setMakeDark(e.target.checked)}
          />
          Add a dark-mode version with the dark parts turned light
        </label>
        <p className="pl-6 text-caption text-muted-foreground">
          {darkAvailable
            ? "Apple Mail and Outlook show it when the reader uses dark mode. Gmail and some other apps do not tell the email, so they show the logo."
            : "Needs a transparent background."}
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!prepared || uploading}
          onClick={() => prepared && onUpload({ logo: prepared.logo, dark: useDark ? prepared.dark : null })}
        >
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={onCancel}>
          Cancel
        </Button>
        {prepared && (
          <span className="text-caption text-muted-foreground">
            {prepared.logo.type === "image/png" ? "PNG" : "JPEG"}, {formatBytes(prepared.logo.size)}
            {useDark && prepared.dark && `; dark version ${formatBytes(prepared.dark.size)}`}
          </span>
        )}
      </div>
    </div>
  );
}
