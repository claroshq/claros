/**
 * Settings / Transports.
 *
 * A product can have several transports (Resend, SMTP, Cloudflare Email
 * Service) and routes mail between them: transactional-topic mail uses the
 * transactional route, everything else the default route. Without routing
 * the oldest transport sends everything, as with a single transport.
 *
 * Same replace-never-show discipline as the LLM provider: the API never
 * returns credentials. Cloudflare Email Service is for transactional mail
 * only; the API refuses it as the default route and the drain fails any
 * other mail routed to it.
 */
import React, { useEffect, useState } from "react";
import type { TransportItem, TransportKind, TransportRouting } from "../../api.js";
import {
  useTransports,
  useCreateTransport,
  useDeleteTransport,
  useTestTransport,
  usePutTransportRouting,
} from "../../topics-transports.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Badge } from "../../components/ui/badge.js";
import { Section, FormError, Notice, SummaryList, SummaryItem, errorMessage, formatDate } from "./shared.js";

const KIND_LABELS: Record<TransportKind, string> = {
  resend: "Resend",
  smtp: "SMTP",
  cloudflare: "Cloudflare Email Service",
};

const LABEL = "mb-1.5 block text-[14px] font-medium text-foreground";
const OPTIONAL = <span className="font-normal text-muted-foreground">(optional)</span>;
const REQUIRED = <span className="text-danger" aria-hidden="true">*</span>;

function transportLabel(t: TransportItem): string {
  return t.name ? `${t.name} (${KIND_LABELS[t.kind] ?? t.kind})` : `${KIND_LABELS[t.kind] ?? t.kind}, ${t.from_email}`;
}

export default function TransportSettings() {
  const { data, isLoading, error } = useTransports();
  const [adding, setAdding] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) {
    return <FormError message={error ? errorMessage(error) : "Transports could not be loaded."} />;
  }

  const transports = data.transports;
  const formVisible = adding || transports.length === 0;

  return (
    <div className="space-y-6">
      <Section
        title="Transports"
        description="Every outgoing message leaves through one of these. Credentials are stored encrypted and never displayed."
        configured={transports.length > 0}
        actions={
          !formVisible ? (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Add transport
            </Button>
          ) : undefined
        }
      >
        {transports.length === 0 && (
          <Notice className="mb-4">
            Without a transport, approved messages cannot be delivered. The product can draft and compile, but
            nothing sends.
          </Notice>
        )}
        {transports.length > 0 && (
          <ul className="space-y-4">
            {transports.map((t) => (
              <TransportCard key={t.id} transport={t} effective={data.effective} />
            ))}
          </ul>
        )}
        {formVisible && (
          <AddTransportForm
            canCancel={transports.length > 0}
            onDone={() => setAdding(false)}
          />
        )}
      </Section>

      {transports.length > 0 && (
        <RoutingSection transports={transports} routing={data.routing} effective={data.effective} />
      )}
    </div>
  );
}

function TransportCard({ transport: t, effective }: { transport: TransportItem; effective: TransportRouting }) {
  const del = useDeleteTransport();
  const test = useTestTransport();
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function sendTest(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMessage(null);
    try {
      const r = await test.mutateAsync({ id: t.id, to: testTo.trim() });
      setMessage(`Test email sent to ${r.to}.`);
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }

  async function remove() {
    setErr(null);
    if (!window.confirm(`Remove ${transportLabel(t)}? Mail routed to it falls back to the default rules.`)) return;
    try {
      await del.mutateAsync(t.id);
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }

  return (
    <li className="rounded-md border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium text-foreground">{t.name ?? KIND_LABELS[t.kind] ?? t.kind}</span>
        <Badge variant="neutral">{KIND_LABELS[t.kind] ?? t.kind}</Badge>
        {effective.default === t.id && <Badge variant="accent">default</Badge>}
        {effective.transactional === t.id && <Badge variant="accent">transactional</Badge>}
        {t.kind === "cloudflare" && <Badge variant="muted">transactional only</Badge>}
      </div>
      <SummaryList>
        <SummaryItem label="From" mono>
          {t.from_name ? `${t.from_name} <${t.from_email}>` : t.from_email}
        </SummaryItem>
        <SummaryItem label="Reply-To" mono>{t.reply_to ?? "Not set"}</SummaryItem>
        <SummaryItem label="Daily limit" mono>
          {t.daily_limit !== null ? `${t.daily_limit.toLocaleString("en-US")} / day` : "No limit"}
        </SummaryItem>
        <SummaryItem label="Configured">{formatDate(t.created_at)}</SummaryItem>
      </SummaryList>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {testing ? (
          <form onSubmit={sendTest} className="flex flex-wrap items-center gap-2">
            <label htmlFor={`test-${t.id}`} className="sr-only">Test recipient</label>
            <Input
              id={`test-${t.id}`}
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@yourdomain.com"
              className="w-64"
              disabled={test.isPending}
            />
            <Button type="submit" size="sm" disabled={test.isPending || testTo.trim() === ""}>
              {test.isPending ? "Sending..." : "Send test"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setTesting(false)}>Cancel</Button>
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setTesting(true)}>Send test email</Button>
        )}
        <Button size="sm" variant="ghost" onClick={remove} disabled={del.isPending}>Remove</Button>
      </div>
      {message && <p className="mt-3 text-[13px] text-success" role="status">{message}</p>}
      <FormError message={err} />
    </li>
  );
}

function AddTransportForm({ canCancel, onDone }: { canCancel: boolean; onDone: () => void }) {
  const create = useCreateTransport();
  const [kind, setKind] = useState<TransportKind>("resend");
  const [name, setName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpRejectUnauthorized, setSmtpRejectUnauthorized] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending;

  const opt = (v: string) => (v.trim() === "" ? undefined : v.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        kind,
        name: opt(name) ?? null,
        from_email: fromEmail.trim(),
        from_name: opt(fromName) ?? null,
        reply_to: opt(replyTo) ?? null,
        daily_limit: dailyLimit.trim() === "" ? null : Number(dailyLimit),
        ...(kind === "resend" ? { api_key: apiKey, webhook_secret: opt(webhookSecret) } : {}),
        ...(kind === "smtp"
          ? {
              host: smtpHost.trim(),
              port: Number(smtpPort),
              secure: smtpSecure,
              username: opt(smtpUsername),
              password: smtpPassword === "" ? undefined : smtpPassword,
              reject_unauthorized: smtpRejectUnauthorized,
            }
          : {}),
        ...(kind === "cloudflare" ? { account_id: opt(accountId), api_token: opt(apiToken) } : {}),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canSubmit =
    fromEmail.trim() !== "" &&
    (kind === "resend" ? apiKey !== "" : kind === "smtp" ? smtpHost.trim() !== "" && smtpPort !== "" : true);

  return (
    <form onSubmit={submit} noValidate className="mt-6 space-y-4 rounded-md border border-border p-4">
      <h3 className="text-[16px] font-semibold text-foreground">Add transport</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="tp-kind" className={LABEL}>Provider</label>
          <Select id="tp-kind" value={kind} onChange={(e) => setKind(e.target.value as TransportKind)} disabled={busy}>
            {(Object.keys(KIND_LABELS) as TransportKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="tp-name" className={LABEL}>Name {OPTIONAL}</label>
          <Input id="tp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Receipts" disabled={busy} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="tp-from-email" className={LABEL}>From email {REQUIRED}</label>
          <Input id="tp-from-email" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="hello@yourdomain.com" disabled={busy} required />
        </div>
        <div>
          <label htmlFor="tp-from-name" className={LABEL}>From name {OPTIONAL}</label>
          <Input id="tp-from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={busy} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="tp-reply-to" className={LABEL}>Reply-To {OPTIONAL}</label>
          <Input id="tp-reply-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@yourdomain.com" disabled={busy} />
        </div>
        <div>
          <label htmlFor="tp-daily-limit" className={LABEL}>Daily limit {OPTIONAL}</label>
          <Input id="tp-daily-limit" type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} disabled={busy} />
        </div>
      </div>

      {kind === "cloudflare" && (
        <Notice variant="info">
          Cloudflare Email Service is for transactional mail only. Use it for the transactional route; Claros
          fails any other message routed to it. On Workers with the send_email binding EMAIL, the account id and
          API token can stay empty.
        </Notice>
      )}
      {kind === "smtp" && (
        <Notice variant="info">
          SMTP does not provide delivery feedback. Open, click, bounce, and complaint events will not be tracked.
        </Notice>
      )}

      {kind === "resend" && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="tp-api-key" className={LABEL}>API key {REQUIRED}</label>
            <Input id="tp-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={busy} required />
          </div>
          <div>
            <label htmlFor="tp-webhook-secret" className={LABEL}>Webhook secret {OPTIONAL}</label>
            <Input id="tp-webhook-secret" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
        </div>
      )}

      {kind === "smtp" && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label htmlFor="tp-smtp-host" className={LABEL}>SMTP host {REQUIRED}</label>
              <Input id="tp-smtp-host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" disabled={busy} required />
            </div>
            <div>
              <label htmlFor="tp-smtp-port" className={LABEL}>Port {REQUIRED}</label>
              <Input id="tp-smtp-port" type="number" min={1} max={65535} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} disabled={busy} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="tp-smtp-username" className={LABEL}>Username {OPTIONAL}</label>
              <Input id="tp-smtp-username" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} autoComplete="off" disabled={busy} />
            </div>
            <div>
              <label htmlFor="tp-smtp-password" className={LABEL}>Password {OPTIONAL}</label>
              <Input id="tp-smtp-password" type="password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} autoComplete="off" disabled={busy} />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-[14px] text-foreground">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} disabled={busy} className="rounded border-input" />
              Implicit TLS (port 465)
            </label>
            <label className="flex items-center gap-2 text-[14px] text-foreground">
              <input type="checkbox" checked={!smtpRejectUnauthorized} onChange={(e) => setSmtpRejectUnauthorized(!e.target.checked)} disabled={busy} className="rounded border-input" />
              Accept self-signed certificates
            </label>
          </div>
        </>
      )}

      {kind === "cloudflare" && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="tp-cf-account" className={LABEL}>Account id {OPTIONAL}</label>
            <Input id="tp-cf-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
          <div>
            <label htmlFor="tp-cf-token" className={LABEL}>API token {OPTIONAL}</label>
            <Input id="tp-cf-token" type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
        </div>
      )}

      <FormError message={error} />
      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" disabled={busy || !canSubmit}>{busy ? "Saving..." : "Add transport"}</Button>
        {canCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        )}
      </div>
    </form>
  );
}

const AUTOMATIC = "";

function RoutingSection({
  transports,
  routing,
  effective,
}: {
  transports: TransportItem[];
  routing: TransportRouting;
  effective: TransportRouting;
}) {
  const put = usePutTransportRouting();
  const [defaultId, setDefaultId] = useState(routing.default ?? AUTOMATIC);
  const [transactionalId, setTransactionalId] = useState(routing.transactional ?? AUTOMATIC);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDefaultId(routing.default ?? AUTOMATIC);
    setTransactionalId(routing.transactional ?? AUTOMATIC);
  }, [routing.default, routing.transactional]);

  const byId = (id: string | null) => transports.find((t) => t.id === id);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const r = await put.mutateAsync({
        default: defaultId === AUTOMATIC ? null : defaultId,
        transactional: transactionalId === AUTOMATIC ? null : transactionalId,
      });
      setWarnings(r.warnings);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const defaultFallback = byId(effective.default);
  return (
    <Section
      title="Routing"
      description="Transactional-topic mail uses the transactional route; all other mail uses the default route."
      configured={null}
    >
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="rt-default" className={LABEL}>Default</label>
            <Select id="rt-default" value={defaultId} onChange={(e) => setDefaultId(e.target.value)} disabled={put.isPending}>
              <option value={AUTOMATIC}>Automatic (oldest transport)</option>
              {transports
                .filter((t) => t.kind !== "cloudflare")
                .map((t) => (
                  <option key={t.id} value={t.id}>{transportLabel(t)}</option>
                ))}
            </Select>
          </div>
          <div>
            <label htmlFor="rt-transactional" className={LABEL}>Transactional</label>
            <Select id="rt-transactional" value={transactionalId} onChange={(e) => setTransactionalId(e.target.value)} disabled={put.isPending}>
              <option value={AUTOMATIC}>Same as default</option>
              {transports.map((t) => (
                <option key={t.id} value={t.id}>{transportLabel(t)}</option>
              ))}
            </Select>
          </div>
        </div>
        {defaultFallback?.kind === "cloudflare" && (
          <Notice>
            The default route currently falls back to a Cloudflare transport. Non-transactional mail will fail until
            another transport is the default.
          </Notice>
        )}
        {warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
        <FormError message={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={put.isPending}>{put.isPending ? "Saving..." : "Save routing"}</Button>
          {saved && <span className="text-[13px] text-success" role="status">Saved.</span>}
        </div>
      </form>
    </Section>
  );
}
