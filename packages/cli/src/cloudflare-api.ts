/**
 * The two Cloudflare API reads wrangler has no command for, made with
 * wrangler's own credentials (`wrangler auth token --json`):
 *
 * - custom domain conflicts: the same dry-run changeset `wrangler deploy`
 *   computes before it attaches custom domains. Run without a terminal,
 *   wrangler would override conflicting DNS records and take over domains of
 *   other Workers; the CLI checks first and stops instead.
 * - the account's Workers plan (best effort).
 *
 * Nothing here writes to the account.
 */
import type { AuthCredentials } from "./wrangler.js";

const API = "https://api.cloudflare.com/client/v4";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

function authHeaders(auth: AuthCredentials): Record<string, string> {
  if (auth.type === "api_key") return { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
  return { Authorization: `Bearer ${auth.token}` };
}

async function call<T>(fetchFn: FetchFn, auth: AuthCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchFn(`${API}${path}`, {
    ...init,
    headers: { ...authHeaders(auth), "Content-Type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
  });
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (!res.ok || !body || !body.success) {
    const errors = body?.errors ?? [];
    throw new CloudflareApiError(
      `Cloudflare API ${init.method ?? "GET"} ${path}: ${res.status} ${errors.map((e) => `${e.code} ${e.message}`).join("; ")}`.trim(),
      res.status,
      errors.map((e) => e.code),
    );
  }
  return body.result;
}

export interface DomainConflict {
  hostname: string;
  /** "dns_record": a DNS record exists for the host; "other_worker": the host is a custom domain of another Worker. */
  kind: "dns_record" | "other_worker";
  /** The other Worker, for kind "other_worker". */
  service?: string;
}

interface ChangesetDomain {
  id?: string;
  hostname: string;
  modified?: boolean;
  service?: string;
}

interface Changeset {
  added?: ChangesetDomain[];
  removed?: ChangesetDomain[];
  updated?: ChangesetDomain[];
  conflicting?: ChangesetDomain[];
}

/** True when the API says the Worker does not exist. */
export function isWorkerNotFound(err: unknown): boolean {
  return err instanceof CloudflareApiError && (err.codes.includes(10007) || err.codes.includes(10090) || err.status === 404);
}

export class CloudflareApi {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly auth: () => Promise<AuthCredentials | null>,
  ) {}

  private async credentials(): Promise<AuthCredentials> {
    const auth = await this.auth();
    if (!auth) throw new Error("Could not read wrangler's credentials (`wrangler auth token`). Run `npx wrangler login`.");
    return auth;
  }

  /**
   * Custom domains that `wrangler deploy` would take over: hosts with an
   * existing DNS record, and hosts that are custom domains of another
   * Worker. Throws a CloudflareApiError for which isWorkerNotFound() is true
   * when the Worker does not exist yet.
   */
  async domainConflicts(accountId: string, workerName: string, hostnames: string[]): Promise<DomainConflict[]> {
    if (hostnames.length === 0) return [];
    const auth = await this.credentials();
    const changeset = await call<Changeset>(
      this.fetchFn,
      auth,
      `/accounts/${accountId}/workers/scripts/${workerName}/domains/changeset?replace_state=true`,
      { method: "POST", body: JSON.stringify(hostnames.map((hostname) => ({ hostname }))) },
    );
    const conflicts: DomainConflict[] = (changeset.conflicting ?? []).map((d) => ({ hostname: d.hostname, kind: "dns_record" }));
    for (const d of (changeset.updated ?? []).filter((u) => u.modified)) {
      let service = d.service;
      if (!service && d.id) {
        const record = await call<{ service?: string }>(this.fetchFn, auth, `/accounts/${accountId}/workers/domains/records/${d.id}`);
        service = record.service;
      }
      if (service && service !== workerName) conflicts.push({ hostname: d.hostname, kind: "other_worker", service });
    }
    return conflicts;
  }

  /**
   * "paid" when the account's subscriptions show a paid Workers plan,
   * otherwise "unknown" (the API is not available to every token, so a
   * missing answer never means Free).
   */
  async workersPlan(accountId: string): Promise<"paid" | "unknown"> {
    try {
      const auth = await this.credentials();
      const subs = await call<Array<{ rate_plan?: { id?: string; public_name?: string } }>>(
        this.fetchFn,
        auth,
        `/accounts/${accountId}/subscriptions`,
      );
      const paid = subs.some((s) => {
        const text = `${s.rate_plan?.id ?? ""} ${s.rate_plan?.public_name ?? ""}`.toLowerCase();
        return text.includes("workers") && (text.includes("paid") || text.includes("bundled") || text.includes("standard"));
      });
      return paid ? "paid" : "unknown";
    } catch {
      return "unknown";
    }
  }
}
