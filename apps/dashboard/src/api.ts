/**
 * API client helpers.
 *
 * Thin wrappers over fetch. All paths are relative so they work through
 * Vite's dev proxy and through the Fastify server when the SPA is served
 * as static files.
 *
 * Session expiry: apiFetch() handles a 401 from any authenticated endpoint
 * as an expired session: it flags the login page (sessionStorage) and hard
 * navigates to /login. A hard navigation is used instead of clearing the me
 * query cache because TanStack Query v5 does not propagate removeQueries to
 * active observers: useMe() in App.tsx keeps its stale data and no redirect
 * fires (verified in a browser run). The hard reload matches the logout
 * path and cannot leave stale state behind.
 * This path must not trigger for /auth/me itself - fetchMe() does not go
 * through apiFetch().
 *
 * Products: every call carries the selected product (see product.ts). A 401
 * while a product is selected first drops the selection and reloads on the
 * session's product; only a 401 without a selection means the session is gone.
 */
import { clearRefusedProduct, withProduct } from "./product.js";

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    tenantId: string;
  };
}

export interface LoginResponse {
  message: string;
}

// ---------------------------------------------------------------------------
// Shared authenticated fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper for authenticated endpoints (anything under /v1).
 *
 * On a 401 response the session is gone: flag the login page so it can say
 * why, then hard navigate there. Do not use this for /auth/me. A 401 from
 * /auth/me is the normal unauthenticated state, not session expiry;
 * fetchMe() handles it directly.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, withProduct(init));
  if (res.status === 401 && clearRefusedProduct()) {
    window.location.assign("/home");
    return res;
  }
  if (res.status === 401) {
    // Tell the login page WHY the user is landing there. sessionStorage
    // survives the navigation and dies with the tab; LoginPage clears it on
    // read so a later manual visit to /login shows no stale notice.
    try {
      sessionStorage.setItem("claros-session-expired", "1");
    } catch {
      // storage unavailable; the redirect still works, the notice is lost
    }
    window.location.assign("/login");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Auth endpoints (do NOT use apiFetch - these are pre-auth paths)
// ---------------------------------------------------------------------------

/** GET /auth/me - returns the signed-in user or throws on 401. */
export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch("/auth/me", withProduct());
  if (!res.ok) {
    throw new Error(`/auth/me returned ${res.status}`);
  }
  return res.json() as Promise<MeResponse>;
}

/** POST /auth/login - request a magic link. */
export async function postLogin(email: string): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Login failed (${res.status})`);
  }
  return res.json() as Promise<LoginResponse>;
}

/** POST /auth/logout - destroy the current session. */
export async function postLogout(): Promise<void> {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "include",
  });
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export interface Flow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  priority: number;
  trigger_type: "lifecycle_transition" | "event" | "segment" | "manual" | "date_property" | "date_schedule";
  trigger_config: Record<string, unknown>;
  steps: unknown;
  source: "manual" | "library" | "brain_suggested" | "config";
  /** Config-as-code slug; null for dashboard flows. Absent on servers before v0.8.8. */
  slug?: string | null;
  content_mode: "ai_drafted" | "fixed_content";
  status: "draft" | "active" | "paused" | "archived";
  approval_mode: "require" | "auto";
  flow_class: "critical" | "nurture" | "scheduled";
  reentry_policy: "once" | "cooldown" | "every_time";
  reentry_cooldown_days: number;
  prompt_source: string | null;
  compiled_plan: Record<string, unknown> | null;
  compiled_at: string | null;
  compile_status: "pending" | "ready" | "failed" | null;
  compile_error: string | null;
  /** Topic of the flow's messages; absent from servers before topics. */
  topic_id?: string | null;
  /** Email template of the flow's messages (built-in key or custom id); null = the product's. */
  email_template?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowsResponse {
  flows: Flow[];
}

/** GET /v1/flows - list flows for the current tenant. */
export async function fetchFlows(): Promise<FlowsResponse> {
  const res = await apiFetch("/v1/flows");
  if (!res.ok) {
    throw new Error(`/v1/flows returned ${res.status}`);
  }
  return res.json() as Promise<FlowsResponse>;
}

/** GET /v1/flows/:id - fetch a single flow. */
export async function fetchFlow(id: string): Promise<Flow> {
  const res = await apiFetch(`/v1/flows/${id}`);
  if (!res.ok) {
    throw new Error(`/v1/flows/${id} returned ${res.status}`);
  }
  return res.json() as Promise<Flow>;
}

/**
 * GET /v1/events/names - distinct recent event names for the event-trigger
 * autosuggest. Advisory only: a failure yields an empty list, never an error.
 */
export async function fetchEventNames(): Promise<string[]> {
  const res = await apiFetch("/v1/events/names");
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as { event_names?: unknown };
  return Array.isArray(body.event_names)
    ? body.event_names.filter((n): n is string => typeof n === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Flow mutation types
// ---------------------------------------------------------------------------

export interface FlowFieldError {
  path: string;
  message: string;
}

export interface FlowValidationError {
  error: "Validation failed";
  issues: FlowFieldError[];
}

export type FlowApiError =
  | { kind: "validation"; issues: FlowFieldError[] }
  | { kind: "unprocessable"; message: string }
  | { kind: "unknown"; message: string };

export interface CreateFlowInput {
  name: string;
  trigger_type: Flow["trigger_type"];
  trigger_config: Record<string, unknown>;
  prompt_source?: string;
  content_mode?: Flow["content_mode"];
  steps: [];
  approval_mode?: Flow["approval_mode"];
  flow_class?: Flow["flow_class"];
  priority?: number;
  reentry_policy?: Flow["reentry_policy"];
  reentry_cooldown_days?: number;
  topic_id?: string | null;
  /** Email template of the flow's messages (built-in key or custom id); null = the product's. */
  email_template?: string | null;
}

export interface UpdateFlowInput {
  name?: string;
  trigger_type?: Flow["trigger_type"];
  trigger_config?: Record<string, unknown>;
  prompt_source?: string;
  content_mode?: Flow["content_mode"];
  status?: Flow["status"];
  approval_mode?: Flow["approval_mode"];
  topic_id?: string | null;
  /** Email template of the flow's messages (built-in key or custom id); null = the product's. */
  email_template?: string | null;
  flow_class?: Flow["flow_class"];
  priority?: number;
  reentry_policy?: Flow["reentry_policy"];
  reentry_cooldown_days?: number;
}

function parseFlowError(status: number, body: unknown): FlowApiError {
  if (
    status === 400 &&
    body !== null &&
    typeof body === "object" &&
    "issues" in body &&
    Array.isArray((body as FlowValidationError).issues)
  ) {
    return { kind: "validation", issues: (body as FlowValidationError).issues };
  }
  if (status === 422 && body !== null && typeof body === "object" && "error" in body) {
    return { kind: "unprocessable", message: String((body as { error: string }).error) };
  }
  const msg = body !== null && typeof body === "object" && "error" in body
    ? String((body as { error: string }).error)
    : `HTTP ${status}`;
  return { kind: "unknown", message: msg };
}

/** POST /v1/flows - create a new flow. Throws FlowApiError on failure. */
export async function createFlow(input: CreateFlowInput): Promise<Flow> {
  const res = await apiFetch("/v1/flows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as Flow;
}

/** PATCH /v1/flows/:id - update an existing flow. Throws FlowApiError on failure. */
export async function updateFlow(id: string, input: UpdateFlowInput): Promise<Flow> {
  const res = await apiFetch(`/v1/flows/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as Flow;
}

export interface CompileFlowResponse {
  message: string;
  flow_id: string;
  compile_status: "pending";
}

/**
 * POST /v1/flows/:id/compile - enqueue a compile job. Returns 202 on success.
 * Throws FlowApiError on 422 (archived, no prompt_source, no LLM config) or other failures.
 */
export async function compileFlow(id: string): Promise<CompileFlowResponse> {
  const res = await apiFetch(`/v1/flows/${id}/compile`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as CompileFlowResponse;
}

/**
 * DELETE /v1/flows/:id - archive a flow. This is NOT a physical delete:
 * the server sets status = 'archived' and preserves the compiled plan.
 * Archived is terminal; there is no way back. Idempotent.
 */
export async function archiveFlow(id: string): Promise<Flow> {
  const res = await apiFetch(`/v1/flows/${id}`, { method: "DELETE" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as Flow;
}

/**
 * POST /v1/flows/:id/plan - save a hand-authored compiled plan.
 * Only works for fixed_content flows. The plan is validated server-side.
 */
export async function saveFlowPlan(
  id: string,
  plan: Record<string, unknown>,
): Promise<Flow> {
  const res = await apiFetch(`/v1/flows/${id}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as Flow;
}

/**
 * PUT /v1/flows/:id/steps - write the plan as explicit steps (every step
 * field, conditions with all / any / not). Works for any flow; the plan is
 * stored as compiled. Throws FlowApiError (400 validation, 422 references).
 */
export async function saveFlowSteps(
  id: string,
  plan: { steps: Record<string, unknown>[]; exit_conditions?: unknown[] },
): Promise<Flow> {
  const res = await apiFetch(`/v1/flows/${id}/steps`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as Flow;
}

export interface DraftStepInput {
  step_order: number;
  subject?: string;
  body_html?: string;
  context?: string;
}

// ---------------------------------------------------------------------------
// Flow editor context and step copy
// ---------------------------------------------------------------------------

export interface FlowEditorTemplate {
  slug: string;
  name: string;
  subject: string;
  /** Ids of the (not archived) flows whose plan references the template. */
  used_by_flows: string[];
}

export interface FlowEditorContext {
  links: Array<{ name: string; url: string }>;
  data_sources: string[];
  date_traits: string[];
  has_llm: boolean;
  templates: FlowEditorTemplate[];
}

/** GET /v1/flows/editor-context - pickers for the flow editor. */
export async function fetchFlowEditorContext(): Promise<FlowEditorContext> {
  const res = await apiFetch("/v1/flows/editor-context");
  if (!res.ok) throw new Error(`/v1/flows/editor-context returned ${res.status}`);
  return res.json() as Promise<FlowEditorContext>;
}

export interface StepCopy {
  subject: string;
  body_html: string;
  body_text: string | null;
}

export interface EmailTemplateRow extends StepCopy {
  id: string;
  name: string;
  slug: string;
}

/** GET /v1/email-templates - every template of the product, with content. */
export async function fetchEmailTemplateRows(): Promise<EmailTemplateRow[]> {
  const res = await apiFetch("/v1/email-templates");
  if (!res.ok) throw new Error(`/v1/email-templates returned ${res.status}`);
  const body = (await res.json()) as { templates?: EmailTemplateRow[] };
  return body.templates ?? [];
}

/** PUT /v1/email-templates/by-slug/:slug - create or update a step's fixed copy. */
export async function putEmailTemplateBySlug(slug: string, input: StepCopy & { name?: string }): Promise<EmailTemplateRow> {
  const res = await apiFetch(`/v1/email-templates/by-slug/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as { template?: EmailTemplateRow; error?: string } | null;
  if (!res.ok || !body?.template) throw new Error(body?.error ?? `Saving the email copy failed (${res.status}).`);
  return body.template;
}

export interface DraftStepResult {
  subject: string;
  body_html: string;
}

/**
 * POST /v1/flows/:id/draft-step - ask the AI to draft copy for a step.
 * Returns subject + body_html for the person to edit.
 * Requires an active LLM configuration.
 */
export async function draftFlowStep(
  id: string,
  input: DraftStepInput,
): Promise<DraftStepResult> {
  const res = await apiFetch(`/v1/flows/${id}/draft-step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as DraftStepResult;
}

// ---------------------------------------------------------------------------
// Messages (approval queue)
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  tenant_id: string;
  contact_id: string;
  flow_id: string;
  flow_step_order: number | null;
  status: string;
  subject: string | null;
  body_html: string | null;
  /** The body in the product's branded email shell, as the recipient sees it. */
  preview_html?: string | null;
  body_text: string | null;
  brain_reasoning: string | null;
  brain_action_type: string | null;
  created_at: string;
  updated_at: string;
  contact: {
    email: string | null;
    name: string | null;
    external_id: string | null;
  };
  /** Why an approved message has not gone out yet (send window). */
  waiting_reason?: string | null;
  /** G20 additions. */
  flow?: { name: string | null; class: string | null };
  status_reason?: string | null;
  approved_by?: string | null;
  rejected_by?: string | null;
  edited_by?: string | null;
  edited_at?: string | null;
  original?: { subject: string | null; body_html: string | null; body_text: string | null } | null;
  forced_action_type?: string | null;
  /** P5 additions: data from the step's context sources (G11). */
  context_snapshot?: Record<string, unknown> | null;
  /** G27: the choose step's decision. */
  choose?: {
    choice: string;
    eligible: string[];
    filtered_out: Array<{ action_type: string; reason: string }>;
    reason: string;
    forced?: boolean;
    warning?: string;
    rejected_answers?: string[];
  } | null;
  /** G29: the AI opening line of a fixed template. */
  opening_line?: string | null;
  kb_entry_id?: string | null;
  imported?: boolean;
  /** Revise: the instruction the next draft is applying (null once applied). */
  revision_request?: string | null;
  /** Revise thread, oldest first. */
  revisions?: MessageRevision[];
}

/** One reviewer instruction of a revise thread. */
export interface MessageRevision {
  instruction: string;
  /** "user:<id>" or "api_key:<id>". */
  by: string;
  /** ISO 8601. */
  at: string;
}

export interface MessagesPage {
  messages: Message[];
  next_cursor: string | null;
}

/** GET /v1/messages - cursor-paginated list, pending_approval by default. */
export async function fetchMessages(after?: string, status?: string): Promise<MessagesPage> {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  if (status) params.set("status", status);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/v1/messages${qs}`);
  if (!res.ok) {
    throw new Error(`/v1/messages returned ${res.status}`);
  }
  return res.json() as Promise<MessagesPage>;
}

/** GET /v1/messages?status=failed - generation/send failures needing attention. */
export async function fetchFailedMessages(): Promise<MessagesPage> {
  return fetchMessages(undefined, "failed");
}

/** GET /v1/messages?status=value_gated - drafts the value gate held (flows that send without review). */
export async function fetchHeldMessages(): Promise<MessagesPage> {
  return fetchMessages(undefined, "value_gated");
}

/** POST /v1/messages/:id/release - send a held draft to review. */
export async function releaseMessage(id: string): Promise<void> {
  return messageAction(id, "release");
}

/** POST /v1/messages/:id/dismiss - drop a held draft. */
export async function dismissMessage(id: string): Promise<void> {
  return messageAction(id, "dismiss");
}

/** POST /v1/messages/:id/retry - re-queue a generation-failed message. */
export async function retryMessage(id: string): Promise<void> {
  const res = await apiFetch(`/v1/messages/${id}/retry`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Retry failed (${res.status})`);
  }
}

export interface MessageActionError {
  status: number;
  message: string;
  /** Present on 409: the status the message is actually in now. */
  currentStatus?: string;
}

async function messageAction(
  id: string,
  action: "approve" | "reject" | "regenerate" | "cancel" | "unapprove" | "release" | "dismiss",
  body?: Record<string, unknown>,
): Promise<void> {
  const res = await apiFetch(
    `/v1/messages/${id}/${action}`,
    body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { method: "POST" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      status?: string;
    } | null;
    const err: MessageActionError = {
      status: res.status,
      message: body?.error ?? `HTTP ${res.status}`,
      currentStatus: body?.status,
    };
    throw err;
  }
}

/** POST /v1/messages/:id/approve - CAS pending_approval -> approved. */
export async function approveMessage(id: string): Promise<void> {
  return messageAction(id, "approve");
}

/** POST /v1/messages/:id/reject - CAS pending_approval -> rejected (terminal). */
export async function rejectMessage(id: string): Promise<void> {
  return messageAction(id, "reject");
}

/** POST /v1/messages/:id/regenerate - back to generation, optionally forcing the action type. */
export async function regenerateMessage(id: string, actionType?: string): Promise<void> {
  return messageAction(id, "regenerate", actionType ? { action_type: actionType } : {});
}

/** POST /v1/messages/:id/regenerate with an instruction - the AI revises the current draft. */
export async function reviseMessage(id: string, instruction: string): Promise<void> {
  return messageAction(id, "regenerate", { instruction });
}

/** GET /v1/messages/:id - one message in any status. */
export async function fetchMessage(id: string): Promise<Message> {
  const res = await apiFetch(`/v1/messages/${id}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const err: MessageActionError = { status: res.status, message: body?.error ?? `HTTP ${res.status}` };
    throw err;
  }
  return ((await res.json()) as { message: Message }).message;
}

/** POST /v1/messages/:id/cancel - approved -> cancelled. */
export async function cancelMessage(id: string): Promise<void> {
  return messageAction(id, "cancel");
}

/** POST /v1/messages/:id/unapprove - approved -> pending_approval. */
export async function unapproveMessage(id: string): Promise<void> {
  return messageAction(id, "unapprove");
}

/** PATCH /v1/messages/:id - edit subject and body (Markdown) while pending_approval. */
export async function editMessage(id: string, input: { subject?: string; body_markdown?: string }): Promise<void> {
  const res = await apiFetch(`/v1/messages/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; status?: string } | null;
    const err: MessageActionError = { status: res.status, message: body?.error ?? `HTTP ${res.status}`, currentStatus: body?.status };
    throw err;
  }
}

/** POST /v1/contacts/:id/exclude - suppress the person and cancel their unsent messages. */
export async function excludeContact(contactId: string): Promise<{ suppressed: boolean; cancelled: string[] }> {
  const res = await apiFetch(`/v1/contacts/${contactId}/exclude`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Exclude failed (${res.status})`);
  }
  return res.json() as Promise<{ suppressed: boolean; cancelled: string[] }>;
}

export interface BulkActionResult {
  /** Ids the server actually transitioned. */
  acted: string[];
  /** Ids the server left untouched (wrong status or foreign). */
  skipped: string[];
}

async function bulkMessageAction(
  ids: string[],
  action: "approve" | "reject",
): Promise<BulkActionResult> {
  const res = await apiFetch(`/v1/messages/bulk/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Bulk ${action} failed (${res.status})`);
  }
  const body = (await res.json()) as Record<string, string[]>;
  return {
    acted: body[action === "approve" ? "approved" : "rejected"] ?? [],
    skipped: body.skipped ?? [],
  };
}

/** POST /v1/messages/bulk/approve - CAS pending_approval -> approved for many. */
export async function bulkApproveMessages(ids: string[]): Promise<BulkActionResult> {
  return bulkMessageAction(ids, "approve");
}

/** POST /v1/messages/bulk/reject - CAS pending_approval -> rejected for many. */
export async function bulkRejectMessages(ids: string[]): Promise<BulkActionResult> {
  return bulkMessageAction(ids, "reject");
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KbEntryPreview {
  id: string;
  tenant_id: string;
  title: string;
  content_preview: string;
  content_type: "markdown" | "html" | "text";
  source: "manual" | "crawl" | "upload" | "import";
  source_url: string | null;
  tags: string[];
  embedding_status: "pending" | "failed" | "skipped" | null;
  is_active: boolean;
  /** Category used by kb_select (G18); absent on servers before KB v2. */
  category?: string | null;
  /** Stable key from a KB import; read-only in the dashboard. */
  external_key?: string | null;
  /** Pinned entries always reach the drafting model. */
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

export interface KbEntry extends Omit<KbEntryPreview, "content_preview"> {
  content: string;
  embedding_error: string | null;
  /** Structured source data (KB import); read-only reference. */
  data?: unknown;
}

export interface KbListPage {
  entries: KbEntryPreview[];
  next_cursor: string | null;
}

export interface KbEntryInput {
  title: string;
  content: string;
  content_type?: KbEntry["content_type"];
  source?: KbEntry["source"];
  source_url?: string;
  tags?: string[];
  is_active?: boolean;
  category?: string | null;
  pinned?: boolean;
}

/** GET /v1/kb - cursor-paginated list of previews. */
export async function fetchKbEntries(
  after?: string,
  includeInactive = false,
  limit?: number,
): Promise<KbListPage> {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  if (includeInactive) params.set("include_inactive", "true");
  if (limit) params.set("limit", String(limit));
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/v1/kb${qs}`);
  if (!res.ok) {
    throw new Error(`/v1/kb returned ${res.status}`);
  }
  return res.json() as Promise<KbListPage>;
}

/** GET /v1/kb/:id - full entry. */
export async function fetchKbEntry(id: string): Promise<KbEntry> {
  const res = await apiFetch(`/v1/kb/${id}`);
  if (!res.ok) {
    throw new Error(`/v1/kb/${id} returned ${res.status}`);
  }
  return res.json() as Promise<KbEntry>;
}

/** POST /v1/kb - create an entry. Throws FlowApiError on 400. */
export async function createKbEntry(input: KbEntryInput): Promise<KbEntry> {
  const res = await apiFetch("/v1/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as KbEntry;
}

/** PATCH /v1/kb/:id - partial update. Throws FlowApiError on 400. */
export async function updateKbEntry(
  id: string,
  input: Partial<KbEntryInput>,
): Promise<KbEntry> {
  const res = await apiFetch(`/v1/kb/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as KbEntry;
}

/** DELETE /v1/kb/:id - hard delete (physical removal). */
export async function deleteKbEntry(id: string): Promise<void> {
  const res = await apiFetch(`/v1/kb/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw parseFlowError(res.status, body);
  }
}

export interface ReembedResponse {
  enqueued: number;
  remaining: number;
  total_qualifying: number;
}

/** POST /v1/kb/re-embed - enqueue embedding jobs for failed/orphaned entries. */
export async function reembedKb(): Promise<ReembedResponse> {
  const res = await apiFetch("/v1/kb/re-embed", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as ReembedResponse;
}

/** Response of POST /v1/kb/import. `errors[].index` counts within the request. */
export interface KbImportResponse {
  dry_run: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skipped_edited: number;
  skipped_keys: string[];
  errors: Array<{ index: number; external_key?: string; error: string }>;
}

/**
 * POST /v1/kb/import - upsert entries by external_key. dryRun writes
 * nothing and returns the same counts; force also overwrites entries
 * edited in Claros since their last import. Throws FlowApiError.
 */
export async function importKb(
  entries: unknown[],
  opts: { dryRun: boolean; force: boolean },
): Promise<KbImportResponse> {
  const params = new URLSearchParams();
  if (opts.dryRun) params.set("dry_run", "1");
  if (opts.force) params.set("force", "1");
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/v1/kb/import${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as KbImportResponse;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TransportConfig {
  id: string;
  provider: string;
  from_email: string;
  from_name: string | null;
  daily_limit: number | null;
  dkim_verified: boolean;
  is_active: boolean;
  created_at: string;
}

export interface LlmConfig {
  id: string;
  provider: string;
  model: string | null;
  base_url: string | null;
  embedding_model: string | null;
  is_active: boolean;
  created_at: string;
}

export interface BrandSettingsData {
  brand_name: string | null;
  logo_url: string | null;
  /** The logo's dark-mode version (uploaded or external), or null. */
  logo_dark_url: string | null;
  logo_height: number | null;
  accent_color: string | null;
  footer_text: string | null;
  reply_to: string | null;
  /** Email layout; null means the default, "narrow". */
  layout: "narrow" | "wide" | null;
  /** Email template in use: a built-in key or a custom template id; null = by layout. */
  template?: string | null;
}

export interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  plan: string;
  postal_address: string | null;
  brand: BrandSettingsData;
  created_at: string;
}

export interface TransportInput {
  provider: string;
  from_email: string;
  from_name?: string;
  // Resend fields
  api_key?: string;
  webhook_secret?: string;
  // SMTP fields
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  reject_unauthorized?: boolean;
  // Shared
  daily_limit?: number;
}

export interface LlmInput {
  provider: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  embedding_model?: string;
}

export interface LlmVerification {
  ok: boolean;
  kind?: "http" | "timeout" | "unreachable";
  status?: number | null;
  detail?: string;
}

/** GET /v1/settings/transport - active config, never credentials. */
export async function fetchTransport(): Promise<{ transport: TransportConfig | null }> {
  const res = await apiFetch("/v1/settings/transport");
  if (!res.ok) {
    throw new Error(`/v1/settings/transport returned ${res.status}`);
  }
  return res.json();
}

/** PUT /v1/settings/transport - write/replace (encrypts server-side). */
export async function putTransport(
  input: TransportInput,
): Promise<{ transport: TransportConfig }> {
  const res = await apiFetch("/v1/settings/transport", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Transports (several per product, with routing) and topics
// ---------------------------------------------------------------------------

export type TransportKind = "resend" | "smtp" | "cloudflare";
export type TopicKind = "marketing" | "lifecycle" | "transactional";

export interface TransportItem {
  id: string;
  kind: TransportKind;
  provider: string;
  name: string | null;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  daily_limit: number | null;
  dkim_verified: boolean;
  is_active: boolean;
  created_at: string;
}

export interface TransportRouting {
  transactional: string | null;
  default: string | null;
}

export interface TransportsResponse {
  transports: TransportItem[];
  routing: TransportRouting;
  /** The transport each route resolves to today (routing, else the oldest active transport). */
  effective: TransportRouting;
}

export interface NewTransportInput {
  kind: TransportKind;
  name?: string | null;
  from_email: string;
  from_name?: string | null;
  reply_to?: string | null;
  daily_limit?: number | null;
  api_key?: string;
  webhook_secret?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  reject_unauthorized?: boolean;
  account_id?: string;
  api_token?: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw parseFlowError(res.status, body);
  return body as T;
}

/** GET /v1/settings/transports - active transports and routing, never credentials. */
export async function fetchTransports(): Promise<TransportsResponse> {
  return jsonOrThrow(await apiFetch("/v1/settings/transports"));
}

/** POST /v1/settings/transports - add a transport (credentials encrypted server-side). */
export async function createTransport(input: NewTransportInput): Promise<{ transport: TransportItem }> {
  return jsonOrThrow(
    await apiFetch("/v1/settings/transports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** DELETE /v1/settings/transports/:id - deactivate (kept for history). */
export async function deleteTransport(id: string): Promise<void> {
  await jsonOrThrow(await apiFetch(`/v1/settings/transports/${id}`, { method: "DELETE" }));
}

/** POST /v1/settings/transports/:id/test - branded test email through one transport. */
export async function testTransport(id: string, to: string): Promise<{ sent: boolean; to: string }> {
  return jsonOrThrow(
    await apiFetch(`/v1/settings/transports/${id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    }),
  );
}

/** PUT /v1/settings/transport-routing - null clears a route. */
export async function putTransportRouting(
  routing: Partial<TransportRouting>,
): Promise<{ routing: TransportRouting; effective: TransportRouting; warnings: string[] }> {
  return jsonOrThrow(
    await apiFetch("/v1/settings/transport-routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routing),
    }),
  );
}

export interface Topic {
  id: string;
  slug: string;
  name: string;
  kind: TopicKind;
  description: string | null;
  default_subscribed: boolean;
  /** Consent mirroring only: no flow may send on this topic. Absent on older servers. */
  mirror_only?: boolean;
  created_at: string;
}

export interface TopicInput {
  slug: string;
  name: string;
  kind: TopicKind;
  description?: string | null;
  default_subscribed?: boolean;
  mirror_only?: boolean;
}

/** GET /v1/topics */
export async function fetchTopics(): Promise<{ topics: Topic[] }> {
  return jsonOrThrow(await apiFetch("/v1/topics"));
}

/** POST /v1/topics */
export async function createTopic(input: TopicInput): Promise<{ topic: Topic }> {
  return jsonOrThrow(
    await apiFetch("/v1/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** PATCH /v1/topics/:id (the slug is fixed) */
export async function patchTopic(id: string, input: Partial<Omit<TopicInput, "slug">>): Promise<{ topic: Topic }> {
  return jsonOrThrow(
    await apiFetch(`/v1/topics/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** GET /v1/settings/llm - active config, never credentials. */
export async function fetchLlm(): Promise<{ llm: LlmConfig | null }> {
  const res = await apiFetch("/v1/settings/llm");
  if (!res.ok) {
    throw new Error(`/v1/settings/llm returned ${res.status}`);
  }
  return res.json();
}

/** PUT /v1/settings/llm - verify the key, then write/replace (encrypts server-side). */
export async function putLlm(
  input: LlmInput,
): Promise<{ llm: LlmConfig; verification: LlmVerification }> {
  const res = await apiFetch("/v1/settings/llm", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** The effective embedding provider (GET /v1/settings/embeddings). */
export interface EmbeddingsConfig {
  /** embedding_config = saved in Embeddings; llm_config = served by the chat LLM config. */
  source: "embedding_config" | "llm_config";
  provider: string;
  base_url: string | null;
  model: string | null;
  dimensions: number;
  sends_dimensions: boolean;
  created_at: string;
}

export interface EmbeddingsInput {
  provider: string;
  api_key?: string;
  base_url?: string;
  model?: string;
}

export interface EmbeddingsChange {
  embeddings: EmbeddingsConfig | null;
  vectors_cleared: boolean;
  reembed: { enqueued: number; remaining: number; total_qualifying: number } | null;
}

/** GET /v1/settings/embeddings - effective provider, never credentials. */
export async function fetchEmbeddings(): Promise<{ embeddings: EmbeddingsConfig | null }> {
  const res = await apiFetch("/v1/settings/embeddings");
  if (!res.ok) {
    throw new Error(`/v1/settings/embeddings returned ${res.status}`);
  }
  return res.json();
}

/** PUT /v1/settings/embeddings - verify the endpoint, then write/replace. */
export async function putEmbeddings(input: EmbeddingsInput): Promise<EmbeddingsChange> {
  const res = await apiFetch("/v1/settings/embeddings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** DELETE /v1/settings/embeddings - remove the saved provider. */
export async function deleteEmbeddings(): Promise<EmbeddingsChange> {
  const res = await apiFetch("/v1/settings/embeddings", { method: "DELETE" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** GET /v1/settings/tenant - tenant metadata and postal address. */
export async function fetchTenant(): Promise<{ tenant: TenantSettings }> {
  const res = await apiFetch("/v1/settings/tenant");
  if (!res.ok) {
    throw new Error(`/v1/settings/tenant returned ${res.status}`);
  }
  return res.json();
}

/** PATCH /v1/settings/tenant - update postal address and/or brand settings. */
export async function patchTenant(payload: {
  postal_address?: string;
  brand?: Partial<BrandSettingsData>;
}): Promise<{ tenant: Pick<TenantSettings, "postal_address" | "brand"> }> {
  const res = await apiFetch("/v1/settings/tenant", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** An uploaded brand logo (GET/POST /v1/settings/brand/logo). */
export interface BrandLogo {
  /** Hosted URL with ?v=, as brand.logo_url holds it after an upload. */
  url: string;
  content_type: string;
  width: number;
  height: number;
  /** Bytes. */
  size: number;
  sha256: string;
  updated_at: string;
  /** True when brand.logo_url points at this uploaded logo. */
  in_use: boolean;
}

/** GET /v1/settings/brand/logo - the uploaded logo, or null. */
export async function fetchBrandLogo(): Promise<{ logo: BrandLogo | null }> {
  const res = await apiFetch("/v1/settings/brand/logo");
  if (!res.ok) {
    throw new Error(`/v1/settings/brand/logo returned ${res.status}`);
  }
  return res.json();
}

/** POST /v1/settings/brand/logo - upload a PNG or JPEG (the file is the body). */
export async function uploadBrandLogo(file: File): Promise<{ logo: BrandLogo; brand: BrandSettingsData }> {
  const res = await apiFetch("/v1/settings/brand/logo", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** DELETE /v1/settings/brand/logo - remove the uploaded logo. */
export async function deleteBrandLogo(): Promise<{ deleted: boolean; brand: BrandSettingsData }> {
  const res = await apiFetch("/v1/settings/brand/logo", { method: "DELETE" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** GET /v1/settings/brand/logo-dark - the uploaded dark-mode logo, or null. */
export async function fetchBrandLogoDark(): Promise<{ logo: BrandLogo | null }> {
  const res = await apiFetch("/v1/settings/brand/logo-dark");
  if (!res.ok) {
    throw new Error(`/v1/settings/brand/logo-dark returned ${res.status}`);
  }
  return res.json();
}

/** POST /v1/settings/brand/logo-dark - upload the dark-mode logo (PNG or JPEG body). */
export async function uploadBrandLogoDark(file: File): Promise<{ logo: BrandLogo; brand: BrandSettingsData }> {
  const res = await apiFetch("/v1/settings/brand/logo-dark", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** DELETE /v1/settings/brand/logo-dark - remove the dark-mode logo. */
export async function deleteBrandLogoDark(): Promise<{ deleted: boolean; brand: BrandSettingsData }> {
  const res = await apiFetch("/v1/settings/brand/logo-dark", { method: "DELETE" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body;
}

/** POST /v1/settings/test-email - send a test email using current brand settings. */
export async function sendTestEmail(to: string): Promise<{ sent: boolean; to: string }> {
  const res = await apiFetch("/v1/settings/test-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Send failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Throttle settings
// ---------------------------------------------------------------------------

export interface ThrottleConfig {
  max_emails_per_user_per_day: number;
  max_emails_per_user_per_week: number;
  min_interval_between_emails_hours: number;
  send_window_start: string;
  send_window_end: string;
  send_window_days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  send_window_timezone: "contact_local" | "tenant_fixed";
  tenant_timezone: string | null;
  batch_size_per_tick: number;
  critical_bypass_throttle: boolean;
}

export interface ThrottleInput {
  max_emails_per_user_per_day?: number;
  max_emails_per_user_per_week?: number;
  min_interval_between_emails_hours?: number;
  send_window_start?: string;
  send_window_end?: string;
  send_window_days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  send_window_timezone?: "contact_local" | "tenant_fixed";
  tenant_timezone?: string;
  batch_size_per_tick?: number;
}

/** GET /v1/settings/throttle - current throttle configuration. */
export async function fetchThrottle(): Promise<{ throttle: ThrottleConfig }> {
  const res = await apiFetch("/v1/settings/throttle");
  if (!res.ok) {
    throw new Error(`/v1/settings/throttle returned ${res.status}`);
  }
  return res.json();
}

/** PUT /v1/settings/throttle - update throttle configuration. */
export async function putThrottle(input: ThrottleInput): Promise<{ throttle: ThrottleConfig }> {
  const res = await apiFetch("/v1/settings/throttle", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Update failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Business model templates
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  schema_version: number;
  flow_count: number;
}

export interface ApplyTemplateResponse {
  business_model: string;
  template_name: string;
  flows_created: Array<{ id: string; name: string; status: string }>;
}

/** GET /v1/templates - list available business model templates. */
export async function fetchTemplates(): Promise<{ templates: TemplateSummary[] }> {
  const res = await apiFetch("/v1/templates");
  if (!res.ok) {
    throw new Error(`/v1/templates returned ${res.status}`);
  }
  return res.json();
}

/** POST /v1/templates/:id/apply - apply a template. 409 if already applied. */
export async function applyTemplate(id: string): Promise<ApplyTemplateResponse> {
  const res = await apiFetch(`/v1/templates/${id}/apply`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw parseFlowError(res.status, body);
  }
  return body as ApplyTemplateResponse;
}

// ---------------------------------------------------------------------------
// Contacts (People)
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  tenant_id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  /** Set when the name was edited in the dashboard: identify no longer changes it. */
  name_locked_at?: string | null;
  company: string | null;
  lifecycle_state:
    | "signed_up"
    | "activated"
    | "engaged"
    | "at_risk"
    | "dormant"
    | "gone_quiet"
    // Servers before the gone_quiet rename return churned.
    | "churned"
    | "resurrected";
  engagement_depth: "power" | "regular" | "casual" | "minimal" | null;
  payment_status: string | null;
  /** In the list since sorting; always in the detail. */
  first_seen_at?: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface ContactDetail extends Contact {
  properties: Record<string, unknown> | null;
  first_seen_at: string | null;
  activated_at: string | null;
}

export interface Membership {
  id: string;
  flow_id: string;
  flow_name: string;
  status: string;
  current_step: number;
  entered_at: string;
  completed_at: string | null;
  exited_at: string | null;
  exit_reason: string | null;
}

export interface Suppression {
  id: string;
  reason: string;
  source: string | null;
  created_at: string;
}

/** A contact's status for one topic (G8a); `default` = no explicit choice, the topic default applies. */
export interface ContactTopicStatus {
  topic_id: string;
  slug: string;
  name: string;
  kind: TopicKind;
  status: "subscribed" | "unsubscribed";
  default: boolean;
  source: string | null;
  updated_at: string | null;
}

export interface ContactResponse {
  contact: ContactDetail;
  memberships: Membership[];
  suppression: Suppression | null;
  /** Absent from servers before topics. */
  topics?: ContactTopicStatus[];
}

export interface ContactsPage {
  contacts: Contact[];
  next_cursor: string | null;
  /** Contacts matching the filters across all pages. First page only; absent from older servers. */
  total?: number;
  /** Matches per initial ("a".."z", "#") ignoring the letter filter. First page only; absent from older servers. */
  letters?: Record<string, number>;
}

export type PaymentStatus = "free" | "trial" | "paid" | "past_due" | "cancelled";
export type ContactSortKey = "created" | "name" | "joined" | "last_seen";

export interface ContactFilters {
  lifecycle_state?: Contact["lifecycle_state"];
  engagement_depth?: "power" | "regular" | "casual" | "minimal";
  payment_status?: PaymentStatus;
  tenure_bucket?: "new" | "growing" | "established" | "loyal";
  recency_bucket?: "active" | "cooling" | "idle" | "dormant";
  /** Paid / free split from the Lifecycle page; absent = all. */
  audience?: "paid" | "free";
  search?: string;
  /** "a".."z" or "#". */
  letter?: string;
  /** ISO instants; after is inclusive, before exclusive. */
  joined_after?: string;
  joined_before?: string;
  last_seen_after?: string;
  last_seen_before?: string;
  sort?: ContactSortKey;
  order?: "asc" | "desc";
}

/** GET /v1/contacts - cursor-paginated list with search and filters. */
export async function fetchContacts(
  after: string | undefined,
  filters: ContactFilters,
): Promise<ContactsPage> {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === "string" && v !== "") params.set(k, v);
  }
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/v1/contacts${qs}`);
  if (!res.ok) {
    throw new Error(`/v1/contacts returned ${res.status}`);
  }
  return res.json() as Promise<ContactsPage>;
}

/** GET /v1/contacts/:id - contact, memberships, suppression. */
export async function fetchContact(id: string): Promise<ContactResponse> {
  const res = await apiFetch(`/v1/contacts/${id}`);
  if (!res.ok) {
    throw new Error(`/v1/contacts/${id} returned ${res.status}`);
  }
  return res.json() as Promise<ContactResponse>;
}

/** DELETE /v1/contacts/:id - erase the person (owner only). */
export async function deleteContact(id: string): Promise<void> {
  const res = await apiFetch(`/v1/contacts/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete failed (${res.status})`);
  }
}

/** A note a team member wrote about a person. */
export interface ContactNote {
  id: string;
  body: string;
  created_at: string;
  author: { id: string; name: string | null; email: string | null } | null;
}

/** GET /v1/contacts/:id/notes - newest first. */
export async function fetchContactNotes(id: string): Promise<{ items: ContactNote[] }> {
  const res = await apiFetch(`/v1/contacts/${id}/notes`);
  if (!res.ok) throw new Error(`/v1/contacts/${id}/notes returned ${res.status}`);
  return res.json() as Promise<{ items: ContactNote[] }>;
}

/** POST /v1/contacts/:id/notes */
export async function addContactNote(id: string, body: string): Promise<ContactNote> {
  const res = await apiFetch(`/v1/contacts/${id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Saving the note failed (${res.status})`);
  }
  return res.json() as Promise<ContactNote>;
}

/**
 * PUT /v1/contacts/:id/name with a name sets and locks it; DELETE (name null)
 * clears the lock so identify sets the name again.
 */
export async function setContactName(id: string, name: string | null): Promise<void> {
  const res = await apiFetch(`/v1/contacts/${id}/name`, name === null
    ? { method: "DELETE" }
    : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Saving the name failed (${res.status})`);
  }
}

/** PUT /v1/contacts/:id/topics - set topic subscriptions by slug. */
export async function setContactTopics(id: string, topics: Record<string, boolean>): Promise<{ topics: ContactTopicStatus[] }> {
  const res = await apiFetch(`/v1/contacts/${id}/topics`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topics }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Changing the subscription failed (${res.status})`);
  }
  return res.json() as Promise<{ topics: ContactTopicStatus[] }>;
}

/** DELETE /v1/contacts/:id/notes/:noteId */
export async function deleteContactNote(id: string, noteId: string): Promise<void> {
  const res = await apiFetch(`/v1/contacts/${id}/notes/${noteId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Deleting the note failed (${res.status})`);
}

export type TimelineItem =
  | {
      kind: "event";
      id: string;
      occurred_at: string;
      event_type: string;
      event_name: string | null;
      properties: Record<string, unknown> | null;
      /** Client context captured at ingest (device, browser, ip, etc). */
      context: Record<string, unknown> | null;
    }
  | {
      kind: "transition";
      id: string;
      occurred_at: string;
      from_state: string;
      to_state: string;
      /** What caused the transition (e.g. { trigger: "scan" }). */
      metadata: Record<string, unknown> | null;
    }
  | {
      kind: "message";
      id: string;
      occurred_at: string;
      subject: string | null;
      status: string;
      feedback: string | null;
      flow_id: string;
      flow_name: string;
      flow_step_order: number | null;
    };

export interface TimelinePage {
  items: TimelineItem[];
  next_cursor: string | null;
}

/** GET /v1/contacts/:id/timeline - merged timeline, newest first. */
export async function fetchContactTimeline(
  id: string,
  after?: string,
): Promise<TimelinePage> {
  const qs = after ? `?after=${encodeURIComponent(after)}` : "";
  const res = await apiFetch(`/v1/contacts/${id}/timeline${qs}`);
  if (!res.ok) {
    throw new Error(`/v1/contacts/${id}/timeline returned ${res.status}`);
  }
  return res.json() as Promise<TimelinePage>;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface LifecycleDistributionRow {
  state: string;
  total: number;
  power: number;
  regular: number;
  casual: number;
  minimal: number;
  unset: number;
}

export interface LifecycleMovement {
  per_state: Array<{ state: string; entered: number; exited: number }>;
  edges: Array<{ from_state: string; to_state: string; count: number }>;
  days: Array<{ day: string; count: number; positive: number; negative: number }>;
}

/**
 * Who a Lifecycle read covers, by the contact's current payment_status:
 * paid = paid or past_due, free = every other value. paid + free = all.
 */
export type ContactAudience = "all" | "paid" | "free";

export interface LifecycleAnalytics {
  range_days: number;
  audience: ContactAudience;
  contacts_total: number;
  distribution: LifecycleDistributionRow[];
  movement: LifecycleMovement;
}

export interface SendingTotals {
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  suppressed: number;
  failed: number;
}

export interface SendingPerFlow extends SendingTotals {
  flow_id: string;
  flow_name: string;
}

export interface SendingAnalytics {
  range_days: number;
  days: Array<{ day: string; sent: number }>;
  engagement_days: Array<{ day: string; opens: number; clicks: number; bounces: number }>;
  /** ISO date string: the earliest event in message_events, or null if no events exist. */
  engagement_since: string | null;
  totals: SendingTotals;
  per_flow: SendingPerFlow[];
}

/** GET /v1/analytics/lifecycle?days=N&audience=A - distribution + movement. */
export async function fetchLifecycleAnalytics(
  days: number,
  audience: ContactAudience = "all",
): Promise<LifecycleAnalytics> {
  const res = await apiFetch(`/v1/analytics/lifecycle?days=${days}&audience=${audience}`);
  if (!res.ok) {
    throw new Error(`/v1/analytics/lifecycle returned ${res.status}`);
  }
  return res.json() as Promise<LifecycleAnalytics>;
}

/** GET /v1/analytics/sending?days=N - sending performance over time and per flow. */
export async function fetchSendingAnalytics(days: number): Promise<SendingAnalytics> {
  const res = await apiFetch(`/v1/analytics/sending?days=${days}`);
  if (!res.ok) {
    throw new Error(`/v1/analytics/sending returned ${res.status}`);
  }
  return res.json() as Promise<SendingAnalytics>;
}

export interface RetentionGridCell {
  tenure: string;
  recency: string;
  count: number;
  paying: number;
}

export interface RetentionGrid {
  natural_frequency_days: number;
  tenure_thresholds_days: { growing: number; established: number; loyal: number };
  recency_thresholds_days: { cooling: number; idle: number; dormant: number };
  cells: RetentionGridCell[];
  contacts_total: number;
}

/** GET /v1/analytics/retention-grid - tenure x recency cell counts. */
export async function fetchRetentionGrid(): Promise<RetentionGrid> {
  const res = await apiFetch(`/v1/analytics/retention-grid`);
  if (!res.ok) {
    throw new Error(`/v1/analytics/retention-grid returned ${res.status}`);
  }
  return res.json() as Promise<RetentionGrid>;
}

export interface RetentionGridCellTrend {
  range_days: number;
  days: Array<{ day: string; count: number; paying: number }>;
}

/** GET /v1/analytics/retention-grid/:tenure/:recency/trend?days=N - daily cell population. */
export async function fetchRetentionGridCellTrend(
  tenure: string,
  recency: string,
  days: number,
): Promise<RetentionGridCellTrend> {
  const res = await apiFetch(
    `/v1/analytics/retention-grid/${tenure}/${recency}/trend?days=${days}`,
  );
  if (!res.ok) {
    throw new Error(
      `/v1/analytics/retention-grid/${tenure}/${recency}/trend returned ${res.status}`,
    );
  }
  return res.json() as Promise<RetentionGridCellTrend>;
}

// ---------------------------------------------------------------------------
// Ingestion (Integrate screen)
// ---------------------------------------------------------------------------

export type ApiKeyKind = "publishable" | "secret" | "admin";

/** Management scopes of an admin key (G1). */
export const ADMIN_KEY_SCOPES = ["config", "suppressions", "messages", "contacts:read", "contacts:delete", "broadcasts", "kb", "events"] as const;

export interface IngestKey {
  id: string;
  kind: ApiKeyKind;
  prefix: string;
  label: string | null;
  allowed_origins: string[];
  /** Admin keys only. */
  scopes?: string[];
  last_used_at: string | null;
  created_at: string | null;
  revoked_at: string | null;
}

export interface CreatedIngestKey extends IngestKey {
  /** The raw key value. Returned by the create endpoint exactly once. */
  key: string;
}

export interface IngestStatus {
  last_event: {
    type: string;
    event_name: string | null;
    user_id: string;
    received_at: string;
  } | null;
  events_last_24h: number;
}

/** GET /v1/ingestion/keys - all keys for the tenant (never raw values). */
export async function fetchIngestKeys(): Promise<{ keys: IngestKey[] }> {
  const res = await apiFetch(`/v1/ingestion/keys`);
  if (!res.ok) {
    throw new Error(`/v1/ingestion/keys returned ${res.status}`);
  }
  return res.json() as Promise<{ keys: IngestKey[] }>;
}

/** POST /v1/ingestion/keys - create a key. Raw value is in the response once. */
export async function createIngestKey(input: {
  kind: ApiKeyKind;
  label?: string;
  allowed_origins?: string[];
  scopes?: string[];
}): Promise<CreatedIngestKey> {
  const res = await apiFetch(`/v1/ingestion/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Create key failed (${res.status})`);
  }
  return res.json() as Promise<CreatedIngestKey>;
}

/** PATCH /v1/ingestion/keys/:id - update label and/or allowed_origins. */
export async function updateIngestKey(
  id: string,
  input: { label?: string | null; allowed_origins?: string[] },
): Promise<IngestKey> {
  const res = await apiFetch(`/v1/ingestion/keys/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Update key failed (${res.status})`);
  }
  return res.json() as Promise<IngestKey>;
}

/** POST /v1/ingestion/keys/:id/revoke - revoke a key (idempotent). */
export async function revokeIngestKey(id: string): Promise<void> {
  const res = await apiFetch(`/v1/ingestion/keys/${id}/revoke`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Revoke key failed (${res.status})`);
  }
}

/** GET /v1/ingestion/status - last received event + 24h count. */
export async function fetchIngestStatus(): Promise<IngestStatus> {
  const res = await apiFetch(`/v1/ingestion/status`);
  if (!res.ok) {
    throw new Error(`/v1/ingestion/status returned ${res.status}`);
  }
  return res.json() as Promise<IngestStatus>;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticsKeyInfo {
  present: boolean;
  byteLength: number | null;
  fingerprint: string | null;
  decodeError: string | null;
}

export interface DiagnosticsResponse {
  commit: string;
  edition: string;
  builtAt: string | null;
  startedAt: string;
  keys: {
    ENCRYPTION_KEY: DiagnosticsKeyInfo;
    UNSUBSCRIBE_SIGNING_KEY: DiagnosticsKeyInfo;
  };
}

/** GET /v1/diagnostics - deployment health and key presence. */
export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await apiFetch(`/v1/diagnostics`);
  if (!res.ok) {
    throw new Error(`/v1/diagnostics returned ${res.status}`);
  }
  return res.json() as Promise<DiagnosticsResponse>;
}

// ---------------------------------------------------------------------------
// Library flows
// ---------------------------------------------------------------------------

export interface LibraryFlowTemplate {
  slug: string;
  name: string;
  subject: string;
}

export interface LibraryFlowEntry {
  id: string;
  name: string;
  description: string;
  emails: number;
  trigger: string;
  templates: LibraryFlowTemplate[];
}

export interface LibraryFlowsResponse {
  flows: LibraryFlowEntry[];
}

export interface LibraryInstallResponse {
  message: string;
  flowId: string;
  templatesCreated: number;
  flowCreated: boolean;
}

/** GET /v1/library - list available library flow sets. */
export async function fetchLibraryFlows(): Promise<LibraryFlowsResponse> {
  const res = await apiFetch(`/v1/library`);
  if (!res.ok) {
    throw new Error(`/v1/library returned ${res.status}`);
  }
  return res.json() as Promise<LibraryFlowsResponse>;
}

/** POST /v1/library/install - install the welcome flow set. */
export async function installLibraryFlow(): Promise<LibraryInstallResponse> {
  const res = await apiFetch(`/v1/library/install`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Install failed (${res.status})`);
  }
  return res.json() as Promise<LibraryInstallResponse>;
}

// ---------------------------------------------------------------------------
// Sent-mail log
// ---------------------------------------------------------------------------

export interface SentLogMessage {
  id: string;
  contact_id: string;
  flow_id: string;
  flow_name: string | null;
  status: string;
  feedback: string | null;
  subject: string | null;
  recipient_address: string | null;
  sent_at: string | null;
  created_at: string | null;
  contact: {
    email: string | null;
    name: string | null;
    external_id: string | null;
  };
}

export interface SentLogPage {
  messages: SentLogMessage[];
  next_cursor: string | null;
  /** Set when the list was requested by page number. */
  page?: number;
  page_size?: number;
  total?: number;
}

export interface SentLogFilters {
  status?: string;
  flow_id?: string;
  recipient?: string;
  from?: string;
  to?: string;
  feedback?: string;
}

/** GET /v1/sent-log?page=<n> - one numbered page of the sent-mail log, with the total. */
export async function fetchSentLog(
  page: number,
  filters: SentLogFilters,
  limit?: number,
): Promise<SentLogPage> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  if (limit) params.set("limit", String(limit));
  if (filters.status) params.set("status", filters.status);
  if (filters.flow_id) params.set("flow_id", filters.flow_id);
  if (filters.recipient) params.set("recipient", filters.recipient);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.feedback) params.set("feedback", filters.feedback);
  const res = await apiFetch(`/v1/sent-log?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`/v1/sent-log returned ${res.status}`);
  }
  return res.json() as Promise<SentLogPage>;
}

export interface MessageEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
}

export interface SentLogDetailResponse {
  message: {
    id: string;
    contact_id: string;
    flow_id: string;
    flow_name: string | null;
    membership_id: string;
    flow_step_order: number | null;
    status: string;
    feedback: string | null;
    subject: string | null;
    body_html: string | null;
    /** The body in the email template, as the recipient's client showed it. */
    preview_html: string | null;
    /** The inbox preview line the step set, if any. */
    preheader: string | null;
    body_text: string | null;
    brain_reasoning: string | null;
    brain_action_type: string | null;
    scheduled_send_at: string | null;
    approved_at: string | null;
    sent_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    retry_count: number;
    provider_message_id: string | null;
    recipient_address: string | null;
    /** The template the step renders from (current plan), null for AI-drafted steps. */
    template_ref: string | null;
    contact: {
      email: string | null;
      name: string | null;
      external_id: string | null;
    };
  };
  events: MessageEvent[];
}

/** GET /v1/sent-log/:id - single message detail with event timeline. */
export async function fetchSentLogDetail(id: string): Promise<SentLogDetailResponse> {
  const res = await apiFetch(`/v1/sent-log/${id}`);
  if (!res.ok) {
    throw new Error(`/v1/sent-log/${id} returned ${res.status}`);
  }
  return res.json() as Promise<SentLogDetailResponse>;
}

// ---------------------------------------------------------------------------
// Suppressions (list + import)
// ---------------------------------------------------------------------------

export interface SuppressionListItem {
  id: string;
  email: string;
  reason: string;
  source: string | null;
  created_at: string;
}

export interface SuppressionsPage {
  suppressions: SuppressionListItem[];
  next_cursor: string | null;
}

export interface SuppressionImportResult {
  imported: number;
  skipped: number;
  invalid: number;
  total_rows: number;
}

/** GET /v1/suppressions - cursor-paginated suppression list. */
export async function fetchSuppressions(after?: string): Promise<SuppressionsPage> {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/v1/suppressions${qs}`);
  if (!res.ok) {
    throw new Error(`/v1/suppressions returned ${res.status}`);
  }
  return res.json() as Promise<SuppressionsPage>;
}

/** POST /v1/suppressions/import - import suppression list (text/csv body). */
export async function importSuppressions(body: string): Promise<SuppressionImportResult> {
  const res = await apiFetch(`/v1/suppressions/import`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Import failed (${res.status})`);
  }
  return res.json() as Promise<SuppressionImportResult>;
}

export interface SuppressionAddResult {
  email: string;
  added: boolean;
}

/** POST /v1/suppressions - manually suppress a single address. */
export async function addSuppression(email: string): Promise<SuppressionAddResult> {
  const res = await apiFetch(`/v1/suppressions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Add failed (${res.status})`);
  }
  return res.json() as Promise<SuppressionAddResult>;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface Profile {
  id: string;
  email: string;
  name: string | null;
  role: string;
  pending_email: string | null;
  created_at: string;
}

/** GET /v1/profile */
export async function fetchProfile(): Promise<{ profile: Profile }> {
  const res = await apiFetch("/v1/profile");
  if (!res.ok) throw new Error(`/v1/profile returned ${res.status}`);
  return res.json() as Promise<{ profile: Profile }>;
}

/** PATCH /v1/profile - update name */
export async function updateProfile(data: { name?: string | null }): Promise<{ ok: boolean }> {
  const res = await apiFetch("/v1/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Update failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}

/** POST /v1/profile/email - request email change */
export async function requestEmailChange(email: string): Promise<{ ok: boolean; message: string; verify_url?: string }> {
  const res = await apiFetch("/v1/profile/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean; message: string; verify_url?: string }>;
}

/** POST /v1/profile/email/verify - confirm email change */
export async function verifyEmailChange(token: string): Promise<{ ok: boolean; email: string }> {
  const res = await apiFetch("/v1/profile/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Verification failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean; email: string }>;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteResult {
  invite: {
    id: string;
    email: string;
    role: string;
    expires_at: string;
    invite_url: string;
    email_sent: boolean;
  };
}

/** GET /v1/team */
export async function fetchTeamMembers(): Promise<{ members: TeamMember[] }> {
  const res = await apiFetch("/v1/team");
  if (!res.ok) throw new Error(`/v1/team returned ${res.status}`);
  return res.json() as Promise<{ members: TeamMember[] }>;
}

/** POST /v1/team/invites */
export async function createInvite(email: string, role?: string): Promise<InviteResult> {
  const res = await apiFetch("/v1/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Invite failed (${res.status})`);
  }
  return res.json() as Promise<InviteResult>;
}

/** GET /v1/team/invites */
export async function fetchInvites(): Promise<{ invites: Invite[] }> {
  const res = await apiFetch("/v1/team/invites");
  if (!res.ok) throw new Error(`/v1/team/invites returned ${res.status}`);
  return res.json() as Promise<{ invites: Invite[] }>;
}

/** DELETE /v1/team/invites/:id */
export async function revokeInvite(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/v1/team/invites/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Revoke failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}

/** PATCH /v1/team/:id/role */
export async function changeRole(id: string, role: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/v1/team/${id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Role change failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}

/** DELETE /v1/team/:id */
export async function removeMember(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/v1/team/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Remove failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// Products (multi-product instances)
// ---------------------------------------------------------------------------

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  role: string;
  archived: boolean;
  /** Host for the product's public pages (unsubscribe, preferences), or null. */
  public_host: string | null;
  /** The product's brand logo URL (uploaded or external), or null. */
  logo_url: string | null;
}

export interface ProductsResponse {
  products: ProductSummary[];
  /** True for instance admins (they see and manage every product). */
  instance_admin: boolean;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  locale: string | null;
  public_host: string | null;
  archived: boolean;
  archived_at: string | null;
  created_at: string | null;
}

async function productError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; issues?: Array<{ path: string; message: string }> }
    | null;
  if (body?.issues?.length) {
    return new Error(body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
  }
  return new Error(body?.error ?? `${fallback} (${res.status})`);
}

/** GET /v1/products - products the signed-in user can act on. */
export async function fetchProducts(): Promise<ProductsResponse> {
  const res = await apiFetch("/v1/products");
  if (!res.ok) throw new Error(`/v1/products returned ${res.status}`);
  return res.json() as Promise<ProductsResponse>;
}

/** POST /v1/products - create a product (instance admins). */
export async function createProduct(input: { name: string; slug: string; locale?: string | null }): Promise<Product> {
  const res = await apiFetch("/v1/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await productError(res, "Could not create the product");
  return ((await res.json()) as { product: Product }).product;
}

/** POST /v1/products/:slug/archive or /unarchive (instance admins). */
export async function setProductArchived(slug: string, archived: boolean): Promise<Product> {
  const res = await apiFetch(`/v1/products/${encodeURIComponent(slug)}/${archived ? "archive" : "unarchive"}`, {
    method: "POST",
  });
  if (!res.ok) throw await productError(res, "Could not update the product");
  return ((await res.json()) as { product: Product }).product;
}

// ---------------------------------------------------------------------------
// Instance health and alerts (instance admins)
// ---------------------------------------------------------------------------

export interface OpsProductRef {
  id: string;
  slug: string | null;
  name: string | null;
}

export interface OpsAlert {
  fingerprint: string;
  kind: string;
  severity: "warning" | "error" | "critical" | string;
  message: string;
  product: OpsProductRef | null;
  status: "open" | "resolved" | string;
  count: number;
  first_at: string;
  last_at: string;
  last_notified_at: string | null;
  muted_until: string | null;
}

export interface OpsEvent {
  id: string;
  at: string;
  kind: string;
  severity: string;
  message: string;
  fingerprint: string;
  product: OpsProductRef | null;
  context: unknown;
}

export interface HealthTick {
  name: string;
  last_run_at: string | null;
  interval_minutes: number;
  late: boolean;
}

export interface HealthResponse {
  now: string;
  alerts: { open: OpsAlert[]; recently_resolved: OpsAlert[] };
  events: OpsEvent[];
  ticks: HealthTick[];
  failed_jobs_24h: number;
  settings: { email: string | null; default_email: string | null; enabled: boolean; via_product: string | null };
}

/** GET /v1/instance/health (instance admins). */
export async function fetchHealth(): Promise<HealthResponse> {
  const res = await apiFetch("/v1/instance/health");
  if (!res.ok) throw await productError(res, "Could not load health");
  return res.json() as Promise<HealthResponse>;
}

/** POST /v1/instance/alerts/:fingerprint/resolve (instance admins). */
export async function resolveOpsAlert(fingerprint: string): Promise<OpsAlert> {
  const res = await apiFetch(`/v1/instance/alerts/${encodeURIComponent(fingerprint)}/resolve`, { method: "POST" });
  if (!res.ok) throw await productError(res, "Could not resolve the alert");
  return ((await res.json()) as { alert: OpsAlert }).alert;
}

/** POST /v1/instance/alerts/:fingerprint/mute (instance admins). */
export async function muteOpsAlert(fingerprint: string, hours: number): Promise<OpsAlert> {
  const res = await apiFetch(`/v1/instance/alerts/${encodeURIComponent(fingerprint)}/mute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hours }),
  });
  if (!res.ok) throw await productError(res, "Could not mute the alert");
  return ((await res.json()) as { alert: OpsAlert }).alert;
}

/** PUT /v1/instance/settings/:key (instance admins). */
export async function putInstanceSetting(key: string, value: unknown): Promise<void> {
  const res = await apiFetch(`/v1/instance/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw await productError(res, "Could not save the setting");
}

// ---------------------------------------------------------------------------
// Instance keys (instance admins): clr_ik_ keys for instance automation
// ---------------------------------------------------------------------------

export interface InstanceKey {
  id: string;
  kind: "instance";
  prefix: string;
  label: string | null;
  scopes: string[];
  last_used_at: string | null;
  created_at: string | null;
  revoked_at: string | null;
}

/** GET /v1/instance/keys (instance admins). */
export async function fetchInstanceKeys(): Promise<{ keys: InstanceKey[]; scopes: string[] }> {
  const res = await apiFetch("/v1/instance/keys");
  if (!res.ok) throw await productError(res, "Could not load instance keys");
  return res.json() as Promise<{ keys: InstanceKey[]; scopes: string[] }>;
}

/** POST /v1/instance/keys (instance admins). The raw key is returned once. */
export async function createInstanceKey(input: { label?: string; scopes: string[] }): Promise<InstanceKey & { key: string }> {
  const res = await apiFetch("/v1/instance/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await productError(res, "Could not create the key");
  return res.json() as Promise<InstanceKey & { key: string }>;
}

/** POST /v1/instance/keys/:id/revoke (instance admins). */
export async function revokeInstanceKey(id: string): Promise<void> {
  const res = await apiFetch(`/v1/instance/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  if (!res.ok) throw await productError(res, "Could not revoke the key");
}

// ---------------------------------------------------------------------------
// Email templates (layouts) and the template studio
// ---------------------------------------------------------------------------

export type LayoutWidth = "narrow" | "wide";

export interface LayoutFinding {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  clients: string[];
  fix: string;
}

export interface LayoutSummary {
  /** Built-in key or custom template id. */
  ref: string;
  kind: "builtin" | "custom";
  id: string | null;
  name: string;
  description: string | null;
  width: LayoutWidth;
  based_on: string | null;
  in_use: boolean;
  /** Flows that set this template; absent from servers before per-flow templates. */
  flow_count?: number;
  created_at: string | null;
  updated_at: string | null;
  preview_html?: string;
}

export interface LayoutDetail extends LayoutSummary {
  source: string;
}

export type StudioDecision = "applied" | "proposed" | "answered" | "off_topic" | "failed";

export interface StudioTurn {
  role: "user" | "assistant";
  content: string;
}

export interface StudioResult {
  decision: StudioDecision;
  reply: string;
  source: string | null;
  findings: LayoutFinding[];
  new_findings: string[];
  preview_html: string | null;
}

/** Error with the API's message and, for 422 saves, the findings. */
export class LayoutApiError extends Error {
  constructor(message: string, readonly status: number, readonly findings: LayoutFinding[] = []) {
    super(message);
  }
}

async function layoutJson<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; findings?: LayoutFinding[] };
  throw new LayoutApiError(body.error ?? `Request failed (${res.status})`, res.status, body.findings ?? []);
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchLayouts(previews: boolean): Promise<{ active: string; templates: LayoutSummary[] }> {
  return layoutJson(await apiFetch(`/v1/layouts${previews ? "?previews=true" : ""}`));
}

export async function fetchLayout(ref: string): Promise<{ template: LayoutDetail; findings: LayoutFinding[]; preview_html: string }> {
  return layoutJson(await apiFetch(`/v1/layouts/${encodeURIComponent(ref)}`));
}

export async function createLayout(input: { name: string; description?: string | null; width: LayoutWidth; source: string; based_on?: string | null }): Promise<{ template: LayoutDetail; findings: LayoutFinding[] }> {
  return layoutJson(await apiFetch("/v1/layouts", jsonInit("POST", input)));
}

export async function updateLayout(id: string, input: { name?: string; description?: string | null; width?: LayoutWidth; source?: string }): Promise<{ template: LayoutDetail; findings: LayoutFinding[] }> {
  return layoutJson(await apiFetch(`/v1/layouts/${encodeURIComponent(id)}`, jsonInit("PUT", input)));
}

export async function deleteLayout(id: string): Promise<void> {
  return layoutJson(await apiFetch(`/v1/layouts/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function setActiveLayout(ref: string): Promise<{ active: string }> {
  return layoutJson(await apiFetch("/v1/layouts/active", jsonInit("PUT", { template: ref })));
}

export async function previewLayout(source: string, width: LayoutWidth): Promise<{ html: string; findings: LayoutFinding[] }> {
  return layoutJson(await apiFetch("/v1/layouts/preview", jsonInit("POST", { source, width })));
}

export async function assistLayout(input: { source: string; width: LayoutWidth; message: string; history: StudioTurn[] }): Promise<StudioResult> {
  return layoutJson(await apiFetch("/v1/layouts/assist", jsonInit("POST", input)));
}
