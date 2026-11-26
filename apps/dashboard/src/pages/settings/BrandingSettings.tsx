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
import { useSetupState, usePatchTenant, useSendTestEmail, useBrandLogo, useBrandLogoMutations } from "../../settings.js";
import type { BrandLogo, BrandSettingsData } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, errorMessage } from "./shared.js";
import { decodeLogo, transparentLogo, type DecodedLogo } from "../../lib/logo-image.js";
import type { Rgb } from "../../lib/logo-background.js";

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
            <label className="mb-1.5 block text-[14px] font-medium text-foreground">
              Brand name
            </label>
            <Input
              value={brandName}
              onChange={(e) => { setBrandName(e.target.value); setSaved(false); }}
              placeholder={tenant.name}
              disabled={patch.isPending}
            />
            <p className="mt-1 text-[12px] text-muted-foreground">
              Shown in the email header. Defaults to workspace name.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-[14px] font-medium text-foreground">
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
            <p className="mt-1 text-[12px] text-muted-foreground">
              Hex color for the top accent bar. Default: blue.
            </p>
          </div>
        </div>

        <LogoUpload
          logo={uploaded}
          height={tenant.brand.logo_height}
          mutations={logoMutations}
          onUploaded={() => { setLogoUrl(""); setSaved(false); }}
          onUse={async (url) => {
            await patch.mutateAsync({ brand: { logo_url: url } });
            setLogoUrl("");
          }}
        />

        <div>
          <label className="mb-1.5 block text-[14px] font-medium text-foreground">
            External logo URL
          </label>
          <Input
            value={logoUrl}
            onChange={(e) => { setLogoUrl(e.target.value); setSaved(false); }}
            placeholder="https://example.com/logo.png"
            disabled={patch.isPending}
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            Optional: an absolute URL to a logo hosted elsewhere. When set, it replaces the uploaded logo in mail. If there is no logo, the brand name is shown as text.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-[14px] font-medium text-foreground">
            Footer text
          </label>
          <Input
            value={footerText}
            onChange={(e) => { setFooterText(e.target.value); setSaved(false); }}
            placeholder="You are receiving this because you have an account with us."
            disabled={patch.isPending}
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            Custom explanation in the email footer. Default: generic account message.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-[14px] font-medium text-foreground">
              Reply-to address
            </label>
            <Input
              value={replyTo}
              onChange={(e) => { setReplyTo(e.target.value); setSaved(false); }}
              placeholder="support@example.com"
              disabled={patch.isPending}
            />
            <p className="mt-1 text-[12px] text-muted-foreground">
              If set, replies go here instead of the from address.
            </p>
          </div>
        </div>

        <div>
          <p className="mb-1.5 block text-[14px] font-medium text-foreground">Template</p>
          <p className="text-[13px] text-muted-foreground">
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
            <span className="text-[13px] text-success" role="status">Saved.</span>
          )}
        </div>
      </form>

      {/* Test send */}
      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-[14px] font-medium text-foreground">
          Send a test email
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
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
          <p className="mt-2 text-[13px] text-success" role="status">
            Test email sent to {testTo}. Check your inbox.
          </p>
        )}
        {testError && (
          <p className="mt-2 text-[13px] text-danger">{testError}</p>
        )}
      </div>
    </Section>
  );
}

/**
 * Upload control for the brand logo: preview, type and size hints, replace
 * and remove. The image is stored by Claros and served from this instance
 * (or the product's public host), so mail does not depend on another site.
 */
function LogoUpload({
  logo,
  height,
  mutations,
  onUploaded,
  onUse,
}: {
  logo: BrandLogo | null;
  height: number | null;
  mutations: ReturnType<typeof useBrandLogoMutations>;
  onUploaded: () => void;
  onUse: (url: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogo | null>(null);
  const busy = mutations.upload.isPending || mutations.remove.isPending;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setError("The logo must be a PNG or JPEG image.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError(`The logo must be at most ${formatBytes(LOGO_MAX_BYTES)} (this file is ${formatBytes(file.size)}).`);
      return;
    }
    // A logo on a solid light background shows as a light box in dark
    // mode: offer a transparent version before uploading.
    const decoded = await decodeLogo(file);
    if (decoded && decoded.analysis.kind === "light-background") {
      setPending({ file, decoded, background: decoded.analysis.background });
      return;
    }
    await upload(file);
  }

  async function upload(file: File): Promise<boolean> {
    setError(null);
    if (file.size > LOGO_MAX_BYTES) {
      setError(`The logo must be at most ${formatBytes(LOGO_MAX_BYTES)} (this file is ${formatBytes(file.size)}).`);
      return false;
    }
    try {
      await mutations.upload.mutateAsync(file);
      onUploaded();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      await mutations.remove.mutateAsync();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleUse(url: string) {
    setError(null);
    try {
      await onUse(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-[14px] font-medium text-foreground">Logo</label>
      <input
        ref={input}
        type="file"
        accept={LOGO_TYPES.join(",")}
        className="hidden"
        onChange={handleFile}
        aria-label="Logo file"
      />
      <div className="flex flex-wrap items-center gap-4">
        {logo && <LogoSwatches src={logo.url} alt="Uploaded logo" height={height} />}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || !!pending} onClick={() => input.current?.click()}>
            {mutations.upload.isPending ? "Uploading..." : logo ? "Replace" : "Upload logo"}
          </Button>
          {logo && !logo.in_use && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => handleUse(logo.url)}>
              Use in mail
            </Button>
          )}
          {logo && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleRemove}>
              {mutations.remove.isPending ? "Removing..." : "Remove"}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        PNG or JPEG, up to {formatBytes(LOGO_MAX_BYTES)}. Served by Claros, so mail does not depend on another site.
        {logo && ` Current: ${logo.content_type === "image/png" ? "PNG" : "JPEG"}, ${logo.width} x ${logo.height} px, ${formatBytes(logo.size)}.`}
        {logo && !logo.in_use && " Not used in mail: the external logo URL below replaces it."}
      </p>
      {pending && (
        <LogoBackgroundReview
          pending={pending}
          height={height}
          uploading={mutations.upload.isPending}
          onCancel={() => setPending(null)}
          onUpload={async (file) => {
            if (await upload(file)) setPending(null);
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
  background: Rgb;
}

/** A logo shown on a light and a dark mail background, the two ways readers see it. */
function LogoSwatches({ src, alt, height }: { src: string; alt: string; height: number | null }) {
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
        <img src={src} alt="" style={style} />
      </div>
    </div>
  );
}

/**
 * Shown when a chosen logo sits on a solid light background: previews the
 * transparent version (lib/logo-background.ts) on light and dark, and
 * uploads it, or the original if the user turns removal off.
 */
function LogoBackgroundReview({
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
  onUpload: (file: File) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [removeBg, setRemoveBg] = useState(true);
  const [clearEnclosed, setClearEnclosed] = useState(true);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [lowContrast, setLowContrast] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCandidate(null);
    const make = removeBg
      ? transparentLogo(pending.file, pending.decoded, pending.background, { clearEnclosed }, LOGO_MAX_BYTES)
      : Promise.resolve({ file: pending.file, lowContrast: 0 });
    make.then(
      (result) => {
        if (cancelled) return;
        setCandidate(result.file);
        setLowContrast(result.lowContrast);
      },
      (err) => {
        if (!cancelled) onError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pending, removeBg, clearEnclosed, onError]);

  useEffect(() => {
    if (!candidate) return;
    const url = URL.createObjectURL(candidate);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [candidate]);

  const { r, g, b } = pending.background;
  const bgName = r >= 250 && g >= 250 && b >= 250 ? "white" : "light";

  return (
    <div className="mt-3 rounded-md border border-border p-4">
      <p className="text-[14px] font-medium text-foreground">This logo has a solid {bgName} background</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        In dark mode, mail apps darken the email but not images, so the background shows as a {bgName} box around the
        logo. Claros can make it transparent before uploading. Check both previews.
      </p>
      <div className="mt-3">{previewUrl && <LogoSwatches src={previewUrl} alt="Logo to upload" height={height} />}</div>
      {removeBg && lowContrast >= LOW_CONTRAST_NOTE_SHARE && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Parts of this logo are dark, so they stay hard to read on a dark background even without the box. A logo
          version in lighter or mid-tone colors reads in both modes.
        </p>
      )}
      <div className="mt-3 space-y-1.5 text-[13px] text-foreground">
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
        <p className="pl-6 text-[12px] text-muted-foreground">
          Turn this off if the logo has white parts of its own that should stay.
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!candidate || uploading}
          onClick={() => candidate && onUpload(candidate)}
        >
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={onCancel}>
          Cancel
        </Button>
        {candidate && (
          <span className="text-[12px] text-muted-foreground">
            {candidate.type === "image/png" ? "PNG" : "JPEG"}, {formatBytes(candidate.size)}
          </span>
        )}
      </div>
    </div>
  );
}
