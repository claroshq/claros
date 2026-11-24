/**
 * In-process request helper with the shape of v0.6's `app.inject()`.
 *
 * Used by the test suites (and by `claros doctor`-style tooling) to call the
 * API without opening a socket. It wraps Hono's `app.request()` and returns
 * the response fields the v0.6 tests read: statusCode, headers, body/payload,
 * json(), cookies.
 */
import type { Hono } from "hono";

export interface InjectOptions {
  method?: string;
  url: string;
  /** Object -> JSON with application/json; string or Buffer -> sent as is. */
  payload?: unknown;
  /** Alias of payload. */
  body?: unknown;
  headers?: Record<string, string | undefined>;
  cookies?: Record<string, string>;
  query?: Record<string, string>;
}

export interface InjectedCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  payload: string;
  json<T = any>(): T;
  cookies: InjectedCookie[];
}

function parseSetCookie(header: string): InjectedCookie {
  const [pair, ...attrs] = header.split(";");
  const eq = pair!.indexOf("=");
  const cookie: InjectedCookie = {
    name: pair!.slice(0, eq).trim(),
    value: decodeURIComponent(pair!.slice(eq + 1).trim()),
  };
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.trim().split("=");
    const key = rawKey!.toLowerCase();
    const value = rest.join("=");
    if (key === "path") cookie.path = value;
    else if (key === "domain") cookie.domain = value;
    else if (key === "expires") cookie.expires = new Date(value);
    else if (key === "max-age") cookie.maxAge = Number(value);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = value;
  }
  return cookie;
}

export async function inject(app: Hono<any>, opts: InjectOptions | string): Promise<InjectResponse> {
  const o: InjectOptions = typeof opts === "string" ? { url: opts } : opts;
  const method = (o.method ?? "GET").toUpperCase();

  const url = new URL(o.url, "http://localhost");
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);

  const headers = new Headers();
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v !== undefined) headers.set(k, v);
  }
  if (o.cookies && Object.keys(o.cookies).length > 0) {
    const jar = Object.entries(o.cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");
    const existing = headers.get("cookie");
    headers.set("cookie", existing ? `${existing}; ${jar}` : jar);
  }

  const raw = o.payload ?? o.body;
  let body: string | Uint8Array | undefined;
  if (raw !== undefined && raw !== null) {
    // Send strings as bytes: a string body would make Request add a
    // text/plain Content-Type the caller did not set.
    if (typeof raw === "string") body = new TextEncoder().encode(raw);
    else if (raw instanceof Uint8Array) body = raw;
    else {
      body = JSON.stringify(raw);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  if (body !== undefined) headers.set("content-length", String(Buffer.byteLength(body)));

  const res = await app.request(url.pathname + url.search, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });

  const text = method === "HEAD" ? "" : await res.text();
  const outHeaders: Record<string, string | string[]> = {};
  res.headers.forEach((value, key) => {
    if (key !== "set-cookie") outHeaders[key] = value;
  });
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length === 1) outHeaders["set-cookie"] = setCookies[0]!;
  else if (setCookies.length > 1) outHeaders["set-cookie"] = setCookies;

  return {
    statusCode: res.status,
    headers: outHeaders,
    body: text,
    payload: text,
    json: () => JSON.parse(text),
    cookies: setCookies.map(parseSetCookie),
  };
}
