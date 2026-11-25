/**
 * P5b: contact.subscribed / contact.unsubscribed outbox entries for topic
 * statuses set through identify `topics`, one per topic whose effective
 * status (explicit status, else the topic default) changed.
 */
import type { OutboxEntry } from "../areas/shared-outbox.js";

export interface TopicStatusBefore {
  topicId: string;
  slug: string;
  defaultSubscribed: boolean;
  status: string | null;
}

export function identifyTopicEvents(
  contact: { id: string; email: string | null },
  before: readonly TopicStatusBefore[],
  wanted: Record<string, boolean>,
  applied: readonly string[],
): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const slug of applied) {
    const prev = before.find((t) => t.slug === slug);
    if (!prev) continue;
    const was = prev.status ?? (prev.defaultSubscribed ? "subscribed" : "unsubscribed");
    const next = wanted[slug] ? "subscribed" : "unsubscribed";
    if (was === next) continue;
    out.push({
      event: next === "subscribed" ? "contact.subscribed" : "contact.unsubscribed",
      payload: { contact_id: contact.id, email: contact.email, scope: "topic", topic: slug, topic_id: prev.topicId, source: "identify" },
    });
  }
  return out;
}
