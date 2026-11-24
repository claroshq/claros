#!/usr/bin/env node
/**
 * Screenshot data seeder for Claros.
 *
 * Populates the local database with believable history so that dashboard
 * screenshots show a living product. Deterministic (seeded PRNG), idempotent
 * (clears its own data on each run), and safe (refuses to run unless the
 * DATABASE_URL points at localhost or 127.0.0.1).
 *
 * Usage:
 *   node scripts/seed-screenshots.mjs [--tenant-slug <slug>]
 *
 * Undo:
 *   node scripts/seed-screenshots.mjs --purge
 *
 * The script tags every row it creates with a recognizable marker:
 *   - contacts.properties = { _seeder: "screenshots" }
 *   - flows.description starts with "[seeder]"
 * On re-run or --purge it deletes only rows matching these markers.
 *
 * Safety: refuses to execute when DATABASE_URL does not point at
 * localhost/127.0.0.1, preventing accidental execution against production.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const PURGE_ONLY = args.includes("--purge");
const TENANT_SLUG = argValue("--tenant-slug") ?? "fundup";

// ---------------------------------------------------------------------------
// Safety gate: local-only
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Error: DATABASE_URL must be set.");
  process.exit(1);
}
const urlHost = new URL(DATABASE_URL).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(urlHost)) {
  console.error(
    `SAFETY: DATABASE_URL host is "${urlHost}". This script only runs against localhost.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
const pool = new (pg.default?.Pool ?? pg.Pool)({ connectionString: DATABASE_URL });

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (Mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260501); // fixed seed for reproducibility

function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
const NOW = new Date("2026-08-07T10:00:00Z"); // pinned "now" for determinism
const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;

function daysAgo(d) {
  return new Date(NOW.getTime() - d * DAY_MS);
}
function hoursAgo(h) {
  return new Date(NOW.getTime() - h * HOUR_MS);
}
function jitter(base, maxMs) {
  return new Date(base.getTime() + Math.floor(rng() * maxMs));
}
function iso(d) {
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Deterministic UUIDs (v4-shaped, from seed)
// ---------------------------------------------------------------------------
let uuidCounter = 0;
function seedUUID() {
  uuidCounter++;
  // Create a deterministic UUID using counter bytes (last segment is 12 hex chars)
  const hex = uuidCounter.toString(16).padStart(12, "0");
  return `a0000000-${hex.slice(0, 4)}-4000-8000-${hex.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// People data - pleasant, diverse, fictional names with reserved domains
// ---------------------------------------------------------------------------
const PEOPLE = [
  { name: "Nora Ashworth", company: "Ridgeline Labs", email: "nora.ashworth@example.com" },
  { name: "Kai Nakamura", company: "Ridgeline Labs", email: "kai.nakamura@example.com" },
  { name: "Seren Okafor", company: "Hearthstone Analytics", email: "seren.okafor@example.com" },
  { name: "Luca Brennan", company: "Hearthstone Analytics", email: "luca.brennan@example.com" },
  { name: "Mira Castellano", company: "Canopy Health", email: "mira.castellano@example.com" },
  { name: "Jonas Eide", company: "Canopy Health", email: "jonas.eide@example.com" },
  { name: "Ava Lindqvist", company: "Summerfield Press", email: "ava.lindqvist@example.com" },
  { name: "Rowan Achebe", company: "Summerfield Press", email: "rowan.achebe@example.com" },
  { name: "Elara Cortes", company: "Northbank Design", email: "elara.cortes@example.com" },
  { name: "Finn Tsukamoto", company: "Northbank Design", email: "finn.tsukamoto@example.com" },
  { name: "Iris Malkova", company: "Clearwater Education", email: "iris.malkova@example.com" },
  { name: "Oscar Farouk", company: "Clearwater Education", email: "oscar.farouk@example.com" },
  { name: "Thea Johanssen", company: "Pinecrest Ventures", email: "thea.johanssen@example.com" },
  { name: "Darian Webb", company: "Pinecrest Ventures", email: "darian.webb@example.com" },
  { name: "Leona Voss", company: "Slate and River", email: "leona.voss@example.com" },
  { name: "Caleb Okonkwo", company: "Slate and River", email: "caleb.okonkwo@example.com" },
  { name: "Freya Sandoval", company: "Tidewater Solutions", email: "freya.sandoval@example.com" },
  { name: "Hugo Pettersson", company: "Tidewater Solutions", email: "hugo.pettersson@example.com" },
  { name: "Amira Hassan", company: "Bloomfield Robotics", email: "amira.hassan@example.com" },
  { name: "Elliott Novak", company: "Bloomfield Robotics", email: "elliott.novak@example.com" },
  { name: "Zara Whitfield", company: "Greystone Capital", email: "zara.whitfield@example.com" },
  { name: "Samuel Reeves", company: "Greystone Capital", email: "samuel.reeves@example.com" },
  { name: "Cleo Andersson", company: "Windmill Software", email: "cleo.andersson@example.com" },
  { name: "Ravi Chandrasekaran", company: "Windmill Software", email: "ravi.chandrasekaran@example.com" },
  { name: "Maya Holbrook", company: "Foxglove Media", email: "maya.holbrook@example.com" },
  { name: "Tobias Engstrom", company: "Foxglove Media", email: "tobias.engstrom@example.com" },
  { name: "Ines Ferreira", company: "Crestview Partners", email: "ines.ferreira@example.com" },
  { name: "Oliver Tran", company: "Crestview Partners", email: "oliver.tran@example.com" },
  { name: "Sylvie Moreau", company: "Lakeside Therapeutics", email: "sylvie.moreau@example.com" },
  { name: "Nathan Khoury", company: "Lakeside Therapeutics", email: "nathan.khoury@example.com" },
  { name: "Esme Callahan", company: "Bridgepoint AI", email: "esme.callahan@example.com" },
  { name: "Aiden Park", company: "Bridgepoint AI", email: "aiden.park@example.com" },
  { name: "Petra Sundberg", company: "Ironwood Systems", email: "petra.sundberg@example.com" },
  { name: "Leo Marchetti", company: "Ironwood Systems", email: "leo.marchetti@example.com" },
  { name: "Naomi Ikeda", company: "Clearpath Logistics", email: "naomi.ikeda@example.com" },
  { name: "Victor Gupta", company: "Clearpath Logistics", email: "victor.gupta@example.com" },
  { name: "Clara Bergstrom", company: "Eventide Studio", email: "clara.bergstrom@example.com" },
  { name: "Jasper Nwosu", company: "Eventide Studio", email: "jasper.nwosu@example.com" },
  { name: "Helena Torres", company: "Stonebridge Corp", email: "helena.torres@example.com" },
  { name: "Miles Okada", company: "Stonebridge Corp", email: "miles.okada@example.com" },
  { name: "Linnea Forsberg", company: "Osprey Research", email: "linnea.forsberg@example.com" },
  { name: "Dominic Almeida", company: "Osprey Research", email: "dominic.almeida@example.com" },
  { name: "Selena Kovalenko", company: "Harborview Tech", email: "selena.kovalenko@example.com" },
  { name: "Arthur Lindstrom", company: "Harborview Tech", email: "arthur.lindstrom@example.com" },
  { name: "Priya Srinivasan", company: "Summit Advisory", email: "priya.srinivasan@example.com" },
  { name: "Felix Magnusson", company: "Summit Advisory", email: "felix.magnusson@example.com" },
  { name: "Isla McAllister", company: "Fieldstone Labs", email: "isla.mcallister@example.com" },
  { name: "Rafael Eklund", company: "Fieldstone Labs", email: "rafael.eklund@example.com" },
  { name: "Camille Duval", company: "Trailmark", email: "camille.duval@example.com" },
  { name: "Kenji Watanabe", company: "Trailmark", email: "kenji.watanabe@example.com" },
  { name: "Beatrix Holm", company: "Wildflower Co", email: "beatrix.holm@example.com" },
  { name: "Andre Patel", company: "Wildflower Co", email: "andre.patel@example.com" },
  { name: "Juliette Garnier", company: "Copper & Vine", email: "juliette.garnier@example.com" },
  { name: "Marcus Olsson", company: "Copper & Vine", email: "marcus.olsson@example.com" },
  { name: "Hana Kovacs", company: "Alder Group", email: "hana.kovacs@example.com" },
  { name: "Simon Delacroix", company: "Alder Group", email: "simon.delacroix@example.com" },
  { name: "Astrid Bergman", company: "Watershed Analytics", email: "astrid.bergman@example.com" },
  { name: "Daniel Osei", company: "Watershed Analytics", email: "daniel.osei@example.com" },
  { name: "Rosa Lindgren", company: "Keystone Digital", email: "rosa.lindgren@example.com" },
  { name: "Theo Vasquez", company: "Keystone Digital", email: "theo.vasquez@example.com" },
  { name: "Vivian Cheng", company: "Northstar Platform", email: "vivian.cheng@example.com" },
  { name: "Erik Johansson", company: "Northstar Platform", email: "erik.johansson@example.com" },
  { name: "Matilda Kwan", company: "Horizon Labs", email: "matilda.kwan@example.com" },
  { name: "Patrick Hallberg", company: "Horizon Labs", email: "patrick.hallberg@example.com" },
  { name: "Diana Larsson", company: "Cedar Ridge", email: "diana.larsson@example.com" },
  { name: "Owen Fitzgerald", company: "Cedar Ridge", email: "owen.fitzgerald@example.com" },
  { name: "Nina Kowalski", company: "Verdant Science", email: "nina.kowalski@example.com" },
  { name: "Grant Holmgren", company: "Verdant Science", email: "grant.holmgren@example.com" },
  { name: "Alice Moreira", company: "Ember Collective", email: "alice.moreira@example.com" },
  { name: "Stefan Nilsson", company: "Ember Collective", email: "stefan.nilsson@example.com" },
  { name: "Lucia Vargas", company: "Oakwood Partners", email: "lucia.vargas@example.com" },
  { name: "Henrik Dahl", company: "Oakwood Partners", email: "henrik.dahl@example.com" },
  { name: "Maren Solberg", company: "Sparrow Consulting", email: "maren.solberg@example.com" },
  { name: "Christopher Ito", company: "Sparrow Consulting", email: "christopher.ito@example.com" },
  { name: "Bianca Rossi", company: "Granite Works", email: "bianca.rossi@example.com" },
  { name: "James Halvorsen", company: "Granite Works", email: "james.halvorsen@example.com" },
  { name: "Tamara Volkov", company: "Cornerstone Health", email: "tamara.volkov@example.com" },
  { name: "Emilio Santos", company: "Cornerstone Health", email: "emilio.santos@example.com" },
  { name: "Ingrid Almqvist", company: "Skybridge Tech", email: "ingrid.almqvist@example.com" },
  { name: "Aaron Goldstein", company: "Skybridge Tech", email: "aaron.goldstein@example.com" },
  { name: "Cecilia Strand", company: "Willowbrook", email: "cecilia.strand@example.com" },
  { name: "Martin Akiyama", company: "Willowbrook", email: "martin.akiyama@example.com" },
  { name: "Sophie Rask", company: "Blue Ridge Data", email: "sophie.rask@example.com" },
  { name: "William Johansen", company: "Blue Ridge Data", email: "william.johansen@example.com" },
  { name: "Gabriella Marin", company: "Thornhill Group", email: "gabriella.marin@example.com" },
  { name: "Thomas Lindberg", company: "Thornhill Group", email: "thomas.lindberg@example.com" },
  { name: "Vera Kiseleva", company: "Pinehurst Software", email: "vera.kiseleva@example.com" },
  { name: "Lucas Costa", company: "Pinehurst Software", email: "lucas.costa@example.com" },
  { name: "Annika Westerberg", company: "Redstone Capital", email: "annika.westerberg@example.com" },
  { name: "Diego Ramirez", company: "Redstone Capital", email: "diego.ramirez@example.com" },
  { name: "Fiona Blackwell", company: "Aspen Dynamics", email: "fiona.blackwell@example.com" },
  { name: "Yuki Takahashi", company: "Aspen Dynamics", email: "yuki.takahashi@example.com" },
  { name: "Margot Persson", company: "Hollywell Industries", email: "margot.persson@example.com" },
  { name: "Ian Crawford", company: "Hollywell Industries", email: "ian.crawford@example.com" },
  { name: "Adriana Sousa", company: "Mapletree Labs", email: "adriana.sousa@example.com" },
  { name: "Karl Hedlund", company: "Mapletree Labs", email: "karl.hedlund@example.com" },
  { name: "Elise Nordin", company: "Compass Point", email: "elise.nordin@example.com" },
  { name: "Tomas Bergqvist", company: "Compass Point", email: "tomas.bergqvist@example.com" },
  { name: "Julia Werner", company: "Ridgeway Studios", email: "julia.werner@example.com" },
  { name: "Noel Svensson", company: "Ridgeway Studios", email: "noel.svensson@example.com" },
  { name: "Charlotte Linden", company: "Silveroak", email: "charlotte.linden@example.com" },
  { name: "Benjamin Falk", company: "Silveroak", email: "benjamin.falk@example.com" },
  { name: "Emilia Strand", company: "Birchwood", email: "emilia.strand@example.com" },
  { name: "Philip Arvidsson", company: "Birchwood", email: "philip.arvidsson@example.com" },
  { name: "Valentina Ruiz", company: "Copperfield", email: "valentina.ruiz@example.com" },
  { name: "Oskar Lund", company: "Copperfield", email: "oskar.lund@example.com" },
  { name: "Natasha Bergman", company: "Maplewood", email: "natasha.bergman@example.com" },
  { name: "Henrik Sjostrom", company: "Maplewood", email: "henrik.sjostrom@example.com" },
  { name: "Layla Ahmadi", company: "Ashford Group", email: "layla.ahmadi@example.com" },
  { name: "Anders Vikstrom", company: "Ashford Group", email: "anders.vikstrom@example.com" },
  { name: "Kira Solheim", company: "Ridgeway Research", email: "kira.solheim@example.com" },
  { name: "Matteo Bianchi", company: "Ridgeway Research", email: "matteo.bianchi@example.com" },
  { name: "Sonja Eriksson", company: "Cloverdale", email: "sonja.eriksson@example.com" },
  { name: "Gabriel Rios", company: "Cloverdale", email: "gabriel.rios@example.com" },
  { name: "Katarina Borg", company: "Fieldway", email: "katarina.borg@example.com" },
  { name: "Ryan Choi", company: "Fieldway", email: "ryan.choi@example.com" },
  { name: "Maja Hedberg", company: "Sunstone", email: "maja.hedberg@example.com" },
  { name: "Noah Lindahl", company: "Sunstone", email: "noah.lindahl@example.com" },
  { name: "Elena Petrova", company: "Moorland Digital", email: "elena.petrova@example.com" },
  { name: "Carl Ahlstrom", company: "Moorland Digital", email: "carl.ahlstrom@example.com" },
];

// 120 contacts total

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------
const FLOW_DEFS = [
  {
    name: "Welcome sequence",
    description: "[seeder] Onboard new signups with a 3-step drip",
    triggerType: "event",
    triggerConfig: { event_name: "signed_up" },
    source: "library",
    contentMode: "ai_drafted",
    status: "active",
    approvalMode: "auto",
    flowClass: "nurture",
    reentryPolicy: "once",
    promptSource:
      "When a user signs up, send a welcome email immediately. If they have not activated after 2 days, send a getting-started guide. After 5 days, send a short case study from a similar company. Exit the flow as soon as they activate.",
    compileStatus: "ready",
    steps: [
      { order: 1, action_type: "send_email", delay: "0m", window_policy: "immediate" },
      { order: 2, action_type: "send_email", delay: "2d", window_policy: "respect_window" },
      { order: 3, action_type: "send_email", delay: "5d", window_policy: "respect_window" },
    ],
    compiledPlan: {
      trigger: { type: "event", condition: { event_name: "signed_up" } },
      steps: [
        { order: 1, action_type: "send_email", delay: "0m", window_policy: "immediate", brain_instruction: "Warm welcome. Introduce the product in one sentence. Link to the quickstart guide." },
        { order: 2, action_type: "send_email", delay: "2d", window_policy: "respect_window", brain_instruction: "Getting-started guide. Three concrete first steps. Friendly but brief.", condition: { lifecycle_state: "signed_up" } },
        { order: 3, action_type: "send_email", delay: "5d", window_policy: "respect_window", brain_instruction: "Share a short case study from a similar company. Social proof, not a sales pitch.", condition: { lifecycle_state_not: "activated" } },
      ],
      exit_conditions: [{ lifecycle_state_change: { to: "activated" } }],
    },
  },
  {
    name: "Activation nudge",
    description: "[seeder] Nudge users who signed up but have not activated",
    triggerType: "lifecycle_transition",
    triggerConfig: { from: "signed_up", to: "signed_up" },
    source: "manual",
    contentMode: "ai_drafted",
    status: "active",
    approvalMode: "require",
    flowClass: "nurture",
    reentryPolicy: "once",
    promptSource:
      "If someone has been signed up for 3 days without activating, send a single helpful nudge pointing them to the one action that matters most. Do not follow up again.",
    compileStatus: "ready",
    steps: [
      { order: 1, action_type: "send_email", delay: "3d", window_policy: "respect_window" },
    ],
    compiledPlan: {
      trigger: { type: "lifecycle_transition", condition: { from: "signed_up", to: "signed_up" } },
      steps: [
        { order: 1, action_type: "send_email", delay: "3d", window_policy: "respect_window", brain_instruction: "One helpful nudge. Point to the single most important activation action. Short and personal." },
      ],
      exit_conditions: [{ lifecycle_state_change: { to: "activated" } }],
    },
  },
  {
    name: "Win-back: at-risk users",
    description: "[seeder] Re-engage users who are drifting away",
    triggerType: "lifecycle_transition",
    triggerConfig: { from: "engaged", to: "at_risk" },
    source: "manual",
    contentMode: "ai_drafted",
    status: "active",
    approvalMode: "require",
    flowClass: "nurture",
    reentryPolicy: "cooldown",
    promptSource:
      "When a user moves to at_risk, send a low-pressure check-in after 1 day. If still at risk after 5 days, share what other teams are building. After 10 days, offer a short call. Stop if they return to engaged.",
    compileStatus: "ready",
    steps: [
      { order: 1, action_type: "send_email", delay: "1d", window_policy: "respect_window" },
      { order: 2, action_type: "send_email", delay: "5d", window_policy: "respect_window" },
      { order: 3, action_type: "send_email", delay: "10d", window_policy: "respect_window" },
    ],
    compiledPlan: {
      trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
      steps: [
        { order: 1, action_type: "send_email", delay: "1d", window_policy: "respect_window", brain_instruction: "Low-pressure check-in. Ask if anything is blocking them. No pitch." },
        { order: 2, action_type: "send_email", delay: "5d", window_policy: "respect_window", brain_instruction: "Share what other teams are building this month. Inspire without pressuring.", condition: { lifecycle_state: "at_risk" } },
        { order: 3, action_type: "send_email", delay: "10d", window_policy: "respect_window", brain_instruction: "Offer a short call to help them get unstuck. Make it easy to accept or decline.", condition: { lifecycle_state: "at_risk" } },
      ],
      exit_conditions: [{ lifecycle_state_change: { to: "engaged" } }, { lifecycle_state_change: { to: "churned" } }],
    },
  },
  {
    name: "Payment recovery",
    description: "[seeder] Dunning sequence for past-due accounts",
    triggerType: "event",
    triggerConfig: { event_name: "payment_failed" },
    source: "manual",
    contentMode: "fixed_content",
    status: "active",
    approvalMode: "auto",
    flowClass: "critical",
    reentryPolicy: "every_time",
    promptSource: null,
    compileStatus: "ready",
    steps: [
      { order: 1, action_type: "send_email", delay: "0m", window_policy: "immediate" },
      { order: 2, action_type: "send_email", delay: "3d", window_policy: "immediate" },
      { order: 3, action_type: "send_email", delay: "7d", window_policy: "immediate" },
    ],
    compiledPlan: {
      trigger: { type: "event", condition: { event_name: "payment_failed" } },
      steps: [
        { order: 1, action_type: "send_email", delay: "0m", window_policy: "immediate", template_ref: "payment_failed_1" },
        { order: 2, action_type: "send_email", delay: "3d", window_policy: "immediate", template_ref: "payment_failed_2" },
        { order: 3, action_type: "send_email", delay: "7d", window_policy: "immediate", template_ref: "payment_failed_3" },
      ],
      exit_conditions: [{ event: "payment_succeeded" }],
    },
  },
  {
    name: "Dormant re-engagement",
    description: "[seeder] Try to bring back dormant users before they churn",
    triggerType: "segment",
    triggerConfig: { tenure_bucket: "established", recency_bucket: "dormant" },
    source: "brain_suggested",
    contentMode: "ai_drafted",
    status: "paused",
    approvalMode: "require",
    flowClass: "nurture",
    reentryPolicy: "cooldown",
    promptSource:
      "For established users who have gone dormant, send one email highlighting the three features shipped since they last visited. Keep it factual and short.",
    compileStatus: "ready",
    steps: [
      { order: 1, action_type: "send_email", delay: "0m", window_policy: "respect_window" },
    ],
    compiledPlan: {
      trigger: { type: "segment", condition: { tenure_bucket: "established", recency_bucket: "dormant" } },
      steps: [
        { order: 1, action_type: "send_email", delay: "0m", window_policy: "respect_window", brain_instruction: "Three features shipped since they last visited. Factual, short, one link to the changelog." },
      ],
      exit_conditions: [{ event: "session_started" }],
    },
  },
  {
    name: "Upgrade path",
    description: "[seeder] Guide engaged free users toward paid",
    triggerType: "lifecycle_transition",
    triggerConfig: { from: "activated", to: "engaged" },
    source: "manual",
    contentMode: "ai_drafted",
    status: "draft",
    approvalMode: "require",
    flowClass: "nurture",
    reentryPolicy: "once",
    promptSource:
      "When a free user becomes engaged, wait 7 days and then send a single email showing what they would unlock on the paid plan. Make it specific to their usage patterns. Do not hard-sell.",
    compileStatus: null,
    steps: [],
    compiledPlan: null,
  },
];

// ---------------------------------------------------------------------------
// Email subjects and content for messages
// ---------------------------------------------------------------------------
const SUBJECTS = {
  welcome: [
    "Welcome aboard - here is how to get started",
    "You are in - your quickstart guide",
    "Welcome to Claros - one thing to try first",
  ],
  activation: [
    "One step away from your first insight",
    "A quick tip to get the most from your workspace",
    "Getting started takes two minutes",
  ],
  winback: [
    "Still there? A quick question about your workspace",
    "What teams are building this month",
    "Would a quick call help?",
    "We shipped three things you asked for",
  ],
  payment: [
    "Action needed: your payment did not go through",
    "Reminder: update your payment method",
    "Final notice: your account will be paused tomorrow",
  ],
  reengagement: [
    "Three things that changed since you last visited",
    "Your workspace is waiting",
  ],
};

function htmlBody(subject, bodyText) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:24px;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.6"><p style="margin:0 0 16px">${bodyText.replace(/\n/g, '</p><p style="margin:0 0 16px">')}</p></body></html>`;
}

const BODY_TEXTS = {
  welcome: [
    "Hi there,\n\nWelcome to the team. Your workspace is ready and waiting.\n\nThe quickstart takes about five minutes: connect your email provider, create your first flow, and send a test event. Everything else builds from there.\n\nIf you get stuck, reply to this email - it goes to a real person.",
    "Good to have you.\n\nMost teams start by connecting their event stream and activating the welcome flow from the library. It takes about three minutes.\n\nThe docs cover everything else, but honestly, the product is more intuitive than any doc.",
  ],
  activation: [
    "Hi,\n\nI noticed your workspace is set up but you have not sent your first event yet. That one step unlocks everything: lifecycle tracking, flows, the retention grid.\n\nHere is the quickest path: copy the curl snippet from the Integrate page and run it. Ten seconds, and you will see the event arrive.",
  ],
  winback: [
    "Hi,\n\nYour workspace has been quiet for a couple of weeks. That is completely fine - just checking if anything is blocking you.\n\nIf something did not work the way you expected, I would genuinely like to hear about it. Reply to this email.",
    "Hi,\n\nHere is what other teams shipped this month: three new trigger types, a retention grid you can click into, and a faster compile pipeline.\n\nYour workspace is still there, exactly how you left it.",
    "Hi,\n\nWould a quick 15-minute call help you get unstuck? No pitch, just help.\n\nBook a time here or reply with a day that works.",
  ],
  payment: [
    "Hi,\n\nYour latest payment did not go through. This sometimes happens with expired cards or insufficient funds.\n\nYou can update your payment method in Settings. Your account continues working normally for now.",
    "Hi,\n\nThis is a reminder that your payment method needs updating. Your account will be paused in 4 days if we cannot process the charge.\n\nUpdate it here - takes less than a minute.",
    "Hi,\n\nFinal notice: your account will be paused tomorrow unless we can process payment. All your data is safe and everything resumes the moment payment goes through.\n\nUpdate your payment method now.",
  ],
};

const BRAIN_REASONINGS = [
  "Contact signed up 5 days ago and has not activated. The getting-started guide is the most common unblock for users at this stage. Kept it to one clear action.",
  "Contact has been at_risk for 14 days after steady engagement. First touch should be low-pressure and question-led, not a discount. Three sentences and one link.",
  "This is the second touch in the win-back sequence. Sharing what other teams are building provides social proof without pressure. Kept it factual.",
  "Contact is engaged and on the free plan for 10 days. Showing concrete features they would unlock is more effective than generic upgrade messaging. Made it specific to their usage pattern.",
  "Payment failed. This is the immediate notification - factual, no alarm, clear action. The dunning sequence escalates only if this does not resolve.",
  "Dormant for 30+ days. Leading with shipped features respects their intelligence and gives them a reason to return. No guilt or pressure.",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Find tenant
  const tenantRows = await query("SELECT id FROM tenants WHERE slug = $1", [TENANT_SLUG]);
  if (tenantRows.length === 0) {
    console.error(`Error: tenant with slug "${TENANT_SLUG}" not found.`);
    console.error("Run the server once to create the default tenant, or use --tenant-slug <slug>.");
    process.exit(1);
  }
  const tenantId = tenantRows[0].id;
  console.log(`Tenant: ${TENANT_SLUG} (${tenantId})`);

  // --- Purge previous seeded data ---
  console.log("Purging previous seed data...");

  // Delete in dependency order: message_events -> lifecycle_messages -> flow_memberships -> flows
  // Also: events, lifecycle_transitions, retention_grid_snapshots, contacts
  // Identify seeded flows by description prefix
  const seededFlowIds = (
    await query(
      "SELECT id FROM flows WHERE tenant_id = $1 AND description LIKE '[seeder]%'",
      [tenantId]
    )
  ).map((r) => r.id);

  if (seededFlowIds.length > 0) {
    const flowPlaceholders = seededFlowIds.map((_, i) => `$${i + 2}`).join(",");

    // message_events for messages in seeded flows
    await query(
      `DELETE FROM message_events WHERE tenant_id = $1 AND message_id IN (
        SELECT id FROM lifecycle_messages WHERE tenant_id = $1 AND flow_id IN (${flowPlaceholders})
      )`,
      [tenantId, ...seededFlowIds]
    );

    // lifecycle_messages
    await query(
      `DELETE FROM lifecycle_messages WHERE tenant_id = $1 AND flow_id IN (${flowPlaceholders})`,
      [tenantId, ...seededFlowIds]
    );

    // flow_memberships
    await query(
      `DELETE FROM flow_memberships WHERE tenant_id = $1 AND flow_id IN (${flowPlaceholders})`,
      [tenantId, ...seededFlowIds]
    );

    // flows
    await query(
      `DELETE FROM flows WHERE tenant_id = $1 AND id IN (${flowPlaceholders})`,
      [tenantId, ...seededFlowIds]
    );
  }

  // Seeded contacts identified by properties._seeder
  const seededContactIds = (
    await query(
      "SELECT id FROM contacts WHERE tenant_id = $1 AND properties->>'_seeder' = 'screenshots'",
      [tenantId]
    )
  ).map((r) => r.id);

  if (seededContactIds.length > 0) {
    const cPlaceholders = seededContactIds.map((_, i) => `$${i + 2}`).join(",");

    // events for seeded contacts
    await query(
      `DELETE FROM events WHERE tenant_id = $1 AND contact_id IN (${cPlaceholders})`,
      [tenantId, ...seededContactIds]
    );

    // lifecycle_transitions
    await query(
      `DELETE FROM lifecycle_transitions WHERE tenant_id = $1 AND contact_id IN (${cPlaceholders})`,
      [tenantId, ...seededContactIds]
    );

    // contacts
    await query(
      `DELETE FROM contacts WHERE tenant_id = $1 AND id IN (${cPlaceholders})`,
      [tenantId, ...seededContactIds]
    );
  }

  // retention_grid_snapshots (all seeded dates - we write them for 30 days back)
  await query(
    "DELETE FROM retention_grid_snapshots WHERE tenant_id = $1 AND snapshot_date >= $2",
    [tenantId, "2026-05-01"]
  );

  console.log("  Purge complete.");

  if (PURGE_ONLY) {
    console.log("--purge mode: done.");
    await pool.end();
    return;
  }

  // =========================================================================
  // PHASE 1: Create contacts with realistic arrival timeline
  // =========================================================================
  console.log("Creating contacts...");

  // Distribute contacts across time for retention grid coverage:
  // Tenure buckets: new [0,30), growing [30,90), established [90,180), loyal [180+]
  // With natural_frequency_days=7:
  //   Recency: active [0,7), cooling [7,14), idle [14,28), dormant [28+]
  //
  // Target distribution (120 contacts):
  //   new:         20 contacts (first_seen 0-29 days ago)
  //   growing:     35 contacts (first_seen 30-89 days ago)
  //   established: 40 contacts (first_seen 90-179 days ago)
  //   loyal:       25 contacts (first_seen 180+ days ago)
  //
  // Recency spread within each tenure:
  //   active ~40%, cooling ~25%, idle ~20%, dormant ~15%

  const TENURE_RANGES = [
    { bucket: "new", count: 20, minDays: 1, maxDays: 29 },
    { bucket: "growing", count: 35, minDays: 30, maxDays: 89 },
    { bucket: "established", count: 40, minDays: 90, maxDays: 179 },
    { bucket: "loyal", count: 25, minDays: 180, maxDays: 270 },
  ];

  const RECENCY_DISTRIBUTION = [
    { bucket: "active", weight: 0.40, minDays: 0, maxDays: 6 },
    { bucket: "cooling", weight: 0.25, minDays: 7, maxDays: 13 },
    { bucket: "idle", weight: 0.20, minDays: 14, maxDays: 27 },
    { bucket: "dormant", weight: 0.15, minDays: 28, maxDays: 60 },
  ];

  // Lifecycle state distribution (weighted, varies by recency):
  // active recency -> mostly engaged/activated
  // cooling -> engaged/at_risk mix
  // idle -> at_risk/dormant
  // dormant -> dormant/churned
  const STATE_BY_RECENCY = {
    active: ["engaged", "engaged", "engaged", "activated", "activated", "signed_up", "resurrected"],
    cooling: ["engaged", "engaged", "at_risk", "at_risk", "activated"],
    idle: ["at_risk", "at_risk", "dormant", "engaged"],
    dormant: ["dormant", "dormant", "churned", "churned", "at_risk"],
  };

  const DEPTH_BY_STATE = {
    engaged: ["power", "regular", "regular", "casual"],
    activated: ["regular", "casual", "casual", "minimal"],
    signed_up: ["minimal", "minimal", null],
    at_risk: ["regular", "casual", "casual", "minimal"],
    dormant: ["casual", "minimal", "minimal", null],
    churned: ["minimal", null, null],
    resurrected: ["regular", "casual"],
  };

  const PAYMENT_BY_STATE = {
    engaged: ["paid", "paid", "paid", "free", "trial"],
    activated: ["free", "free", "trial", "trial"],
    signed_up: ["free", "free", "free"],
    at_risk: ["paid", "paid", "free", "past_due"],
    dormant: ["paid", "free", "cancelled"],
    churned: ["cancelled", "cancelled", "free"],
    resurrected: ["paid", "free", "trial"],
  };

  let personIdx = 0;
  const contactRows = []; // { id, externalId, ...person, firstSeenAt, lastSeenAt, state, ... }

  for (const tenure of TENURE_RANGES) {
    for (let i = 0; i < tenure.count; i++) {
      const person = PEOPLE[personIdx % PEOPLE.length];
      personIdx++;

      const firstSeenDaysAgo = randInt(tenure.minDays, tenure.maxDays);
      const firstSeenAt = daysAgo(firstSeenDaysAgo);

      // Assign recency bucket
      const recencyRoll = rng();
      let cumulative = 0;
      let recencyDef = RECENCY_DISTRIBUTION[0];
      for (const rd of RECENCY_DISTRIBUTION) {
        cumulative += rd.weight;
        if (recencyRoll <= cumulative) {
          recencyDef = rd;
          break;
        }
      }

      const lastSeenDaysAgo = randInt(recencyDef.minDays, recencyDef.maxDays);
      // last_seen cannot be before first_seen
      const effectiveLastSeenDaysAgo = Math.min(lastSeenDaysAgo, firstSeenDaysAgo - 1);
      const lastSeenAt = daysAgo(Math.max(0, effectiveLastSeenDaysAgo));

      const state = pick(STATE_BY_RECENCY[recencyDef.bucket]);
      const depth = pick(DEPTH_BY_STATE[state] || [null]);
      const payment = pick(PAYMENT_BY_STATE[state] || ["free"]);

      // activated_at: only if state is beyond signed_up
      let activatedAt = null;
      if (["activated", "engaged", "at_risk", "dormant", "churned", "resurrected"].includes(state)) {
        const activationDelay = randInt(1, Math.min(7, firstSeenDaysAgo - 1 || 1));
        activatedAt = daysAgo(firstSeenDaysAgo - activationDelay);
      }

      // Event counts for engagement depth calculation
      const eventCounts = {
        power: [randInt(15, 30), randInt(12, 25)],
        regular: [randInt(5, 12), randInt(4, 10)],
        casual: [randInt(2, 4), randInt(1, 3)],
        minimal: [randInt(1, 2), randInt(0, 1)],
      };
      const [bucketCurrent, bucketPrev] = depth
        ? eventCounts[depth]
        : [0, 0];

      const id = seedUUID();
      const externalId = `usr_${person.email.split("@")[0].replace(/\./g, "_")}`;

      contactRows.push({
        id,
        tenantId,
        externalId,
        email: person.email,
        name: person.name,
        company: person.company,
        lifecycleState: state,
        engagementDepth: depth,
        paymentStatus: payment,
        firstSeenAt,
        lastSeenAt,
        activatedAt,
        eventCountBucketCurrent: bucketCurrent,
        eventCountBucketPrev: bucketPrev,
        tenure: tenure.bucket,
        recency: recencyDef.bucket,
      });
    }
  }

  // Insert contacts
  for (const c of contactRows) {
    await query(
      `INSERT INTO contacts (id, tenant_id, external_id, email, name, company, properties,
        lifecycle_state, engagement_depth, payment_status, first_seen_at, last_seen_at,
        activated_at, created_at, event_count_bucket_current, event_count_bucket_prev,
        last_counter_reset_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        c.id, tenantId, c.externalId, c.email, c.name, c.company,
        JSON.stringify({ _seeder: "screenshots", company: c.company }),
        c.lifecycleState, c.engagementDepth, c.paymentStatus,
        iso(c.firstSeenAt), iso(c.lastSeenAt),
        c.activatedAt ? iso(c.activatedAt) : null,
        iso(c.firstSeenAt), // created_at = first_seen_at
        c.eventCountBucketCurrent, c.eventCountBucketPrev,
        iso(daysAgo(15)), // last counter reset
      ]
    );
  }
  console.log(`  Created ${contactRows.length} contacts.`);

  // =========================================================================
  // PHASE 2: Create flows
  // =========================================================================
  console.log("Creating flows...");
  const flowIds = {};

  for (const def of FLOW_DEFS) {
    const id = seedUUID();
    flowIds[def.name] = id;

    const createdDaysAgo = randInt(30, 90);
    const createdAt = daysAgo(createdDaysAgo);
    const compiledAt = def.compileStatus === "ready"
      ? jitter(createdAt, 2 * HOUR_MS)
      : null;

    await query(
      `INSERT INTO flows (id, tenant_id, name, description, priority, trigger_type,
        trigger_config, steps, source, content_mode, status, approval_mode,
        flow_class, reentry_policy, reentry_cooldown_days, prompt_source,
        compiled_plan, compiled_at, compile_status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        id, tenantId, def.name, def.description, 0, def.triggerType,
        JSON.stringify(def.triggerConfig), JSON.stringify(def.steps),
        def.source, def.contentMode, def.status, def.approvalMode,
        def.flowClass, def.reentryPolicy, 30,
        def.promptSource,
        def.compiledPlan ? JSON.stringify(def.compiledPlan) : null,
        compiledAt ? iso(compiledAt) : null,
        def.compileStatus,
        iso(createdAt), iso(createdAt),
      ]
    );
  }
  console.log(`  Created ${FLOW_DEFS.length} flows.`);

  // =========================================================================
  // PHASE 3: Create lifecycle transitions (movement data)
  // =========================================================================
  console.log("Creating lifecycle transitions...");

  // For each contact that is beyond signed_up, create the transition history
  // that got them to their current state.
  const LEGAL_PATHS = {
    activated: [["signed_up", "activated"]],
    engaged: [["signed_up", "activated"], ["activated", "engaged"]],
    at_risk: [["signed_up", "activated"], ["activated", "engaged"], ["engaged", "at_risk"]],
    dormant: [["signed_up", "activated"], ["activated", "engaged"], ["engaged", "at_risk"], ["at_risk", "dormant"]],
    churned: [["signed_up", "activated"], ["activated", "engaged"], ["engaged", "at_risk"], ["at_risk", "dormant"], ["dormant", "churned"]],
    resurrected: [["signed_up", "activated"], ["activated", "engaged"], ["engaged", "at_risk"], ["at_risk", "dormant"], ["dormant", "churned"], ["churned", "resurrected"]],
  };

  let transitionCount = 0;
  for (const c of contactRows) {
    const path = LEGAL_PATHS[c.lifecycleState];
    if (!path) continue; // signed_up has no transitions

    const totalDays = (NOW.getTime() - c.firstSeenAt.getTime()) / DAY_MS;
    const stepGap = Math.max(1, totalDays / (path.length + 1));

    for (let i = 0; i < path.length; i++) {
      const [from, to] = path[i];
      const transAt = new Date(c.firstSeenAt.getTime() + stepGap * (i + 1) * DAY_MS);
      // Do not create transitions in the future
      if (transAt > NOW) break;

      await query(
        `INSERT INTO lifecycle_transitions (id, tenant_id, contact_id, from_state, to_state, transitioned_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [seedUUID(), tenantId, c.id, from, to, iso(transAt)]
      );
      transitionCount++;
    }
  }
  console.log(`  Created ${transitionCount} transitions.`);

  // =========================================================================
  // PHASE 4: Create flow memberships and messages
  // =========================================================================
  console.log("Creating flow memberships and messages...");

  // Select subsets of contacts for each flow
  const activeContacts = contactRows.filter(
    (c) => ["engaged", "activated", "resurrected"].includes(c.lifecycleState)
  );
  const atRiskContacts = contactRows.filter((c) => c.lifecycleState === "at_risk");
  const signedUpContacts = contactRows.filter((c) => c.lifecycleState === "signed_up");
  const dormantContacts = contactRows.filter(
    (c) => c.lifecycleState === "dormant"
  );

  let membershipCount = 0;
  let messageCount = 0;
  const allMessages = []; // track for message_events later

  // Helper to create a membership + messages for a flow
  async function createMembershipWithMessages(flowDef, flowId, contact, options = {}) {
    const {
      enteredDaysAgo,
      completedSteps = 0,
      membershipStatus = "active",
    } = options;

    const enteredAt = daysAgo(enteredDaysAgo);
    const membershipId = seedUUID();
    const completedAt = membershipStatus === "completed"
      ? jitter(daysAgo(enteredDaysAgo - completedSteps * 2 - 1), DAY_MS)
      : null;

    await query(
      `INSERT INTO flow_memberships (id, tenant_id, contact_id, flow_id, current_step, status,
        entered_at, completed_at, exited_at, exit_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        membershipId, tenantId, contact.id, flowId,
        Math.min(completedSteps + 1, flowDef.steps.length),
        membershipStatus,
        iso(enteredAt),
        completedAt ? iso(completedAt) : null,
        membershipStatus === "exited" ? iso(completedAt || enteredAt) : null,
        membershipStatus === "completed" ? "completed" : membershipStatus === "exited" ? "condition_met" : null,
      ]
    );
    membershipCount++;

    // Create messages for completed steps
    for (let step = 1; step <= completedSteps && step <= flowDef.steps.length; step++) {
      const msgId = seedUUID();
      const stepDelay = step * 2; // rough days between steps
      const createdAt = new Date(enteredAt.getTime() + stepDelay * DAY_MS);
      if (createdAt > NOW) break;

      // Determine message status and timing
      const category = flowDef.name.includes("Welcome") ? "welcome"
        : flowDef.name.includes("Activation") ? "activation"
        : flowDef.name.includes("Win-back") ? "winback"
        : flowDef.name.includes("Payment") ? "payment"
        : "reengagement";

      const subject = pick(SUBJECTS[category] || SUBJECTS.welcome);
      const bodyTextContent = pick(BODY_TEXTS[category] || BODY_TEXTS.welcome);
      const body = htmlBody(subject, bodyTextContent);
      const reasoning = pick(BRAIN_REASONINGS);

      // Most completed-step messages are sent; some are in various states
      let msgStatus, feedback, sentAt, approvedAt;
      const statusRoll = rng();

      if (statusRoll < 0.75) {
        msgStatus = "sent";
        approvedAt = jitter(createdAt, 4 * HOUR_MS);
        sentAt = jitter(approvedAt, HOUR_MS);
        // Feedback: 60% opened, 25% clicked, 10% bounced, 5% nothing
        const fbRoll = rng();
        if (fbRoll < 0.25) feedback = "clicked";
        else if (fbRoll < 0.60) feedback = "opened";
        else if (fbRoll < 0.70) feedback = "bounced";
        else feedback = null;
      } else if (statusRoll < 0.85) {
        msgStatus = "sent";
        approvedAt = jitter(createdAt, 4 * HOUR_MS);
        sentAt = jitter(approvedAt, HOUR_MS);
        feedback = null;
      } else if (statusRoll < 0.92) {
        msgStatus = "failed";
        approvedAt = jitter(createdAt, 4 * HOUR_MS);
        sentAt = null;
        feedback = null;
      } else {
        msgStatus = "suppressed";
        approvedAt = null;
        sentAt = null;
        feedback = null;
      }

      await query(
        `INSERT INTO lifecycle_messages (id, tenant_id, contact_id, flow_id, membership_id,
          flow_step_order, status, feedback, subject, body_html, body_text,
          brain_reasoning, brain_action_type, scheduled_send_at, approved_at,
          sent_at, recipient_address, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          msgId, tenantId, contact.id, flowId, membershipId,
          step, msgStatus, feedback, subject, body, bodyTextContent,
          flowDef.contentMode === "ai_drafted" ? reasoning : null,
          "send_email",
          iso(createdAt),
          approvedAt ? iso(approvedAt) : null,
          sentAt ? iso(sentAt) : null,
          msgStatus === "sent" || msgStatus === "failed" ? contact.email : null,
          iso(createdAt), iso(sentAt || approvedAt || createdAt),
        ]
      );
      messageCount++;

      if (sentAt) {
        allMessages.push({
          id: msgId,
          sentAt,
          feedback,
          contactId: contact.id,
        });
      }
    }

    return membershipId;
  }

  // Welcome sequence: most contacts went through it
  const welcomeFlow = FLOW_DEFS[0];
  const welcomeFlowId = flowIds["Welcome sequence"];
  const welcomeContacts = shuffle(contactRows).slice(0, 80);
  for (const contact of welcomeContacts) {
    const daysInSystem = Math.floor((NOW.getTime() - contact.firstSeenAt.getTime()) / DAY_MS);
    const stepsCompleted = Math.min(3, Math.floor(daysInSystem / 3));
    const status = stepsCompleted >= 3 ? "completed" : contact.lifecycleState === "signed_up" ? "active" : "completed";
    await createMembershipWithMessages(welcomeFlow, welcomeFlowId, contact, {
      enteredDaysAgo: daysInSystem,
      completedSteps: stepsCompleted,
      membershipStatus: status,
    });
  }

  // Activation nudge: signed_up contacts
  const activationFlow = FLOW_DEFS[1];
  const activationFlowId = flowIds["Activation nudge"];
  for (const contact of signedUpContacts.slice(0, 8)) {
    const daysInSystem = Math.floor((NOW.getTime() - contact.firstSeenAt.getTime()) / DAY_MS);
    await createMembershipWithMessages(activationFlow, activationFlowId, contact, {
      enteredDaysAgo: Math.min(daysInSystem - 3, 20),
      completedSteps: 1,
      membershipStatus: "active",
    });
  }

  // Win-back: at-risk contacts
  const winbackFlow = FLOW_DEFS[2];
  const winbackFlowId = flowIds["Win-back: at-risk users"];
  for (const contact of atRiskContacts.slice(0, 15)) {
    const stepsCompleted = randInt(1, 3);
    await createMembershipWithMessages(winbackFlow, winbackFlowId, contact, {
      enteredDaysAgo: randInt(5, 30),
      completedSteps: stepsCompleted,
      membershipStatus: stepsCompleted >= 3 ? "completed" : "active",
    });
  }

  // Payment recovery: a few contacts
  const paymentFlow = FLOW_DEFS[3];
  const paymentFlowId = flowIds["Payment recovery"];
  const pastDueContacts = contactRows.filter((c) => c.paymentStatus === "past_due" || c.paymentStatus === "cancelled");
  for (const contact of pastDueContacts.slice(0, 6)) {
    await createMembershipWithMessages(paymentFlow, paymentFlowId, contact, {
      enteredDaysAgo: randInt(3, 15),
      completedSteps: randInt(1, 3),
      membershipStatus: pick(["completed", "active"]),
    });
  }

  console.log(`  Created ${membershipCount} memberships and ${messageCount} messages.`);

  // =========================================================================
  // PHASE 5: Create pending_approval messages (for Approvals screen)
  // =========================================================================
  console.log("Creating pending approval messages...");

  // Use the dormant re-engagement flow (paused, so no prior memberships) for approvals
  const approvalFlowDef = FLOW_DEFS[4]; // "Dormant re-engagement"
  const approvalFlowId = flowIds[approvalFlowDef.name];
  const approvalContacts = shuffle(contactRows).slice(0, 10);
  let approvalCount = 0;

  for (const contact of approvalContacts) {
    const membershipId = seedUUID();

    // Create a membership for this pending message
    await query(
      `INSERT INTO flow_memberships (id, tenant_id, contact_id, flow_id, current_step, status, entered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [membershipId, tenantId, contact.id, approvalFlowId, 1, "active", iso(daysAgo(randInt(1, 5)))]
    );

    const category = "reengagement";
    const subject = pick(SUBJECTS[category].concat(SUBJECTS.winback));
    const bodyTextContent = pick(BODY_TEXTS.winback);
    const body = htmlBody(subject, bodyTextContent);
    const reasoning = pick(BRAIN_REASONINGS);

    await query(
      `INSERT INTO lifecycle_messages (id, tenant_id, contact_id, flow_id, membership_id,
        flow_step_order, status, subject, body_html, body_text,
        brain_reasoning, brain_action_type, scheduled_send_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        seedUUID(), tenantId, contact.id, approvalFlowId, membershipId,
        1, "pending_approval", subject, body, bodyTextContent,
        reasoning, "send_email",
        iso(hoursAgo(randInt(1, 48))),
        iso(hoursAgo(randInt(2, 72))),
        iso(hoursAgo(randInt(1, 48))),
      ]
    );
    approvalCount++;
  }
  console.log(`  Created ${approvalCount} pending approval messages.`);

  // =========================================================================
  // PHASE 6: Create events (ingestion history for the home screen)
  // =========================================================================
  console.log("Creating events...");

  // Ensure event partitions exist for the months we need (May-June 2026).
  // This is operational DDL (like a partition maintenance cron), not a migration.
  const neededPartitions = [
    { name: "events_y2026m05", from: "2026-05-01", to: "2026-06-01" },
    { name: "events_y2026m06", from: "2026-06-01", to: "2026-07-01" },
  ];
  for (const part of neededPartitions) {
    const exists = await query(
      "SELECT 1 FROM pg_class WHERE relname = $1",
      [part.name]
    );
    if (exists.length === 0) {
      await query(
        `CREATE TABLE ${part.name} PARTITION OF events FOR VALUES FROM ('${part.from}') TO ('${part.to}')`,
        []
      );
      console.log(`  Created partition ${part.name}`);
    }
  }

  const EVENT_NAMES = [
    "signed_up", "project_created", "invite_sent", "report_viewed",
    "dashboard_opened", "settings_changed", "file_uploaded", "comment_added",
    "plan_upgraded", "session_started", "feature_used", "export_completed",
  ];

  let eventCount = 0;
  // Create events for the last 90 days, with increasing frequency toward recent
  for (const contact of contactRows) {
    const daysInSystem = Math.floor((NOW.getTime() - contact.firstSeenAt.getTime()) / DAY_MS);
    const eventsToCreate = Math.min(
      contact.eventCountBucketCurrent + contact.eventCountBucketPrev + randInt(2, 8),
      20
    );

    for (let i = 0; i < eventsToCreate; i++) {
      // Bias events toward earlier in their tenure (more realistic)
      const eventDaysAgo = randInt(0, Math.min(daysInSystem, 90));
      const eventAt = jitter(daysAgo(eventDaysAgo), DAY_MS);

      // first event should be identify with signed_up
      const isFirst = i === 0;
      const eventName = isFirst ? "signed_up" : pick(EVENT_NAMES);
      const eventType = isFirst ? "identify" : "track";

      await query(
        `INSERT INTO events (id, tenant_id, contact_id, type, event_name, properties, timestamp, received_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          seedUUID(), tenantId, contact.id, eventType, eventName,
          JSON.stringify({ source: "seed" }),
          iso(eventAt), iso(jitter(eventAt, 5000)), // received shortly after
        ]
      );
      eventCount++;
    }
  }
  console.log(`  Created ${eventCount} events.`);

  // =========================================================================
  // PHASE 7: Create message_events (delivery events for Analytics trends)
  // =========================================================================
  console.log("Creating message events...");

  let messageEventCount = 0;
  for (const msg of allMessages) {
    if (!msg.sentAt) continue;

    // Every sent message gets a delivered event
    const deliveredAt = jitter(msg.sentAt, 30000); // within 30s
    const deliveredEvtId = seedUUID();
    await query(
      `INSERT INTO message_events (id, tenant_id, message_id, event_type, occurred_at, provider_event_id)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [deliveredEvtId, tenantId, msg.id, "delivered", iso(deliveredAt), `evt_del_${deliveredEvtId.slice(24)}`]
    );
    messageEventCount++;

    // Opens: if feedback is opened or clicked
    if (msg.feedback === "opened" || msg.feedback === "clicked") {
      const openedAt = jitter(deliveredAt, 4 * HOUR_MS);
      const openedEvtId = seedUUID();
      await query(
        `INSERT INTO message_events (id, tenant_id, message_id, event_type, occurred_at, provider_event_id)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [openedEvtId, tenantId, msg.id, "opened", iso(openedAt), `evt_opn_${openedEvtId.slice(24)}`]
      );
      messageEventCount++;

      // Clicks: if feedback is clicked
      if (msg.feedback === "clicked") {
        const clickedAt = jitter(openedAt, HOUR_MS);
        const clickedEvtId = seedUUID();
        await query(
          `INSERT INTO message_events (id, tenant_id, message_id, event_type, occurred_at, provider_event_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [clickedEvtId, tenantId, msg.id, "clicked", iso(clickedAt), `evt_clk_${clickedEvtId.slice(24)}`]
        );
        messageEventCount++;
      }
    }

    // Bounces
    if (msg.feedback === "bounced") {
      const bouncedAt = jitter(deliveredAt, 60000);
      const bouncedEvtId = seedUUID();
      await query(
        `INSERT INTO message_events (id, tenant_id, message_id, event_type, occurred_at, provider_event_id, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          bouncedEvtId, tenantId, msg.id, "bounced", iso(bouncedAt),
          `evt_bnc_${bouncedEvtId.slice(24)}`,
          JSON.stringify({ bounce_type: "hard", reason: "mailbox_not_found" }),
        ]
      );
      messageEventCount++;
    }
  }
  console.log(`  Created ${messageEventCount} message events.`);

  // =========================================================================
  // PHASE 8: Create retention grid snapshots (30 days of history)
  // =========================================================================
  console.log("Creating retention grid snapshots...");

  const TENURE_BUCKETS = ["new", "growing", "established", "loyal"];
  const RECENCY_BUCKETS = ["active", "cooling", "idle", "dormant"];

  // Count current distribution
  const currentGrid = {};
  for (const tb of TENURE_BUCKETS) {
    for (const rb of RECENCY_BUCKETS) {
      currentGrid[`${tb}:${rb}`] = { count: 0, paying: 0 };
    }
  }
  for (const c of contactRows) {
    const key = `${c.tenure}:${c.recency}`;
    currentGrid[key].count++;
    if (c.paymentStatus === "paid" || c.paymentStatus === "past_due") {
      currentGrid[key].paying++;
    }
  }

  // Create 30 days of snapshots with gradual change
  let snapshotCount = 0;
  for (let d = 30; d >= 0; d--) {
    const snapshotDate = daysAgo(d).toISOString().slice(0, 10);
    for (const tb of TENURE_BUCKETS) {
      for (const rb of RECENCY_BUCKETS) {
        const current = currentGrid[`${tb}:${rb}`];
        // Slight variation over time (fewer contacts further back, growing toward now)
        const timeFactor = 1 - (d / 30) * 0.3; // 70% to 100% of current count
        const noise = randInt(-1, 1);
        const count = Math.max(0, Math.round(current.count * timeFactor) + noise);
        const paying = Math.min(count, Math.max(0, Math.round(current.paying * timeFactor) + (rng() > 0.7 ? 1 : 0)));

        await query(
          `INSERT INTO retention_grid_snapshots (tenant_id, snapshot_date, tenure_bucket, recency_bucket, contact_count, paying_count)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (tenant_id, snapshot_date, tenure_bucket, recency_bucket)
          DO UPDATE SET contact_count = EXCLUDED.contact_count, paying_count = EXCLUDED.paying_count`,
          [tenantId, snapshotDate, tb, rb, count, paying]
        );
        snapshotCount++;
      }
    }
  }
  console.log(`  Created ${snapshotCount} retention grid snapshot rows.`);

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n--- Seed complete ---");
  console.log(`  Contacts:        ${contactRows.length}`);
  console.log(`  Flows:           ${FLOW_DEFS.length}`);
  console.log(`  Transitions:     ${transitionCount}`);
  console.log(`  Memberships:     ${membershipCount}`);
  console.log(`  Messages:        ${messageCount + approvalCount}`);
  console.log(`  Message events:  ${messageEventCount}`);
  console.log(`  Events:          ${eventCount}`);
  console.log(`  Grid snapshots:  ${snapshotCount}`);
  console.log("\nRetention grid (current):");
  console.log("              Active  Cooling  Idle  Dormant");
  for (const tb of TENURE_BUCKETS) {
    const row = RECENCY_BUCKETS.map((rb) => {
      const cell = currentGrid[`${tb}:${rb}`];
      return String(cell.count).padStart(6);
    }).join("  ");
    console.log(`  ${tb.padEnd(12)} ${row}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
