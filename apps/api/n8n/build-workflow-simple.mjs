// Writes pisowifi-status-workflow.simple.json (deterministic). v4 and its generator are left unchanged.
// Usage: node apps/api/n8n/build-workflow-simple.mjs [--check]   (--check: fail if the committed JSON differs)
//
// Same webhook contract, responses and guarantees as v4, in 11 functional nodes instead of 25:
//   Webhook → Register Attempt → Load Policy → Load History → Decide → Send? ──no──────────────► Respond
//                                                                       └yes→ Each Recipient ──done──► Respond
//                                                                             loop: Reserve → Send Gmail → Record
// How v4's protections map here:
//   - Validate + Plan + Compose (3 Set nodes, 2 Ifs) → one Code node, "Decide", that emits either one item per recipient
//     to email now, or a single reply item. All replies leave through one Respond node.
//   - 4 Data Table reads → 2: the approved machine and recipient ids share one policy table, and one read
//     (machine_id = M OR event_id = E) returns both this event's delivery state and the machine's history.
//   - Concurrency (v4: Reserve → Confirm Reservation → Still Ours? per recipient) → one "attempt" row per execution,
//     written BEFORE the history read. The execution whose attempt row has the lowest id among the live ones goes on;
//     any other answers 503 in_progress. Live = younger than LOCK_MS: longer than the 25 s execution timeout (so a
//     live run is never ignored), and no longer than the dispatcher's shortest retry delay, 30 s after the response
//     (so a genuine retry is never blocked).
//   - In-flight detection stays per recipient: a "sending" row is written right before each Gmail call; one without
//     an outcome row from the same run, younger than INFLIGHT_MS, defers that recipient (503), never resends.
//   - Record Sent / Record Failed / 3 Outcome nodes / Summarize → one Record node (Gmail continues on error, so the
//     item says which) and the Respond node counts the loop's results.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./pisowifi-status-workflow.simple.json", import.meta.url));
const T_LOG = "pisowifi_alert_log";
const T_POLICY = "pisowifi_alert_policy";

const expr = (js) => "={{ " + js.trim().replace(/\n\s*/g, " ") + " }}";
const nodeId = (n) => `5c1e9a02-7b3d-4e58-a6f4-${String(n).padStart(12, "0")}`;
const col = (id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: "string", readOnly: false, removed: false });
const table = (name) => ({ __rl: true, mode: "name", value: name });
const eq = (keyName, keyValue) => ({ keyName, condition: "eq", keyValue });

const HOOK = "$('Webhook').first().json";
const RECIPIENT = "$('Each Recipient').first().json";
const LOG_COLUMNS = ["event_id", "machine_id", "event", "detected_at", "kind", "recipient_id", "run_token", "at"];

// One row of the alert log. kind: attempt (one per execution) | sending (right before a Gmail call) | sent | failed.
// Values are capped, so even an invalid (but authenticated) request writes only one short attempt row.
const logRow = (value) => ({
  resource: "row",
  operation: "insert",
  dataTableId: table(T_LOG),
  columns: {
    mappingMode: "defineBelow",
    value: {
      event_id: `={{ String(${HOOK}.headers?.['x-pisowifi-event-id'] ?? '').slice(0, 64) }}`,
      machine_id: `={{ String(${HOOK}.body?.machine?.id ?? '').slice(0, 64) }}`,
      event: `={{ String(${HOOK}.body?.event ?? '').slice(0, 64) }}`,
      detected_at: `={{ String(${HOOK}.body?.detectedAt ?? '').slice(0, 64) }}`,
      run_token: "={{ $execution.id }}",
      at: "={{ $now.toUTC().toISO() }}",
      ...value,
    },
    matchingColumns: [],
    schema: LOG_COLUMNS.map(col),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});

// ---- Decide: everything that is pure logic, in one place. Reads only earlier nodes; writes nothing.
const DECIDE = String.raw`// Decide: validate → policy → chronology → concurrency lock → per-recipient state → compose.
// Output: one item per recipient to email now ({ send: true, ... }), or one reply item ({ send: false, code, body }).
const INFLIGHT_MS = 120000; // a 'sending' row without an outcome, younger than this, may still be in flight
const LOCK_MS = 30000;      // > the 25 s execution timeout, <= the dispatcher's 30 s minimum retry delay
const EXPECTED_MACHINES = 2;
const EXPECTED_RECIPIENTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const hook = $('Webhook').first().json;
const h = hook.headers ?? {};
const b = hook.body;
const reply = (code, body) => [{ json: { send: false, code, body } }];

// 1. The backend contract (packages/shared/src/notifications.ts) plus the dispatcher's event-ID and timestamp headers.
//    The HMAC signature cannot be checked: the workflow has no access to the secret (N8N_BLOCK_ENV_ACCESS_IN_NODE=true).
function invalidReason() {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body';
  const id = String(h['x-pisowifi-event-id'] ?? '');
  if (!UUID.test(id)) return 'event_id_header';
  if (String(b.eventId ?? '') !== id) return 'event_id_mismatch';
  const ts = String(h['x-pisowifi-timestamp'] ?? '');
  if (!/^[0-9]{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return 'timestamp';
  const pair = b.event === 'machine.unreachable' ? ['Unreachable', 'Reachable'] : b.event === 'machine.reachable' ? ['Reachable', 'Unreachable'] : null;
  if (!pair) return 'event';
  if (b.status !== pair[0] || b.previousStatus !== pair[1]) return 'transition';
  const m = b.machine;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'machine';
  if (!UUID.test(String(m.id ?? ''))) return 'machine_id';
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 120) return 'machine_name';
  if (!/^[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(String(m.ip ?? ''))) return 'machine_ip';
  if (b.timeZone !== 'Asia/Manila' || b.utcOffset !== '+08:00') return 'time_zone';
  const iso = String(b.detectedAt ?? '');
  const at = DateTime.fromISO(iso, { zone: 'utc' });
  if (!/Z$/.test(iso) || !at.isValid) return 'detected_at';
  const age = Date.now() - at.toMillis();
  if (age < -300000 || age > 604800000) return 'detected_at_range';
  const local = at.setZone('Asia/Manila').setLocale('en-US');
  if (b.detectedDate !== local.toFormat('MMMM d, yyyy') || b.detectedTime !== local.toFormat('h:mm a')) return 'detected_local';
  const hasStart = b.outageStartedAt !== undefined && b.outageStartedAt !== null;
  const hasDown = b.downtimeSeconds !== undefined && b.downtimeSeconds !== null;
  if (hasStart !== hasDown) return 'downtime';
  if (hasDown) {
    const s = b.downtimeSeconds;
    const o = DateTime.fromISO(String(b.outageStartedAt), { zone: 'utc' });
    if (b.event !== 'machine.reachable' || !Number.isInteger(s) || s < 0 || !o.isValid || Math.abs(Math.floor((at.toMillis() - o.toMillis()) / 1000) - s) > 1) return 'downtime';
  }
  const r = b.recipients;
  if (!Array.isArray(r) || r.length < 1 || r.length > 20) return 'recipients';
  const seen = new Set();
  for (const x of r) {
    if (!x || typeof x !== 'object' || !UUID.test(String(x.id ?? '')) || seen.has(x.id)) return 'recipients';
    seen.add(x.id);
    const e = String(x.email ?? '');
    if (e.length > 254 || !/^[^@\s,;<>"'()\[\]]+@[^@\s,;<>"'()\[\]]+[.][^@\s,;<>"'()\[\]]+$/.test(e)) return 'recipients';
  }
  return '';
}
const reason = invalidReason();
if (reason) return reply(400, { status: 'invalid', reason });

// 2. Policy: exactly 2 approved machine ids and 3 approved user ids (ids only, never addresses).
const rows = (name) => $(name).all().map((i) => i.json).filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);
const norm = (v) => String(v ?? '').trim().toLowerCase();
const policy = rows('Load Policy');
const ids = (kind) => policy.filter((r) => norm(r.kind) === kind).map((r) => norm(r.ref_id)).filter((v) => v !== '');
const machines = ids('machine');
const people = ids('recipient');
const plan = { total: b.recipients.length, approved: 0, notApproved: 0, alreadySent: 0, inFlight: 0 };
const notSent = (status, code) => reply(code, { status, sent: 0, failed: 0, alreadySent: plan.alreadySent, inFlight: plan.inFlight, notApproved: plan.notApproved, total: plan.total });
if (machines.length !== EXPECTED_MACHINES || new Set(machines).size !== EXPECTED_MACHINES || people.length !== EXPECTED_RECIPIENTS || new Set(people).size !== EXPECTED_RECIPIENTS) return notSent('config_error', 503);
if (!machines.includes(b.machine.id)) return notSent('machine_not_approved', 422);

// 3. Chronology: a newer event of this machine was already emailed → this older one is stale (its outage was reported).
const now = Date.now();
const log = rows('Load History');
const detected = Date.parse(b.detectedAt);
if (log.some((r) => r.kind === 'sent' && r.machine_id === b.machine.id && r.event_id !== b.eventId && Date.parse(String(r.detected_at)) > detected)) return notSent('superseded', 200);

// 4. Per-recipient state of this event: sent, or possibly in flight (a 'sending' row with no outcome from its run).
const ev = log.filter((r) => r.event_id === b.eventId);
const sent = new Set(ev.filter((r) => r.kind === 'sent').map((r) => r.recipient_id));
const settled = new Set(ev.filter((r) => r.kind === 'sent' || r.kind === 'failed').map((r) => r.run_token + '|' + r.recipient_id));
const flying = new Set(ev.filter((r) => r.kind === 'sending' && !settled.has(r.run_token + '|' + r.recipient_id) && now - Date.parse(String(r.at)) < INFLIGHT_MS).map((r) => r.recipient_id));
const toSend = [];
for (const x of b.recipients) {
  if (!people.includes(x.id)) { plan.notApproved++; continue; }
  plan.approved++;
  if (sent.has(x.id)) plan.alreadySent++;
  else if (flying.has(x.id)) plan.inFlight++;
  else toSend.push(x);
}
if (plan.approved === 0) return notSent('no_approved_recipients', 422);

// 5. Concurrency: only the live attempt with the lowest id may send (attempt rows are inserted before this read).
const mine = Number($('Register Attempt').first().json.id);
if (!Number.isFinite(mine)) return notSent('config_error', 503);
if (toSend.length > 0 && ev.some((r) => r.kind === 'attempt' && Number(r.id) < mine && now - Date.parse(String(r.at)) < LOCK_MS)) {
  plan.inFlight += toSend.length;
  toSend.length = 0;
}
if (toSend.length === 0) return plan.inFlight > 0 ? notSent('in_progress', 503) : notSent('duplicate', 200);

// 6. Email text (plain text). Machine name flattened to one line, at most 80 characters.
const name = String(b.machine.name).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const down = b.event === 'machine.unreachable';
const fmt = (s) => {
  if (s < 60) return 'less than 1 minute';
  const m = Math.floor(s / 60);
  return [[Math.floor(m / 1440), 'day'], [Math.floor((m % 1440) / 60), 'hour'], [m % 60, 'minute']].filter((p) => p[0] > 0).map((p) => p[0] + ' ' + p[1] + (p[0] === 1 ? '' : 's')).join(' ');
};
const subject = down ? '[PisoWiFi Alert] ' + name + ' is Offline' : '[PisoWiFi Recovery] ' + name + ' is Back Online';
const lines = [down ? name + ' is Offline.' : name + ' is Back Online.', '', 'Machine: ' + name, 'Previous Status: ' + (down ? 'Online' : 'Offline'), 'Current Status: ' + (down ? 'Offline' : 'Online'), (down ? 'Detected: ' : 'Recovered: ') + b.detectedDate + ', ' + b.detectedTime + ' (Asia/Manila)'];
if (!down && Number.isInteger(b.downtimeSeconds)) lines.push('Downtime: ' + fmt(b.downtimeSeconds));
lines.push('', 'Event ID: ' + b.eventId);
const text = lines.join('\n');
return toSend.map((x) => ({ json: { send: true, recipientId: x.id, email: x.email, subject, text, plan } }));
`;

// ---- the single reply: a reply item from Decide, or the loop's results (one per recipient emailed in this run).
// A Record row says sent/failed; if Record itself failed, the item is Gmail's output (error → failed, else sent).
const result = (field) => expr(`(() => {
  if ($json.send === false) return $json.${field};
  const p = $('Decide').first().json.plan;
  const o = $input.all().map((i) => i.json);
  const sent = o.filter((x) => x.kind === 'sent' || (x.kind === undefined && !x.error)).length;
  const failed = o.length - sent;
  const pending = failed + p.inFlight;
  const r = { code: pending > 0 ? 503 : 200, body: { status: pending > 0 ? 'partial' : 'sent', sent, failed, alreadySent: p.alreadySent, inFlight: p.inFlight, notApproved: p.notApproved, total: p.total } };
  return r.${field};
})()`);

const nodes = [
  { parameters: { httpMethod: "POST", path: "pisowifi-status", authentication: "headerAuth", responseMode: "responseNode", options: { ipWhitelist: "127.0.0.1,::1,::ffff:127.0.0.1" } },
    name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2.1, webhookId: "5c1e9a02-7b3d-4e58-a6f4-5e0b00c0ffee",
    notes: "Header Auth credential 'PisoWiFi Webhook Auth': Name Authorization, Value 'Bearer <N8N_WEBHOOK_SECRET>'. Select it after import." },
  { parameters: logRow({ kind: "attempt", recipient_id: "" }), name: "Register Attempt", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, executeOnce: true,
    notes: "Written before Load History, so Decide sees every concurrent execution of this event (lowest live id wins)." },
  { parameters: { resource: "row", operation: "get", dataTableId: table(T_POLICY), matchType: "allConditions", filters: { conditions: [] }, returnAll: true },
    name: "Load Policy", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  { parameters: { resource: "row", operation: "get", dataTableId: table(T_LOG), matchType: "anyCondition",
      filters: { conditions: [eq("machine_id", `={{ String(${HOOK}.body?.machine?.id ?? '-') }}`), eq("event_id", `={{ String(${HOOK}.headers?.['x-pisowifi-event-id'] ?? '-') }}`)] }, returnAll: true },
    name: "Load History", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  { parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: DECIDE }, name: "Decide", type: "n8n-nodes-base.code", typeVersion: 2 },
  { parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        conditions: [{ id: "s1", leftValue: "={{ $json.send === true }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
        combinator: "and",
      },
      options: {} },
    name: "Send?", type: "n8n-nodes-base.if", typeVersion: 2.2 },
  { parameters: { batchSize: 1, options: {} }, name: "Each Recipient", type: "n8n-nodes-base.splitInBatches", typeVersion: 3,
    notes: "One recipient at a time: each send is recorded before the next starts, so a hang or crash leaves at most one recipient ambiguous." },
  { parameters: logRow({ kind: "sending", recipient_id: `={{ ${RECIPIENT}.recipientId }}` }), name: "Reserve", type: "n8n-nodes-base.dataTable", typeVersion: 1.1 },
  { parameters: { resource: "message", operation: "send", sendTo: `={{ ${RECIPIENT}.email }}`, subject: `={{ ${RECIPIENT}.subject }}`, emailType: "text",
      // No senderName: in n8n 2.43.8 it makes the node call users.getProfile first, which the gmail.send scope does not
      // permit. Gmail then sets From to the account itself (its Google display name shows).
      message: `={{ ${RECIPIENT}.text }}`, options: { appendAttribution: false } },
    name: "Send Gmail", type: "n8n-nodes-base.gmail", typeVersion: 2.2, onError: "continueRegularOutput",
    notes: "Credential: Gmail OAuth2 for pisowifimonitoring@gmail.com (scope gmail.send). Not set in this file; select it after import. Node retry stays off: retries come from PisoWiFi." },
  { parameters: logRow({ kind: "={{ $json.error ? 'failed' : 'sent' }}", recipient_id: `={{ ${RECIPIENT}.recipientId }}` }),
    name: "Record", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, onError: "continueRegularOutput" },
  { parameters: { respondWith: "json", responseBody: result("body"), options: { responseCode: result("code") } },
    name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5 },
];

const STICKY = [
  ["Note: Overview", [-60, -80], 860, 300, [
    "## PisoWiFi status notifications (simple)",
    "Offline / Back Online Gmail alerts for verified status changes. Same webhook contract and responses as v4.",
    "",
    "**Before activating:** select *PisoWiFi Webhook Auth* on **Webhook** and the Gmail OAuth2 credential on **Send Gmail**.",
    "Data tables (all columns *string*):",
    "- `pisowifi_alert_policy`: `kind` (machine | recipient), `ref_id`, `note` — exactly 2 machine ids, 3 user ids",
    "- `pisowifi_alert_log`: `event_id`, `machine_id`, `event`, `detected_at`, `kind`, `recipient_id`, `run_token`, `at`",
    "",
    "Only one of v3 / v4 / simple may be active (same webhook path).",
  ]],
  ["Note: Delivery", [1280, -200], 800, 240, [
    "## Delivery: at-least-once, never exactly-once",
    "Each recipient: **Reserve** (sending) → **Send Gmail** → **Record** (sent / failed). Recipients already *sent* are never emailed again.",
    "Any failure → 503 → PisoWiFi retries the same event; only pending recipients are emailed.",
    "A *sending* row without an outcome (n8n crashed or timed out mid-send) defers that recipient for 2 min, then it is emailed again: the one case that can duplicate.",
  ]],
];
const positions = {
  Webhook: [0, 300], "Register Attempt": [220, 300], "Load Policy": [440, 300], "Load History": [660, 300], Decide: [880, 300], "Send?": [1100, 300],
  "Each Recipient": [1340, 300], Reserve: [1560, 140], "Send Gmail": [1780, 140], Record: [2000, 140], Respond: [1560, 480],
};
const ordered = nodes.map((n, i) => {
  const { parameters, name, type, typeVersion, ...rest } = n;
  return { parameters, id: nodeId(i + 1), name, type, typeVersion, position: positions[name], ...rest };
});
const stickies = STICKY.map(([name, position, width, height, lines], i) => ({
  parameters: { content: lines.join("\n"), height, width, color: 7 }, id: nodeId(101 + i), name, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position,
}));
const to = (...targets) => ({ main: targets.map((t) => (t ? [{ node: t, type: "main", index: 0 }] : [])) });
const connections = {
  Webhook: to("Register Attempt"),
  "Register Attempt": to("Load Policy"),
  "Load Policy": to("Load History"),
  "Load History": to("Decide"),
  Decide: to("Send?"),
  "Send?": to("Each Recipient", "Respond"),
  "Each Recipient": to("Respond", "Reserve"),
  Reserve: to("Send Gmail"),
  "Send Gmail": to("Record"),
  Record: to("Each Recipient"),
};
const workflow = {
  name: "PisoWiFi status notifications (simple)",
  nodes: [...ordered, ...stickies],
  connections,
  active: false,
  settings: {
    executionOrder: "v1", timezone: "Asia/Manila", executionTimeout: 25, saveDataErrorExecution: "none", saveDataSuccessExecution: "none",
    saveManualExecutions: false, saveExecutionProgress: false, callerPolicy: "workflowsFromSameOwner",
  },
  meta: { pisowifiTemplate: "status-notifications simple: 11 functional nodes; v4 contract and responses; policy table (ids only), attempt-row lock, per-recipient sending/sent/failed log; credentials not set" },
  pinData: {},
};
const json = JSON.stringify(workflow, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) { console.error("pisowifi-status-workflow.simple.json is out of date: run build-workflow-simple.mjs"); process.exit(1); }
  console.log("simple workflow JSON is up to date");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${ordered.length} functional nodes + ${stickies.length} sticky notes)`);
}
