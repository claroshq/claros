/**
 * Topic of a flow (G8a): its messages are gated by the contact's topic
 * status, and transactional topics change List-Unsubscribe and routing.
 * Saved on change; shown only when the product has topics.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Flow } from "../api.js";
import { useUpdateFlow } from "../flows.js";
import { useTopics } from "../topics-transports.js";
import { Select } from "./ui/select.js";

export function FlowTopicPicker({ flow, disabled }: { flow: Flow; disabled?: boolean }) {
  const topics = useTopics();
  const update = useUpdateFlow(flow.id);
  const [error, setError] = useState<string | null>(null);
  const list = topics.data?.topics ?? [];
  if (list.length === 0) return null;

  async function change(value: string) {
    setError(null);
    try {
      await update.mutateAsync({ topic_id: value === "" ? null : value });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The topic could not be saved.");
    }
  }

  return (
    <div className="mt-6">
      <label htmlFor="flow-topic" className="mb-1.5 block text-[14px] font-medium text-foreground">
        Topic
      </label>
      <Select
        id="flow-topic"
        value={flow.topic_id ?? ""}
        onChange={(e) => void change(e.target.value)}
        disabled={disabled || update.isPending}
        className="max-w-sm"
      >
        <option value="">No topic</option>
        {list.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.kind})
          </option>
        ))}
      </Select>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Contacts unsubscribed from the topic do not get this flow&apos;s mail. New messages take the topic; manage
        topics in <Link to="/settings/topics" className="text-accent-text hover:underline">Settings</Link>.
      </p>
      {error && <p className="mt-1 text-[13px] text-danger" role="alert">{error}</p>}
    </div>
  );
}
