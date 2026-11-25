/**
 * Settings / Topics.
 *
 * Topics are the subscription categories of a product. A flow with a topic
 * sends mail of that topic; contacts who unsubscribed from it (unsubscribe
 * page, identify traits.topics) do not receive it. Transactional topics
 * ignore topic unsubscribes (the suppression list still applies), carry no
 * List-Unsubscribe headers and may be routed to Cloudflare Email Service.
 */
import React, { useState } from "react";
import type { Topic, TopicKind } from "../../api.js";
import { useTopics, useCreateTopic, usePatchTopic } from "../../topics-transports.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Badge } from "../../components/ui/badge.js";
import { Section, FormError, Notice, errorMessage } from "./shared.js";

const KINDS: ReadonlyArray<{ value: TopicKind; label: string; hint: string }> = [
  { value: "marketing", label: "Marketing", hint: "Newsletters and announcements." },
  { value: "lifecycle", label: "Lifecycle", hint: "Onboarding, nudges and re-engagement." },
  {
    value: "transactional",
    label: "Transactional",
    hint: "Receipts and account mail. Topic unsubscribes do not apply; no List-Unsubscribe headers.",
  },
];

const LABEL = "mb-1.5 block text-[14px] font-medium text-foreground";

export default function TopicsSettings() {
  const { data, isLoading, error } = useTopics();
  const [adding, setAdding] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) return <FormError message={error ? errorMessage(error) : "Topics could not be loaded."} />;

  const topics = data.topics;
  return (
    <Section
      title="Topics"
      description="Let contacts choose which kinds of email they receive. Assign a topic to a flow to gate its mail."
      configured={null}
      actions={
        !adding ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>New topic</Button>
        ) : undefined
      }
    >
      {topics.length === 0 && !adding && (
        <Notice variant="info">
          No topics yet. Without topics every message carries List-Unsubscribe and an unsubscribe stops all mail of
          this product.
        </Notice>
      )}
      {topics.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {topics.map((t) => <TopicRow key={t.id} topic={t} />)}
        </ul>
      )}
      {adding && <NewTopicForm onDone={() => setAdding(false)} />}
    </Section>
  );
}

function TopicRow({ topic }: { topic: Topic }) {
  const patch = usePatchTopic();
  const [err, setErr] = useState<string | null>(null);

  async function update(input: { kind?: TopicKind; default_subscribed?: boolean; mirror_only?: boolean }) {
    setErr(null);
    try {
      await patch.mutateAsync({ id: topic.id, input });
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-medium text-foreground">{topic.name}</span>
          <span className="font-mono text-[13px] text-muted-foreground">{topic.slug}</span>
          {!topic.default_subscribed && <Badge variant="muted">opt-in</Badge>}
          {topic.mirror_only && <Badge variant="muted">mirror only</Badge>}
        </div>
        {topic.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{topic.description}</p>}
        <FormError message={err} />
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor={`kind-${topic.id}`} className="sr-only">Kind of {topic.name}</label>
        <Select
          id={`kind-${topic.id}`}
          value={topic.kind}
          onChange={(e) => void update({ kind: e.target.value as TopicKind })}
          disabled={patch.isPending}
          className="w-40"
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-[14px] text-foreground">
          <input
            type="checkbox"
            checked={topic.default_subscribed}
            onChange={(e) => void update({ default_subscribed: e.target.checked })}
            disabled={patch.isPending}
            className="rounded border-input"
          />
          Subscribed by default
        </label>
        <label
          className="flex items-center gap-2 text-[14px] text-foreground"
          title="The topic only mirrors consent (for example a newsletter tool's list). No flow may send on it."
        >
          <input
            type="checkbox"
            checked={topic.mirror_only === true}
            onChange={(e) => void update({ mirror_only: e.target.checked })}
            disabled={patch.isPending}
            className="rounded border-input"
          />
          Mirror only
        </label>
      </div>
    </li>
  );
}

function NewTopicForm({ onDone }: { onDone: () => void }) {
  const create = useCreateTopic();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState<TopicKind>("marketing");
  const [description, setDescription] = useState("");
  const [defaultSubscribed, setDefaultSubscribed] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        kind,
        description: description.trim() === "" ? null : description.trim(),
        default_subscribed: defaultSubscribed,
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 space-y-4 rounded-md border border-border p-4">
      <h3 className="text-[16px] font-semibold text-foreground">New topic</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="topic-name" className={LABEL}>Name</label>
          <Input
            id="topic-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(autoSlug(e.target.value));
            }}
            placeholder="Product news"
            disabled={create.isPending}
          />
        </div>
        <div>
          <label htmlFor="topic-slug" className={LABEL}>Slug</label>
          <Input
            id="topic-slug"
            value={slug}
            onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
            className="font-mono"
            disabled={create.isPending}
          />
          <p className="mt-1 text-[13px] text-muted-foreground">Used in identify traits: topics: {"{"} "{slug || "slug"}": true {"}"}. Fixed after creation.</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="topic-kind" className={LABEL}>Kind</label>
          <Select id="topic-kind" value={kind} onChange={(e) => setKind(e.target.value as TopicKind)} disabled={create.isPending}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
          <p className="mt-1 text-[13px] text-muted-foreground">{KINDS.find((k) => k.value === kind)?.hint}</p>
        </div>
        <div>
          <label htmlFor="topic-description" className={LABEL}>
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input id="topic-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={create.isPending} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[14px] text-foreground">
        <input
          type="checkbox"
          checked={defaultSubscribed}
          onChange={(e) => setDefaultSubscribed(e.target.checked)}
          disabled={create.isPending}
          className="rounded border-input"
        />
        Subscribed by default (clear for opt-in topics)
      </label>
      <FormError message={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.isPending || name.trim() === "" || slug.trim() === ""}>
          {create.isPending ? "Saving..." : "Create topic"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={create.isPending}>Cancel</Button>
      </div>
    </form>
  );
}
