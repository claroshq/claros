/**
 * Settings / Email transport.
 *
 * Same replace-never-show discipline as the LLM provider: the GET
 * endpoint never returns credentials. Without a transport, approved
 * messages cannot be delivered.
 */
import React, { useState } from "react";
import { useSetupState, usePutTransport } from "../../settings.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, Notice, SummaryList, SummaryItem, errorMessage, formatDate } from "./shared.js";
import { Badge } from "../../components/ui/badge.js";

const TRANSPORT_PROVIDERS: ReadonlyArray<{ value: string; label: string; note?: string }> = [
  { value: "resend", label: "Resend" },
  { value: "smtp", label: "SMTP" },
];

export default function TransportSettings() {
  const { transport, isLoading } = useSetupState();
  const put = usePutTransport();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("resend");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  // Resend fields
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  // SMTP fields
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpRejectUnauthorized, setSmtpRejectUnauthorized] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const limit = dailyLimit.trim() === "" ? undefined : Number(dailyLimit);
    try {
      if (provider === "smtp") {
        await put.mutateAsync({
          provider,
          from_email: fromEmail,
          from_name: fromName.trim() === "" ? undefined : fromName.trim(),
          host: smtpHost,
          port: Number(smtpPort),
          secure: smtpSecure,
          username: smtpUsername.trim() === "" ? undefined : smtpUsername.trim(),
          password: smtpPassword === "" ? undefined : smtpPassword,
          reject_unauthorized: smtpRejectUnauthorized,
          daily_limit: limit,
        });
      } else {
        await put.mutateAsync({
          provider,
          from_email: fromEmail,
          from_name: fromName.trim() === "" ? undefined : fromName.trim(),
          api_key: apiKey,
          webhook_secret: webhookSecret.trim() === "" ? undefined : webhookSecret.trim(),
          daily_limit: limit,
        });
      }
      setOpen(false);
      setSaved(true);
      setApiKey("");
      setWebhookSecret("");
      setSmtpPassword("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const formVisible = open || transport === null;

  const isResendValid = provider === "resend" && apiKey && fromEmail;
  const isSmtpValid = provider === "smtp" && smtpHost && smtpPort && fromEmail;
  const canSubmit = isResendValid || isSmtpValid;

  return (
    <Section
      title="Email transport"
      configured={transport !== null}
      actions={
        !formVisible && transport ? (
          <Button variant="outline" size="sm" onClick={() => { setOpen(true); setSaved(false); }}>
            Replace
          </Button>
        ) : undefined
      }
    >
      {!formVisible && transport && (
        <>
          <SummaryList>
            <SummaryItem label="Provider">
              {TRANSPORT_PROVIDERS.find((p) => p.value === transport.provider)?.label ?? transport.provider}
            </SummaryItem>
            <SummaryItem label="From" mono>
              {transport.from_name ? `${transport.from_name} <${transport.from_email}>` : transport.from_email}
            </SummaryItem>
            <SummaryItem label="Daily limit" mono>
              {transport.daily_limit !== null ? `${transport.daily_limit.toLocaleString("en-US")} / day` : "No limit"}
            </SummaryItem>
            <SummaryItem label="Domain authentication">
              {transport.provider === "smtp" ? (
                <span className="text-muted-foreground">Not applicable for SMTP</span>
              ) : transport.dkim_verified ? (
                <Badge variant="success">verified</Badge>
              ) : (
                <Badge variant="warning">not verified</Badge>
              )}
            </SummaryItem>
            <SummaryItem label="Configured">{formatDate(transport.created_at)}</SummaryItem>
          </SummaryList>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Every outgoing message leaves through this transport. Credentials are stored encrypted and never displayed.
          </p>
        </>
      )}
      {saved && !formVisible && (
        <p className="mt-3 text-[13px] text-success" role="status">Saved.</p>
      )}
      {transport === null && (
        <Notice className="mb-4">
          Without a transport, approved messages cannot be delivered. The
          product can draft and compile, but nothing sends.
        </Notice>
      )}
      {formVisible && (
        <form onSubmit={handleSubmit} noValidate className="mt-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="tp-provider" className="mb-1.5 block text-[14px] font-medium text-foreground">
                Provider
              </label>
              <Select id="tp-provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={put.isPending}>
                {TRANSPORT_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}{p.note ? ` (${p.note})` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="tp-daily-limit" className="mb-1.5 block text-[14px] font-medium text-foreground">
                Daily limit <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input id="tp-daily-limit" type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} disabled={put.isPending} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="tp-from-email" className="mb-1.5 block text-[14px] font-medium text-foreground">
                From email <span className="text-danger" aria-hidden="true">*</span>
              </label>
              <Input id="tp-from-email" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="hello@yourdomain.com" disabled={put.isPending} required />
            </div>
            <div>
              <label htmlFor="tp-from-name" className="mb-1.5 block text-[14px] font-medium text-foreground">
                From name <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input id="tp-from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={put.isPending} />
            </div>
          </div>

          {/* SMTP-specific notice */}
          {provider === "smtp" && (
            <p className="rounded-md border border-border bg-sunken px-3.5 py-2.5 text-[13px] text-muted-foreground">
              SMTP does not provide delivery feedback. Open, click, bounce, and complaint
              events will not be tracked. Your suppression list will not fill automatically
              from bounces. Consider Resend if you need engagement tracking.
            </p>
          )}

          {/* Resend fields */}
          {provider === "resend" && (
            <>
              <div>
                <label htmlFor="tp-api-key" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  API key <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="tp-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={put.isPending} required />
              </div>
              <div>
                <label htmlFor="tp-webhook-secret" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Webhook secret <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input id="tp-webhook-secret" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" disabled={put.isPending} />
              </div>
            </>
          )}

          {/* SMTP fields */}
          {provider === "smtp" && (
            <>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label htmlFor="tp-smtp-host" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    SMTP host <span className="text-danger" aria-hidden="true">*</span>
                  </label>
                  <Input id="tp-smtp-host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" disabled={put.isPending} required />
                </div>
                <div>
                  <label htmlFor="tp-smtp-port" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    Port <span className="text-danger" aria-hidden="true">*</span>
                  </label>
                  <Input id="tp-smtp-port" type="number" min={1} max={65535} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} disabled={put.isPending} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tp-smtp-username" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    Username <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <Input id="tp-smtp-username" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} autoComplete="off" disabled={put.isPending} />
                </div>
                <div>
                  <label htmlFor="tp-smtp-password" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    Password <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <Input id="tp-smtp-password" type="password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} autoComplete="off" disabled={put.isPending} />
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-[14px] text-foreground">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    disabled={put.isPending}
                    className="rounded border-input"
                  />
                  Implicit TLS (port 465)
                </label>
                <label className="flex items-center gap-2 text-[14px] text-foreground">
                  <input
                    type="checkbox"
                    checked={!smtpRejectUnauthorized}
                    onChange={(e) => setSmtpRejectUnauthorized(!e.target.checked)}
                    disabled={put.isPending}
                    className="rounded border-input"
                  />
                  Accept self-signed certificates
                </label>
              </div>
            </>
          )}

          <FormError message={error} />
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={put.isPending || !canSubmit}>
              {put.isPending ? "Verifying..." : transport === null ? "Save transport" : "Replace transport"}
            </Button>
            {transport !== null && (
              <Button type="button" variant="ghost" disabled={put.isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </Section>
  );
}
