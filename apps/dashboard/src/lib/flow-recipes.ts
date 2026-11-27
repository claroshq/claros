/**
 * Starting points for a new flow: a trigger, delivery settings and emails
 * with editable sample copy. Nothing here sends until the person saves and
 * activates the flow. Copy uses only variables the renderer knows, each
 * personal one with a fallback, and no links (named links differ per
 * product; the editor offers them as insert buttons).
 */
import type { StepCopy } from "../api.js";
import type { Json } from "./flow-model.js";
import type { EditorDraft } from "./flow-editor-model.js";
import { emptyDraft } from "./flow-editor-model.js";

export interface RecipeEmail {
  delay: string;
  action_type: string;
  window_policy?: "immediate" | "respect_window";
  /** Fixed copy; absent for an AI-drafted email. */
  copy?: StepCopy;
  preheader?: string;
  /** AI instruction; used instead of copy. */
  instruction?: string;
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  /** Needs an LLM provider (AI-drafted emails). */
  needsLlm?: boolean;
  /** Needs a date trait declared in settings.date_traits. */
  needsDateTrait?: boolean;
  build: () => Omit<EditorDraft, "copies" | "steps"> & { emails: RecipeEmail[] };
}

function p(...paras: string[]): string {
  return paras.map((x) => `<p>${x}</p>`).join("\n");
}

const HI = "Hi {{contact.first_name|there}},";

export const RECIPES: Recipe[] = [
  {
    id: "welcome",
    title: "Welcome email",
    description: "One email the moment someone signs up.",
    build: () => ({
      ...emptyDraft({ type: "event", config: { event: "signed_up" } }),
      name: "Welcome",
      emails: [
        {
          delay: "0m", action_type: "welcome", window_policy: "immediate", preheader: "Your account is ready",
          copy: {
            subject: "Welcome to {{tenant.name}}",
            body_html: p(HI, "Thanks for signing up. Your account is ready.", "The quickest way to see what {{tenant.name}} does is to set up your first project. It takes a couple of minutes.", "If anything is unclear, reply to this email. It reaches a person."),
            body_text: null,
          },
        },
      ],
    }),
  },
  {
    id: "onboarding",
    title: "Onboarding series",
    description: "Four emails over the first week: welcome, first step, a tip, a check-in.",
    build: () => ({
      ...emptyDraft({ type: "event", config: { event: "signed_up" } }),
      name: "Onboarding",
      emails: [
        { delay: "0m", action_type: "onboarding_welcome", window_policy: "immediate", preheader: "Start here", copy: { subject: "Welcome to {{tenant.name}}", body_html: p(HI, "Welcome aboard. Over the next week you will get a few short emails, each with one thing worth doing.", "Today: set up your first project. Everything else builds on it."), body_text: null } },
        { delay: "1d", action_type: "onboarding_first_step", preheader: "Two minutes, one result", copy: { subject: "The one thing to do first", body_html: p(HI, "Most people who get value from {{tenant.name}} do one thing in their first days: they connect their own data, so what they see is about them.", "If you have not done it yet, today is a good day."), body_text: null } },
        { delay: "2d", action_type: "onboarding_tip", preheader: "Small, but people miss it", copy: { subject: "A tip most people miss", body_html: p(HI, "One small thing that saves time later: save the view you use most. It is one click, and it is there every time you come back."), body_text: null } },
        { delay: "4d", action_type: "onboarding_check_in", preheader: "Reply with anything", copy: { subject: "How is it going?", body_html: p(HI, "You have had {{tenant.name}} for a week. Is it doing what you hoped?", "Reply and tell me what is missing or confusing. I read every reply."), body_text: null } },
      ],
    }),
  },
  {
    id: "trial-ending",
    title: "Trial ending",
    description: "A reminder three days before the trial ends, at 09:00 in the contact's time zone.",
    needsDateTrait: true,
    build: () => ({
      ...emptyDraft({ type: "date_property", config: { property: "trial_ends_at", offset: "-3d", send_at_local: "09:00" } }),
      name: "Trial ends in 3 days",
      flow_class: "critical",
      emails: [
        { delay: "0m", action_type: "trial_ending", preheader: "What changes, and what you keep", copy: { subject: "Your trial ends in 3 days", body_html: p(HI, "Your {{tenant.name}} trial ends in three days.", "Your data stays where it is. To keep using everything, choose a plan before the trial ends.", "Questions about plans? Reply to this email."), body_text: null } },
      ],
    }),
  },
  {
    id: "payment-failed",
    title: "Payment failed",
    description: "Three reminders over a week; stops when the payment goes through.",
    build: () => ({
      ...emptyDraft({ type: "event", config: { event: "payment_failed" } }),
      name: "Payment failed",
      flow_class: "critical",
      reentry_policy: "every_time",
      exits: [{ event: "payment_succeeded" }],
      emails: [
        { delay: "0m", action_type: "dunning_1", window_policy: "immediate", preheader: "Update your card to keep access", copy: { subject: "Your payment did not go through", body_html: p(HI, "We could not charge your card for {{tenant.name}}. This happens, usually because a card expired.", "Please update your payment details in your billing settings. Nothing changes on your account while you do."), body_text: null } },
        { delay: "3d", action_type: "dunning_2", preheader: "Still not through", copy: { subject: "Reminder: please update your payment details", body_html: p(HI, "Your last payment for {{tenant.name}} is still open. Updating your card in billing settings takes a minute."), body_text: null } },
        { delay: "4d", action_type: "dunning_3", preheader: "Last reminder", copy: { subject: "Last reminder about your payment", body_html: p(HI, "This is the last reminder: your payment for {{tenant.name}} is still open. If you meant to cancel, no action is needed; otherwise please update your card in billing settings."), body_text: null } },
      ],
    }),
  },
  {
    id: "win-back",
    title: "Win back",
    description: "When someone goes quiet, one personal note written by the AI for them.",
    needsLlm: true,
    build: () => ({
      ...emptyDraft({ type: "lifecycle_transition", config: { to: "churned" } }),
      name: "Win back",
      reentry_policy: "cooldown",
      reentry_cooldown_days: 90,
      emails: [
        { delay: "0m", action_type: "winback", instruction: "This person stopped using the product (they may still be a paying customer). Write a short, warm note from a person, not a campaign. Mention one thing that changed or that fits how they used the product, based on their traits and history. One clear way back in. No discount, no guilt, no exclamation marks. Three short paragraphs at most." },
      ],
    }),
  },
  {
    id: "at-risk",
    title: "At-risk check-in",
    description: "When usage drops, a check-in two days later, then a useful nudge after a week.",
    needsLlm: true,
    build: () => ({
      ...emptyDraft({ type: "lifecycle_transition", config: { to: "at_risk" } }),
      name: "At-risk check-in",
      reentry_policy: "cooldown",
      reentry_cooldown_days: 30,
      exits: [{ lifecycle_state_change: { to: "engaged" } }],
      emails: [
        { delay: "2d", action_type: "at_risk_check_in", instruction: "They used the product less in the last weeks. Ask, briefly and plainly, whether something got in the way. Offer to help. No feature list." },
        { delay: "5d", action_type: "at_risk_nudge", instruction: "Still quiet. Point to the single most useful next step for someone with their traits and recent activity, and say why in one sentence." },
      ],
    }),
  },
];

/** A recipe as an editor draft, with fresh template slugs for its fixed copy. */
export function draftFromRecipe(recipe: Recipe, slug: () => string): EditorDraft {
  const { emails, ...rest } = recipe.build();
  const copies: Record<string, StepCopy> = {};
  const steps: Json[] = emails.map((e, i) => {
    const step: Json = { order: i + 1, action_type: e.action_type, delay: e.delay, window_policy: e.window_policy ?? "respect_window" };
    if (e.copy) {
      const s = slug();
      copies[s] = { ...e.copy };
      step.template_ref = s;
    } else {
      step.brain_instruction = e.instruction ?? "";
    }
    if (e.preheader) step.preheader = e.preheader;
    return step;
  });
  return { ...rest, steps, copies };
}

/** Example instructions offered next to an AI step's instruction box. */
export const INSTRUCTION_EXAMPLES: Array<{ label: string; text: string }> = [
  { label: "After an upgrade", text: "They just upgraded. Thank them in one line, then point to the one feature their new plan unlocks that fits what they use most. One link, no upsell." },
  { label: "Gone quiet", text: "They have not been back for two weeks. Mention one thing that fits how they used the product, based on their traits. Short, no guilt, one clear way back in." },
  { label: "Trial ending", text: "Their trial ends soon. Say plainly what they keep and what stops, and how to choose a plan. No discount, no pressure." },
  { label: "Feature they have not tried", text: "Pick the one feature they have not used yet that would help most, based on their traits and recent events. Explain it in two sentences and link to it." },
];
