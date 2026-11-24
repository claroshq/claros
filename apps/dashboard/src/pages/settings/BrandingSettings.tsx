/**
 * Settings / Email branding + test send.
 *
 * Every outgoing email is wrapped in a branded shell. All fields are
 * optional - a fresh install produces clean emails with sensible
 * defaults. The test-send form lives here because what it exercises is
 * exactly this configuration (plus transport and postal address).
 */
import React, { useEffect, useState } from "react";
import { useSetupState, usePatchTenant, useSendTestEmail } from "../../settings.js";
import type { BrandSettingsData } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, errorMessage } from "./shared.js";

export default function BrandingSettings() {
  const { tenant, isLoading } = useSetupState();
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
    if (!tenant || initialized) return;
    const b = tenant.brand;
    setBrandName(b.brand_name ?? "");
    setLogoUrl(b.logo_url ?? "");
    setAccentColor(b.accent_color ?? "");
    setFooterText(b.footer_text ?? "");
    setReplyTo(b.reply_to ?? "");
    setInitialized(true);
  }, [tenant, initialized]);

  if (isLoading || !tenant) return <Skeleton className="h-48 w-full" />;

  const hasAnyBrand = !!(tenant.brand.brand_name || tenant.brand.logo_url || tenant.brand.accent_color);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const brand: Partial<BrandSettingsData> = {};
      brand.brand_name = brandName.trim() || null;
      brand.logo_url = logoUrl.trim() || null;
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

        <div>
          <label className="mb-1.5 block text-[14px] font-medium text-foreground">
            Logo URL
          </label>
          <Input
            value={logoUrl}
            onChange={(e) => { setLogoUrl(e.target.value); setSaved(false); }}
            placeholder="https://example.com/logo.png"
            disabled={patch.isPending}
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            Absolute URL to your logo image (PNG or SVG, max 64px height). If empty, brand name is shown as text.
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
