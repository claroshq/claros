/**
 * Library flows: pre-built flows with hand-authored compiled plans and templates.
 *
 * These ship with Claros and can be installed by a self-hoster to get
 * immediate value without configuring an LLM. The flows use template_ref
 * so every email is rendered deterministically from pre-authored content.
 *
 * Business model: SaaS product onboarding.
 * Chosen because it is the universal first use case for any self-hoster
 * evaluating a lifecycle email engine, and because it demonstrates the
 * full event-to-email pipeline with a single track event (signed_up).
 *
 * Set: Welcome flow (3 emails over 3 days)
 *   Step 1: Immediate welcome (delay: 0m, template: welcome)
 *   Step 2: Getting started guide (delay: 1d, template: getting-started)
 *   Step 3: Check-in (delay: 3d, template: check-in)
 *
 * Exit condition: if the contact fires "activated" event, exit the flow
 * (they have already gotten value from the product and do not need more
 * onboarding nudges).
 *
 * Cost to user: 1 flow, 3 emails per contact, over 3 days.
 * A contact who activates early receives fewer (exit condition fires).
 * No contact receives more than 3 emails from this flow total.
 *
 * Activation: installing and activating are separate acts. The install
 * endpoint creates the templates and flow in "draft" status. The user
 * must explicitly set the flow to "active" to start enrollment.
 */

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export interface LibraryTemplate {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[];
  category: string;
}

export const LIBRARY_TEMPLATES: LibraryTemplate[] = [
  {
    slug: "welcome",
    name: "Welcome",
    subject: "Welcome to {{tenant.name}}",
    bodyHtml: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
<p>Hi {{contact.first_name|there}},</p>

<p>Thanks for signing up for {{tenant.name}}. You are in.</p>

<p>We built this because we needed it ourselves, and we think you will find it useful too. No lengthy setup wizards here - you can start using it right now.</p>

<p>If you run into anything confusing, reply to this email. A real person reads it.</p>

<p>Talk soon,<br>The {{tenant.name}} team</p>
</div>`,
    bodyText: `Hi {{contact.first_name|there}},

Thanks for signing up for {{tenant.name}}. You are in.

We built this because we needed it ourselves, and we think you will find it useful too. No lengthy setup wizards here - you can start using it right now.

If you run into anything confusing, reply to this email. A real person reads it.

Talk soon,
The {{tenant.name}} team`,
    variables: ["tenant.name"],
    category: "nurture",
  },
  {
    slug: "getting-started",
    name: "Getting Started",
    subject: "Getting the most from {{tenant.name}}",
    bodyHtml: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
<p>Hi {{contact.first_name|there}},</p>

<p>Most people who get value from {{tenant.name}} do three things in their first week:</p>

<ol>
<li>Connect their data source (takes about 2 minutes)</li>
<li>Set up their first automation</li>
<li>Send a test message to themselves</li>
</ol>

<p>That third one is the moment it clicks. You see the email arrive and think: "right, this is going to save me a lot of time."</p>

<p>If you have already done all three, ignore this email - you are ahead of the curve. If not, the first one takes two minutes and unlocks everything else.</p>

<p>Questions? Just reply.</p>

<p>Best,<br>The {{tenant.name}} team</p>
</div>`,
    bodyText: `Hi {{contact.first_name|there}},

Most people who get value from {{tenant.name}} do three things in their first week:

1. Connect their data source (takes about 2 minutes)
2. Set up their first automation
3. Send a test message to themselves

That third one is the moment it clicks. You see the email arrive and think: "right, this is going to save me a lot of time."

If you have already done all three, ignore this email - you are ahead of the curve. If not, the first one takes two minutes and unlocks everything else.

Questions? Just reply.

Best,
The {{tenant.name}} team`,
    variables: ["tenant.name"],
    category: "nurture",
  },
  {
    slug: "check-in",
    name: "Check-in",
    subject: "How is it going?",
    bodyHtml: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
<p>Hi {{contact.first_name|there}},</p>

<p>You signed up a few days ago and I wanted to check in. Two questions:</p>

<ol>
<li>Did you get {{tenant.name}} doing what you needed?</li>
<li>Is there anything blocking you?</li>
</ol>

<p>If the answer to #1 is yes, great - you will not hear from me again unless something useful comes up. If the answer to #2 is anything other than "no," reply and tell me what is in the way. I will either fix it or point you to someone who can.</p>

<p>No pressure either way. Just want to make sure you are not stuck.</p>

<p>Cheers,<br>The {{tenant.name}} team</p>
</div>`,
    bodyText: `Hi {{contact.first_name|there}},

You signed up a few days ago and I wanted to check in. Two questions:

1. Did you get {{tenant.name}} doing what you needed?
2. Is there anything blocking you?

If the answer to #1 is yes, great - you will not hear from me again unless something useful comes up. If the answer to #2 is anything other than "no," reply and tell me what is in the way. I will either fix it or point you to someone who can.

No pressure either way. Just want to make sure you are not stuck.

Cheers,
The {{tenant.name}} team`,
    variables: ["tenant.name"],
    category: "nurture",
  },
];

// ---------------------------------------------------------------------------
// Flow definition
// ---------------------------------------------------------------------------

export interface LibraryFlow {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  steps: Array<{
    order: number;
    action_type: string;
    delay: string;
    template_ref: string;
  }>;
  compiledPlan: {
    trigger: {
      type: string;
      condition: Record<string, unknown>;
    };
    steps: Array<{
      order: number;
      action_type: string;
      delay: string;
      window_policy: string;
      template_ref: string;
    }>;
    exit_conditions: Array<Record<string, unknown>>;
  };
  flowClass: string;
  approvalMode: string;
  reentryPolicy: string;
  reentryCooldownDays: number;
  priority: number;
  source: string;
}

export const LIBRARY_FLOW_WELCOME: LibraryFlow = {
  name: "Welcome Onboarding",
  description: "3-email welcome sequence for new signups. Triggered by the signed_up event. Exits early if the contact fires an activated event.",
  triggerType: "event",
  triggerConfig: { event: "signed_up" },
  steps: [
    { order: 1, action_type: "welcome", delay: "0m", template_ref: "welcome" },
    { order: 2, action_type: "nurture_value", delay: "1d", template_ref: "getting-started" },
    { order: 3, action_type: "nurture_value", delay: "3d", template_ref: "check-in" },
  ],
  compiledPlan: {
    trigger: {
      type: "event",
      condition: { event: "signed_up" },
    },
    steps: [
      {
        order: 1,
        action_type: "welcome",
        delay: "0m",
        window_policy: "immediate",
        template_ref: "welcome",
      },
      {
        order: 2,
        action_type: "nurture_value",
        delay: "1d",
        window_policy: "respect_window",
        template_ref: "getting-started",
      },
      {
        order: 3,
        action_type: "nurture_value",
        delay: "3d",
        window_policy: "respect_window",
        template_ref: "check-in",
      },
    ],
    exit_conditions: [
      { event: "activated" },
    ],
  },
  flowClass: "nurture",
  approvalMode: "auto",
  reentryPolicy: "once",
  reentryCooldownDays: 0,
  priority: 10,
  source: "library",
};

// ---------------------------------------------------------------------------
// Install result type
// ---------------------------------------------------------------------------

export interface InstallResult {
  flowId: string;
  templatesCreated: number;
  flowCreated: boolean;
}
