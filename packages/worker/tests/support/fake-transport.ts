/**
 * Fake transports for engine tests (nothing leaves the process): a resend
 * and a cloudflare adapter that record what they were asked to send, and a
 * resolver that routes transactional mail to the cloudflare one.
 */
import { randomUUID } from "node:crypto";
import type { TransportSendParams } from "@claros/adapters";
import type { TenantTransportAdapter, TransportResolver } from "../../src/transport.js";

export interface SentMail extends TransportSendParams {
  transport: string;
}

export interface FakeTransports {
  sent: SentMail[];
  resolver: (tenantIds: string[]) => TransportResolver;
}

function adapter(kind: "resend" | "cloudflare", sent: SentMail[]): TenantTransportAdapter {
  return {
    transportInfo: {
      id: randomUUID(),
      kind,
      fromEmail: kind === "cloudflare" ? "hello@send.product.example" : "hello@product.example",
      fromName: "Product",
      replyTo: null,
      dailyLimit: null,
    },
    async send(params) {
      sent.push({ ...params, transport: kind });
      return { success: true, providerMessageId: `pm-${randomUUID()}` };
    },
  } as TenantTransportAdapter;
}

export function fakeTransports(): FakeTransports {
  const sent: SentMail[] = [];
  const resend = adapter("resend", sent);
  const cloudflare = adapter("cloudflare", sent);
  return {
    sent,
    resolver: (tenantIds) => async (tenantId, route) =>
      tenantIds.includes(tenantId) ? (route === "transactional" ? cloudflare : resend) : null,
  };
}
