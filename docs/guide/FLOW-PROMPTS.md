# Flow Prompt Library

Working prompts for the flow editor. Each one names its trigger, its prompt, what the compiler produces from it, and when to use it. Paste the prompt into a new flow, set the trigger as shown, compile, review the plan, activate. Every prompt on this page has been compiled successfully against the current compiler.

Before pasting, read [CONCEPTS.md](./CONCEPTS.md#compilation-prompts-in-deterministic-plans-out) so the compiled plan does not surprise you.

## How to write a prompt that compiles well

The compiler is an LLM with a strict output contract. It handles natural language, but these habits produce the best plans:

- **Name the trigger event exactly** as your app sends it (`signed_up`, not `sign-up`). The trigger itself is set in the editor; the prompt should agree with it.
- **Number the steps with their delays**: "Step 1 (day 0, immediate) ... Step 2 (2 days later, respect_window) ...". Delays are minutes, hours, or days only.
- **Say `immediate` or `respect_window` per step.** Immediate ignores the send window (use for welcomes, payment failures); respect_window holds the email for the next 09:00-17:00 weekday slot.
- **Use the closed condition vocabulary.** Steps can proceed-if or exit-if: the contact is / is not in a lifecycle state, or an event has happened since the step. Nothing else compiles.
- **State the exit conditions**: "Exit the flow the moment the user activates" compiles to a plan-level exit on the lifecycle change.
- **End with class and re-entry**: "Flow class: nurture. Reentry: once."

Limits to know before writing:

- No schedule or cron triggers. A prompt cannot say "every Monday"; enrollment needs an event, a lifecycle transition, or a retention-grid segment.
- `manual` triggers are accepted but do not enroll anyone yet.
- Conditions cannot reference plan names, prices, or arbitrary traits. Move product facts into Settings → Brain context (`brain_context`) or a knowledge base entry and reference it with `@kb:name`.
- Your own fixed templates can be referenced with `@template:name`.

---

## Onboarding and activation

### Welcome sequence

**Trigger:** event `signed_up`

```
Send a 3-step welcome sequence to new signups.
Step 1 (0 minutes, immediate): Welcome them, thank them for signing up, and point
them at the single most valuable first action in the product.
Step 2 (1 day later, respect_window): A short getting-started guide: the two or
three things successful users do in their first week, with links.
Step 3 (3 days later, respect_window): Share a concrete example or mini case study
of what a user achieved, and invite them to reply with questions.
Exit the flow if the user activates (lifecycle_state changes to activated).
Flow class: nurture. Reentry: once.
```

**Produces:** three steps at 0m / 1d / 3d with the welcome step immediate and the rest windowed; exit on activation. This mirrors the prebuilt library flow, which ships with hand-written copy and needs no LLM; write your own prompt when you want AI-drafted copy or different timing.

**Use when:** you have exactly one obvious first-run journey. If you are unsure, install the library flow from the Home checklist instead.

### Activation rescue

**Trigger:** event `signed_up`

```
Send an activation rescue sequence to users who signed up but have not activated.
Step 1 (2 days, respect_window): Only send if the user is still in lifecycle state
signed_up. Remind them of the one action that unlocks value and make it one click away.
Step 2 (3 days later, respect_window): Only send if the user has still not activated.
Offer help directly: ask what is blocking them and invite a reply.
Exit the flow if the user activates.
Flow class: nurture. Reentry: once.
```

**Produces:** two proceed-if-gated steps using `lifecycle_state` conditions, exit on `activated`. Contacts who activate on their own silently skip the whole flow.

**Use when:** your activation rate is the metric that matters; this recovers the users the welcome sequence did not reach.

## Revenue

### Trial ending

**Trigger:** event `trial_ending` (sent by your billing system a few days before expiry)

```
Send a trial expiry sequence.
Step 1 (0 minutes, immediate): Warn that the trial ends soon, summarize what they
have accomplished during the trial using their usage data, and show the upgrade path.
Step 2 (2 days later, immediate): Final warning before expiry. Be direct about what
stops working, the price to keep it, and make upgrading one click.
Exit the flow if the user upgrades (event subscription_started occurs).
Flow class: critical. Reentry: once.
```

**Produces:** two immediate steps; exit when your `subscription_started` event fires. Critical class means these bypass the send window and frequency caps, which is what you want for money-on-the-line email.

**Use when:** trials have a hard expiry. Your billing system must fire `trial_ending` (and `subscription_started` on conversion); see [INGESTION.md](./INGESTION.md).

### Failed payment recovery (dunning)

**Trigger:** event `payment_failed`

```
Send a payment recovery sequence.
Step 1 (0 minutes, immediate): Notify that the payment failed, say plainly that no
action is needed yet if they are already updating their card, and link to the
billing page. Tone: helpful, not alarming.
Step 2 (2 days later, immediate): Only send if the event payment_recovered has not
occurred since step 1. Second notice: state that the account will lose access soon
and link to update payment details.
Step 3 (3 days later, immediate): Only send if payment_recovered has still not
occurred. Final notice with a specific date after which the subscription cancels.
Exit the flow if the event payment_recovered occurs.
Flow class: critical. Reentry: every_time.
```

**Produces:** three immediate critical steps gated by `event_since_step: payment_recovered`, plus a plan-level exit on the same event. Re-entry `every_time` because cards fail more than once.

**Use when:** you have recurring billing. Fire `payment_failed` and `payment_recovered` from your billing webhook handler.

### Usage limit approaching

**Trigger:** event `usage_limit_approaching`

```
Send a usage limit notification.
Step 1 (0 minutes, immediate): Tell the user they are close to their plan limit,
show how much they have used, explain what happens at the limit, and present the
upgrade as the way to keep going. One email, no sequence.
Exit the flow if the user upgrades (event subscription_started occurs).
Flow class: critical. Reentry: cooldown 30 days.
```

**Produces:** a single immediate critical step.

**Use when:** your pricing has metered limits. Fire the event from your metering code when a customer crosses roughly 80% of their allowance.

## Retention

### Win-back

**Trigger:** lifecycle transition `engaged` → `dormant`

```
Send a win-back email to users who have gone dormant.
Step 1 (0 minutes, immediate): Acknowledge the gap without guilt-tripping,
reference something specific they did before going quiet, and give one concrete
reason to come back today. Do not pitch an upgrade.
Step 2 (5 days later, respect_window): Only send if the user has not returned
(lifecycle_state is still dormant). Share what is new since they left.
Exit the flow if the user returns (lifecycle_state changes to engaged).
Flow class: nurture. Reentry: cooldown 30 days.
```

**Produces:** two steps, the first immediate, the second gated on still-dormant, exit on return to engaged.

**Use when:** you want a safety net under your most engaged cohort. Lifecycle transitions are evaluated on the 15-minute scan, so dormancy triggers can lag by up to 15 minutes; irrelevant at this timescale.

### Churn-risk check-in

**Trigger:** lifecycle transition `engaged` → `at_risk`

```
Send a gentle check-in when a previously engaged user becomes at risk.
Step 1 (0 minutes, respect_window): A short personal note: ask how the product is
working for them, mention one feature they use most based on their usage data, and
invite a direct reply. No links to upgrade, no pressure.
Exit the flow if the user becomes engaged again.
Flow class: nurture. Reentry: cooldown 30 days.
```

**Produces:** one windowed step, exit on recovery.

**Use when:** you would rather catch churn at the `at_risk` stage than win back the `dormant`.

## Expansion

### Upgrade nudge after activation

**Trigger:** lifecycle transition `signed_up` → `activated`

```
Send an upgrade suggestion to freshly activated free users.
Step 1 (7 days, respect_window): Congratulate them on getting value, show what the
paid plan adds on top of what they already use, and make the upgrade one click.
Keep it helpful, not pushy.
Exit the flow if the user upgrades (event subscription_started occurs).
Flow class: nurture. Reentry: once.
```

**Produces:** one windowed step delayed 7 days after activation.

**Use when:** free-to-paid conversion rides on demonstrated value rather than trial pressure.

### Re-engage idle established accounts

**Trigger:** segment `established` x `idle` (retention grid cell)

```
Send a re-engagement email to long-tenured accounts that have gone idle.
Step 1 (0 minutes, respect_window): Remind them what they have built in the product,
summarize recent improvements they have not seen, and offer one low-effort action
that delivers value in minutes.
Flow class: nurture. Reentry: cooldown 30 days.
```

**Produces:** one step aimed at a grid cell. Segment enrollment runs on the 15-minute scan and is capped at 200 contacts per flow per scan, so large cells drain over several scans.

**Use when:** you want to target an audience by tenure and recency rather than by a single event. The retention grid in Analytics previews exactly who the cell contains.

---

## After you paste one in

1. Compile and read the plan. Check delays, which steps are immediate, and the exit conditions.
2. Send the trigger event to a test contact with your own email address (the [QUICKSTART.md](./QUICKSTART.md) steps 9-11 pattern) and watch the message arrive in Approvals.
3. Approve a few sends. When the copy is consistently good, switch the flow to auto-approve.

If compilation fails, the error is shown on the flow. The common causes are a condition outside the closed vocabulary, a delay that is not in minutes/hours/days, or a trigger mismatch between the editor and the prompt.
