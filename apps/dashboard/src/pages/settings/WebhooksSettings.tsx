/**
 * Settings / Webhooks.
 *
 * Signed (Standard Webhooks) endpoints of the product: list, create (the
 * signing secret is shown once), rotate the secret (shown once), enable or
 * disable, edit url / events / the pending-approval batch window, delete,
 * and the latest deliveries per endpoint. The analytics sink (configured
 * in settings.analytics of a config document) is listed read-only.
 *
 * The same endpoints a config document's `webhooks` list writes; a config
 * apply that lists webhooks overwrites changes made here.
 */
import React, { useState } from "react";
import {
  useWebhooks,
  useWebhookDeliveries,
  useCreateWebhook,
  usePatchWebhook,
  useDeleteWebhook,
  useRotateWebhook,
  type WebhookEndpoint,
} from "../../webhooks.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Badge, type BadgeVariant } from "../../components/ui/badge.js";
import { Section, FormError, Notice, errorMessage } from "./shared.js";

const LABEL = "mb-1.5 block text-[16px] font-medium text-foreground";
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function deliveryVariant(status: string): BadgeVariant {
  if (status === "delivered") return "success";
  if (status === "dead") return "danger";
  return "warning";
}

/** The secret, shown once after create or rotate. */
function SecretOnce({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-warning bg-warning-soft px-4 py-3" role="status">
      <p className="text-[16px] text-foreground">
        Signing secret. Copy it now: it is not shown again.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-card px-2 py-1 font-mono text-[14px] text-foreground">{secret}</code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function EventPicker({
  all,
  selected,
  onChange,
  disabled,
  idPrefix,
}: {
  all: string[];
  selected: string[];
  onChange: (events: string[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {all.map((ev) => (
        <label key={ev} htmlFor={`${idPrefix}-${ev}`} className="flex items-center gap-2 text-[16px] text-foreground">
          <input
            id={`${idPrefix}-${ev}`}
            type="checkbox"
            checked={selected.includes(ev)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...selected, ev] : selected.filter((x) => x !== ev))}
            className="rounded border-input"
          />
          <span className="font-mono text-[14px]">{ev}</span>
        </label>
      ))}
    </div>
  );
}

function Deliveries({ slug }: { slug: string }) {
  const { data, isLoading, error } = useWebhookDeliveries(slug);
  if (isLoading) return <Skeleton className="mt-3 h-20 w-full" />;
  if (error || !data) return <FormError message={error ? errorMessage(error) : "Deliveries could not be loaded."} />;
  if (data.deliveries.length === 0) {
    return <p className="mt-3 text-[16px] text-muted-foreground">No deliveries yet.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[15px]">
        <thead className="bg-sunken text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Event</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Attempts</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">Delivered or next try</th>
            <th className="px-3 py-2 font-medium">Last error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.deliveries.map((d) => (
            <tr key={d.id}>
              <td className="px-3 py-2 font-mono">{d.event}</td>
              <td className="px-3 py-2">
                <Badge variant={deliveryVariant(d.status)}>{d.status}</Badge>
              </td>
              <td className="px-3 py-2 font-mono">{d.attempts}</td>
              <td className="px-3 py-2 font-mono text-muted-foreground">{formatDateTime(d.created_at)}</td>
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {d.delivered_at ? formatDateTime(d.delivered_at) : d.status === "pending" ? formatDateTime(d.next_attempt_at) : ""}
              </td>
              <td className="max-w-64 truncate px-3 py-2 text-muted-foreground" title={d.last_error ?? ""}>
                {d.last_error ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointRow({ endpoint, allEvents }: { endpoint: WebhookEndpoint; allEvents: string[] }) {
  const patch = usePatchWebhook();
  const del = useDeleteWebhook();
  const rotate = useRotateWebhook();
  const [editing, setEditing] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState(endpoint.url);
  const [events, setEvents] = useState<string[]>(endpoint.events);
  const [batch, setBatch] = useState(String(endpoint.batch_interval_minutes));
  const busy = patch.isPending || del.isPending || rotate.isPending;

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  async function save() {
    const minutes = Number(batch);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setErr("The batch window is a whole number of minutes from 1 to 1440.");
      return;
    }
    await run(async () => {
      await patch.mutateAsync({ slug: endpoint.slug, patch: { url, events, batch_interval_minutes: minutes } });
      setEditing(false);
    });
  }

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-medium text-foreground">{endpoint.slug}</span>
            {endpoint.read_only && <Badge variant="muted">analytics sink</Badge>}
            <Badge variant={endpoint.enabled ? "success" : "muted"}>{endpoint.enabled ? "enabled" : "disabled"}</Badge>
          </div>
          <p className="mt-0.5 break-all text-[15px] text-muted-foreground">{endpoint.url}</p>
          {!endpoint.read_only && (
            <p className="mt-1 text-[15px] text-muted-foreground">
              {endpoint.events.length} event{endpoint.events.length === 1 ? "" : "s"}
              {endpoint.events.includes("message.pending_approval")
                ? `, approval pings batched every ${endpoint.batch_interval_minutes} min`
                : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowDeliveries((v) => !v)}>
            {showDeliveries ? "Hide deliveries" : "Deliveries"}
          </Button>
          {!endpoint.read_only && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => patch.mutateAsync({ slug: endpoint.slug, patch: { enabled: !endpoint.enabled } }))}
              >
                {endpoint.enabled ? "Disable" : "Enable"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing((v) => !v)}>
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(async () => setSecret((await rotate.mutateAsync(endpoint.slug)).secret))}
              >
                Rotate secret
              </Button>
              {confirmDelete ? (
                <>
                  <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => del.mutateAsync(endpoint.slug))}>
                    Delete
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <FormError message={err} />
      {secret && <SecretOnce secret={secret} onDismiss={() => setSecret(null)} />}
      {editing && (
        <div className="mt-4 space-y-4 rounded-md border border-border bg-sunken p-4">
          <div>
            <label htmlFor={`url-${endpoint.id}`} className={LABEL}>URL</label>
            <Input id={`url-${endpoint.id}`} value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
          </div>
          <div>
            <p className={LABEL}>Events</p>
            <EventPicker all={allEvents} selected={events} onChange={setEvents} disabled={busy} idPrefix={`ev-${endpoint.id}`} />
          </div>
          <div className="max-w-56">
            <label htmlFor={`batch-${endpoint.id}`} className={LABEL}>Approval ping window (minutes)</label>
            <Input id={`batch-${endpoint.id}`} type="number" min={1} max={1440} value={batch} onChange={(e) => setBatch(e.target.value)} disabled={busy} />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={busy || events.length === 0} onClick={() => void save()}>
              {patch.isPending ? "Saving..." : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {showDeliveries && <Deliveries slug={endpoint.slug} />}
    </li>
  );
}

function NewWebhookForm({ allEvents, onDone }: { allEvents: string[]; onDone: () => void }) {
  const create = useCreateWebhook();
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!SLUG_RE.test(slug)) {
      setErr("Slug: 1-63 characters of a-z, 0-9, _ and -, starting with a letter or digit.");
      return;
    }
    try {
      const created = await create.mutateAsync({ slug, url: url.trim(), events });
      setSecret(created.secret);
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }

  if (secret) {
    return (
      <div className="mt-4">
        <p className="text-[16px] text-foreground">
          Webhook <span className="font-mono">{slug}</span> created.
        </p>
        <SecretOnce secret={secret} onDismiss={onDone} />
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 space-y-4 rounded-md border border-border p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="wh-slug" className={LABEL}>Slug</label>
          <Input id="wh-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="app" disabled={create.isPending} />
        </div>
        <div>
          <label htmlFor="wh-url" className={LABEL}>URL</label>
          <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com/claros/webhook" disabled={create.isPending} />
        </div>
      </div>
      <div>
        <p className={LABEL}>Events</p>
        <EventPicker all={allEvents} selected={events} onChange={setEvents} disabled={create.isPending} idPrefix="new-ev" />
      </div>
      <FormError message={err} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={create.isPending || events.length === 0 || url.trim() === ""}>
          {create.isPending ? "Creating..." : "Create webhook"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function WebhooksSettings() {
  const { data, isLoading, error } = useWebhooks();
  const [adding, setAdding] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) return <FormError message={error ? errorMessage(error) : "Webhooks could not be loaded."} />;

  return (
    <Section
      title="Webhooks"
      description="Signed POST requests to your app when something happens: messages sent or failed, approvals waiting, unsubscribes, enrollments. Verify them with the Standard Webhooks signature."
      configured={null}
      actions={
        !adding ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            New webhook
          </Button>
        ) : undefined
      }
    >
      <Notice variant="info">
        A config document that lists webhooks replaces what you change here on its next apply.
      </Notice>
      {data.webhooks.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {data.webhooks.map((w) => (
            <EndpointRow key={w.id} endpoint={w} allEvents={data.events} />
          ))}
        </ul>
      )}
      {data.webhooks.length === 0 && !adding && (
        <p className="mt-4 text-[16px] text-muted-foreground">No webhooks yet.</p>
      )}
      {adding && <NewWebhookForm allEvents={data.events} onDone={() => setAdding(false)} />}
    </Section>
  );
}
