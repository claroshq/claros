/**
 * Settings / Health (instance admins).
 *
 * Operational alerts of this install: open alerts (resolve or mute them),
 * the last run of every periodic job, recent events, and where alert mail
 * goes. Alerts are recorded whether or not mail is enabled; with mail off
 * they show only here and in the logs.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchHealth,
  muteOpsAlert,
  putInstanceSetting,
  resolveOpsAlert,
  type HealthResponse,
  type OpsAlert,
} from "../../api.js";
import { useProducts } from "../../products.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { errorMessage, Notice, Section } from "./shared.js";

const HEALTH_QUERY_KEY = ["instance-health"] as const;

function severityVariant(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "critical" || severity === "error") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function productLabel(p: OpsAlert["product"]): string | null {
  if (!p) return null;
  return p.name ?? p.slug ?? p.id;
}

export default function HealthSettings() {
  const products = useProducts();
  const isAdmin = products.data?.instance_admin === true;
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: fetchHealth,
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (products.data && !isAdmin) {
    return (
      <Section title="Health" configured={null}>
        <p className="text-[14px] text-muted-foreground">Only instance admins see the health of this install.</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Health"
        configured={null}
        description="Failures that need a person: dead jobs, late periodic jobs, send and webhook errors, missing configuration. Error and critical alerts are mailed; warnings show here and in the daily digest."
      >
        {health.isLoading || !health.data ? (
          health.isError ? (
            <Notice>{errorMessage(health.error)}</Notice>
          ) : (
            <Skeleton className="h-24 w-full" />
          )
        ) : (
          <OpenAlerts data={health.data} />
        )}
      </Section>

      {health.data && (
        <>
          <Section title="Periodic jobs" configured={null} description="Last completed run of each periodic job. A job is late after three missed intervals.">
            <TickTable data={health.data} />
          </Section>
          <Section title="Recent events" configured={null} description="The last 100 events of the past 7 days. Events are kept 30 days.">
            <EventTable data={health.data} />
          </Section>
          <AlertSettings data={health.data} />
        </>
      )}
    </div>
  );
}

function OpenAlerts({ data }: { data: HealthResponse }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY });
  const resolve = useMutation({
    mutationFn: (fingerprint: string) => resolveOpsAlert(fingerprint),
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err)),
  });
  const mute = useMutation({
    mutationFn: ({ fingerprint, hours }: { fingerprint: string; hours: number }) => muteOpsAlert(fingerprint, hours),
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err)),
  });

  const open = data.alerts.open;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-6 text-[14px]">
        <p>
          <span className="font-mono text-[13px] text-foreground">{open.length}</span>{" "}
          <span className="text-muted-foreground">open alert{open.length === 1 ? "" : "s"}</span>
        </p>
        <p>
          <span className="font-mono text-[13px] text-foreground">{data.failed_jobs_24h}</span>{" "}
          <span className="text-muted-foreground">failed jobs in 24 hours</span>
        </p>
        {!data.settings.enabled && <Badge variant="warning">alert mail off</Badge>}
      </div>
      {open.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">No open alerts.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <th className="px-4 py-2">Alert</th>
                <th className="px-4 py-2">Severity</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Last seen</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {open.map((a) => (
                <tr key={a.fingerprint} className="border-t border-border align-top">
                  <td className="px-4 py-2.5">
                    <p className="text-foreground">{a.message}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                      {a.kind}
                      {productLabel(a.product) ? ` · ${productLabel(a.product)}` : ""}
                      {a.muted_until ? ` · muted until ${when(a.muted_until)}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={severityVariant(a.severity)}>{a.severity}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{a.count}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{when(a.last_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mute.isPending}
                        onClick={() => mute.mutate({ fingerprint: a.fingerprint, hours: 24 })}
                      >
                        Mute 24h
                      </Button>
                      <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate(a.fingerprint)}>
                        Resolve
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </>
  );
}

function TickTable({ data }: { data: HealthResponse }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <th className="px-4 py-2">Job</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2 text-right">Every</th>
            <th className="px-4 py-2 text-right">Last run</th>
          </tr>
        </thead>
        <tbody>
          {data.ticks.map((t) => (
            <tr key={t.name} className="border-t border-border">
              <td className="px-4 py-2.5 font-mono text-[12px] text-foreground">{t.name}</td>
              <td className="px-4 py-2.5">
                {t.last_run_at === null ? (
                  <Badge variant="muted">not run yet</Badge>
                ) : t.late ? (
                  <Badge variant="danger">late</Badge>
                ) : (
                  <Badge variant="success">on time</Badge>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">
                {t.interval_minutes >= 60 ? `${t.interval_minutes / 60}h` : `${t.interval_minutes}m`}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{when(t.last_run_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventTable({ data }: { data: HealthResponse }) {
  if (data.events.length === 0) {
    return <p className="text-[14px] text-muted-foreground">No events in the past 7 days.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <th className="px-4 py-2">Event</th>
            <th className="px-4 py-2">Severity</th>
            <th className="px-4 py-2 text-right">At</th>
          </tr>
        </thead>
        <tbody>
          {data.events.map((e) => (
            <tr key={e.id} className="border-t border-border align-top">
              <td className="px-4 py-2.5">
                <p className="text-foreground">{e.message}</p>
                <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                  {e.kind}
                  {productLabel(e.product) ? ` · ${productLabel(e.product)}` : ""}
                </p>
              </td>
              <td className="px-4 py-2.5">
                <Badge variant={severityVariant(e.severity)}>{e.severity}</Badge>
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{when(e.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertSettings({ data }: { data: HealthResponse }) {
  const qc = useQueryClient();
  const products = useProducts();
  const [email, setEmail] = useState(data.settings.email ?? "");
  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [via, setVia] = useState(data.settings.via_product ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEmail(data.settings.email ?? "");
    setEnabled(data.settings.enabled);
    setVia(data.settings.via_product ?? "");
  }, [data.settings.email, data.settings.enabled, data.settings.via_product]);

  const save = useMutation({
    mutationFn: async () => {
      await putInstanceSetting("alerts.enabled", enabled);
      await putInstanceSetting("alerts.email", email.trim());
      await putInstanceSetting("alerts.via_product", via);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY });
    },
    onError: (err) => {
      setSaved(false);
      setError(errorMessage(err));
    },
  });

  return (
    <Section
      title="Alert mail"
      configured={null}
      description="Where alert mail and the daily digest (07:00 UTC) go. Alert mail is transactional: it uses the transactional route of the chosen product's transports."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <label className="flex items-center gap-2 text-[14px] text-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Send alert mail and the daily digest
        </label>
        <div>
          <label htmlFor="alerts-email" className="text-[13px] font-medium text-foreground">
            Recipient
          </label>
          <Input
            id="alerts-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={data.settings.default_email ?? "ops@example.com"}
            className="mt-1 max-w-[22rem]"
          />
          <p className="mt-1 text-[13px] text-muted-foreground">
            Empty: the oldest instance admin{data.settings.default_email ? ` (${data.settings.default_email})` : ""}.
          </p>
        </div>
        <div>
          <label htmlFor="alerts-via" className="text-[13px] font-medium text-foreground">
            Send through
          </label>
          <div className="mt-1 max-w-[22rem]">
            <Select id="alerts-via" value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="">The oldest product with a transport</option>
              {(products.data?.products ?? []).map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving..." : "Save alert settings"}
          </Button>
          {saved && <span className="text-[13px] text-muted-foreground">Saved.</span>}
        </div>
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </form>
    </Section>
  );
}
