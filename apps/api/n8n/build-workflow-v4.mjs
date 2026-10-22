// Writes pisowifi-status-workflow.v4.json (deterministic). v3 (pisowifi-status-workflow.json) is left unchanged.
// Usage: node apps/api/n8n/build-workflow-v4.mjs [--check]   (--check: fail if the committed JSON differs)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./pisowifi-status-workflow.v4.json", import.meta.url));
const T_DELIVERIES = "pisowifi_alert_deliveries_v4";
const T_MACHINES = "pisowifi_approved_machines";
const T_RECIPIENTS = "pisowifi_approved_recipients";

// n8n expressions are written as readable JS here and collapsed to one line.
const expr = (js) => "={{ " + js.trim().replace(/\n\s*/g, " ") + " }}";
const nodeId = (n) => `7a4c2e10-4d5b-4f86-9c31-${String(n).padStart(12, "0")}`;
const col = (id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: "string", readOnly: false, removed: false });
const table = (name) => ({ __rl: true, mode: "name", value: name });
const eq = (keyName, keyValue) => ({ keyName, condition: "eq", keyValue });
const boolIf = (id, leftValue) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
    conditions: [{ id, leftValue, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
    combinator: "and",
  },
  options: {},
});
const setNode = (name, assignments, extra = {}) => ({
  parameters: { mode: "manual", assignments: { assignments: assignments.map(([n, type, value], i) => ({ id: `a${i}`, name: n, type, value })) }, includeOtherFields: false, options: {} },
  name, type: "n8n-nodes-base.set", typeVersion: 3.4, ...extra,
});

const BODY = "$('Webhook').first().json.body";
const EVENT_ID = "$('Webhook').first().json.headers['x-pisowifi-event-id']";
const RECIPIENT = "$('Each Recipient').first().json";

// ---- validation: every field of the backend contract (packages/shared/src/notifications.ts), plus the dispatcher's
// event-ID and timestamp headers. The HMAC signature cannot be checked here: the workflow has no access to the secret
// (N8N_BLOCK_ENV_ACCESS_IN_NODE=true and no secret may be stored in the workflow). Header Auth carries the secret.
const VALIDATE = `(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const h = $json.headers ?? {};
  const b = $json.body;
  const no = (reason) => ({ ok: false, reason });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('body');
  const id = String(h['x-pisowifi-event-id'] ?? '');
  if (!UUID.test(id)) return no('event_id_header');
  if (String(b.eventId ?? '') !== id) return no('event_id_mismatch');
  const ts = String(h['x-pisowifi-timestamp'] ?? '');
  if (!/^[0-9]{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return no('timestamp');
  const pair = b.event === 'machine.unreachable' ? ['Unreachable', 'Reachable'] : b.event === 'machine.reachable' ? ['Reachable', 'Unreachable'] : null;
  if (!pair) return no('event');
  if (b.status !== pair[0] || b.previousStatus !== pair[1]) return no('transition');
  const m = b.machine;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return no('machine');
  if (!UUID.test(String(m.id ?? ''))) return no('machine_id');
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 120) return no('machine_name');
  if (!/^[0-9]{1,3}([.][0-9]{1,3}){3}$/.test(String(m.ip ?? ''))) return no('machine_ip');
  if (b.timeZone !== 'Asia/Manila' || b.utcOffset !== '+08:00') return no('time_zone');
  const iso = String(b.detectedAt ?? '');
  const at = DateTime.fromISO(iso, { zone: 'utc' });
  if (!/Z$/.test(iso) || !at.isValid) return no('detected_at');
  const age = Date.now() - at.toMillis();
  if (age < -300000 || age > 604800000) return no('detected_at_range');
  const local = at.setZone('Asia/Manila').setLocale('en-US');
  if (b.detectedDate !== local.toFormat('MMMM d, yyyy') || b.detectedTime !== local.toFormat('h:mm a')) return no('detected_local');
  const hasStart = b.outageStartedAt !== undefined && b.outageStartedAt !== null;
  const hasDown = b.downtimeSeconds !== undefined && b.downtimeSeconds !== null;
  if (hasStart !== hasDown) return no('downtime');
  if (hasDown) {
    const s = b.downtimeSeconds;
    const o = DateTime.fromISO(String(b.outageStartedAt), { zone: 'utc' });
    if (b.event !== 'machine.reachable' || !Number.isInteger(s) || s < 0 || !o.isValid || Math.abs(Math.floor((at.toMillis() - o.toMillis()) / 1000) - s) > 1) return no('downtime');
  }
  const r = b.recipients;
  if (!Array.isArray(r) || r.length < 1 || r.length > 20) return no('recipients');
  const seen = new Set();
  for (const x of r) {
    if (!x || typeof x !== 'object' || !UUID.test(String(x.id ?? '')) || seen.has(x.id)) return no('recipients');
    seen.add(x.id);
    const e = String(x.email ?? '');
    if (e.length > 254 || !/^[^@\\s,;<>"'()\\[\\]]+@[^@\\s,;<>"'()\\[\\]]+[.][^@\\s,;<>"'()\\[\\]]+$/.test(e)) return no('recipients');
  }
  return { ok: true, reason: '' };
})()`;

// ---- plan: approved machines / recipients (n8n Data Tables, IDs only), chronology, per-recipient delivery state.
const PLAN = `(() => {
  const EXPECTED_MACHINES = 2;
  const EXPECTED_RECIPIENTS = 3;
  const STALE_MS = 120000;
  const b = ${BODY};
  const rows = (n) => $(n).all().map((i) => i.json).filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const machines = rows('Load Approved Machines').map((r) => norm(r.machine_id)).filter((v) => v !== '');
  const people = rows('Load Approved Recipients').map((r) => norm(r.user_id)).filter((v) => v !== '');
  const out = { decision: 'send', total: b.recipients.length, approved: 0, notApproved: 0, alreadySent: 0, inFlight: 0, toSend: [] };
  if (machines.length !== EXPECTED_MACHINES || new Set(machines).size !== EXPECTED_MACHINES || people.length !== EXPECTED_RECIPIENTS || new Set(people).size !== EXPECTED_RECIPIENTS) return { ...out, decision: 'config_error' };
  if (!machines.includes(norm(b.machine.id))) return { ...out, decision: 'machine_not_approved' };
  const at = Date.parse(b.detectedAt);
  if (rows('Load Machine History').some((r) => r.status === 'sent' && r.event_id !== b.eventId && Date.parse(String(r.detected_at)) > at)) return { ...out, decision: 'superseded' };
  const now = Date.now();
  const st = {};
  for (const r of rows('Load Delivery State')) {
    if (!r.recipient_id) continue;
    const s = st[r.recipient_id] ?? (st[r.recipient_id] = { sent: false, live: false });
    if (r.status === 'sent') s.sent = true;
    if (r.status === 'sending' && now - Date.parse(String(r.attempted_at)) < STALE_MS) s.live = true;
  }
  for (const x of b.recipients) {
    if (!people.includes(norm(x.id))) { out.notApproved++; continue; }
    out.approved++;
    const s = st[x.id];
    if (s && s.sent) { out.alreadySent++; continue; }
    if (s && s.live) { out.inFlight++; continue; }
    out.toSend.push({ recipientId: x.id, email: x.email });
  }
  if (out.approved === 0) out.decision = 'no_approved_recipients';
  else if (out.toSend.length === 0) out.decision = 'nothing';
  return { ...out, staleMs: STALE_MS };
})()`;

// ---- reservation: every attempt INSERTS its own 'sending' row; this execution may send only when no row of this
// (event, recipient) is 'sent' and its own row has the lowest id among the live 'sending' rows. Inserts get increasing
// ids, so two concurrent executions cannot both win; a crashed attempt's row stops counting once it is stale.
const STILL_OURS = `(() => {
  const STALE_MS = $('Plan').first().json.plan.staleMs;
  const now = Date.now();
  const rows = $('Confirm Reservation').all().map((i) => i.json).filter((r) => r && r.id !== undefined && r.id !== null);
  if (rows.some((r) => r.status === 'sent')) return false;
  const live = rows.filter((r) => r.status === 'sending' && now - Date.parse(String(r.attempted_at)) < STALE_MS);
  const mine = live.find((r) => String(r.run_token) === String($execution.id));
  return mine !== undefined && live.every((r) => Number(r.id) >= Number(mine.id));
})()`;

// ---- email text (plain text; machine name flattened to one line, max 80 characters).
const CLEAN_NAME = `String(b.machine.name).replace(/[\\u0000-\\u001f\\u007f\\u2028\\u2029]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 80)`;
const SUBJECT = `(() => {
  const b = ${BODY};
  const n = ${CLEAN_NAME};
  return b.event === 'machine.unreachable' ? '[PisoWiFi Alert] ' + n + ' is Offline' : '[PisoWiFi Recovery] ' + n + ' is Back Online';
})()`;
const TEXT = `(() => {
  const b = ${BODY};
  const n = ${CLEAN_NAME};
  const down = b.event === 'machine.unreachable';
  const fmt = (s) => {
    if (s < 60) return 'less than 1 minute';
    const m = Math.floor(s / 60);
    return [[Math.floor(m / 1440), 'day'], [Math.floor((m % 1440) / 60), 'hour'], [m % 60, 'minute']].filter((p) => p[0] > 0).map((p) => p[0] + ' ' + p[1] + (p[0] === 1 ? '' : 's')).join(' ');
  };
  const lines = [down ? n + ' is Offline.' : n + ' is Back Online.', '', 'Machine: ' + n, 'Previous Status: ' + (down ? 'Online' : 'Offline'), 'Current Status: ' + (down ? 'Offline' : 'Online'), (down ? 'Detected: ' : 'Recovered: ') + b.detectedDate + ', ' + b.detectedTime + ' (Asia/Manila)'];
  if (!down && Number.isInteger(b.downtimeSeconds)) lines.push('Downtime: ' + fmt(b.downtimeSeconds));
  lines.push('', 'Event ID: ' + b.eventId);
  return lines.join('\\n');
})()`;

const thisRecipient = () => [eq("event_id", `={{ ${EVENT_ID} }}`), eq("recipient_id", `={{ ${RECIPIENT}.recipientId }}`)];
// insert: a new reservation row; update: this execution's own row only (matched by its run token).
const deliveryRow = (operation, status, extra) => ({
  resource: "row",
  operation,
  dataTableId: table(T_DELIVERIES),
  ...(operation === "insert" ? {} : { matchType: "allConditions", filters: { conditions: [...thisRecipient(), eq("run_token", "={{ $execution.id }}")] } }),
  columns: {
    mappingMode: "defineBelow",
    value: {
      event_id: `={{ ${EVENT_ID} }}`,
      recipient_id: `={{ ${RECIPIENT}.recipientId }}`,
      machine_id: `={{ ${BODY}.machine.id }}`,
      event: `={{ ${BODY}.event }}`,
      detected_at: `={{ ${BODY}.detectedAt }}`,
      status,
      ...extra,
    },
    matchingColumns: [],
    schema: ["event_id", "recipient_id", "machine_id", "event", "detected_at", "status", ...Object.keys(extra)].map(col),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});
const loadAll = (name) => ({ resource: "row", operation: "get", dataTableId: table(name), matchType: "allConditions", filters: { conditions: [] }, returnAll: true });
const loadWhere = (name, key, value) => ({ ...loadAll(name), filters: { conditions: [eq(key, value)] } });
const outcome = (name, value) => setNode(name, [["recipientId", "string", `={{ ${RECIPIENT}.recipientId }}`], ["outcome", "string", value], ["recorded", "boolean", "={{ !$json.error }}"]]);

const nodes = [
  { parameters: { httpMethod: "POST", path: "pisowifi-status", authentication: "headerAuth", responseMode: "responseNode", options: { ipWhitelist: "127.0.0.1,::1,::ffff:127.0.0.1" } },
    name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2.1, webhookId: "7a4c2e10-4d5b-4f86-9c31-5e0b00c0ffee",
    notes: "Header Auth credential 'PisoWiFi Webhook Auth': Name Authorization, Value 'Bearer <N8N_WEBHOOK_SECRET>'. Select it after import." },
  setNode("Validate", [["check", "object", expr(VALIDATE)]]),
  { parameters: boolIf("v1", "={{ $json.check.ok }}"), name: "Valid Event?", type: "n8n-nodes-base.if", typeVersion: 2.2 },
  { parameters: { respondWith: "json", responseBody: "={{ { status: 'invalid', reason: $json.check.reason } }}", options: { responseCode: 400 } }, name: "Respond Invalid", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5 },
  { parameters: loadAll(T_MACHINES), name: "Load Approved Machines", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  { parameters: loadAll(T_RECIPIENTS), name: "Load Approved Recipients", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  { parameters: loadWhere(T_DELIVERIES, "event_id", `={{ ${EVENT_ID} }}`), name: "Load Delivery State", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  { parameters: loadWhere(T_DELIVERIES, "machine_id", `={{ ${BODY}.machine.id }}`), name: "Load Machine History", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true, executeOnce: true },
  setNode("Plan", [["plan", "object", expr(PLAN)]], { executeOnce: true }),
  { parameters: boolIf("s1", "={{ $json.plan.decision === 'send' }}"), name: "Anything To Send?", type: "n8n-nodes-base.if", typeVersion: 2.2 },
  { parameters: { respondWith: "json",
      responseBody: "={{ { status: $json.plan.decision === 'nothing' ? ($json.plan.inFlight > 0 ? 'in_progress' : 'duplicate') : $json.plan.decision, sent: 0, failed: 0, alreadySent: $json.plan.alreadySent, inFlight: $json.plan.inFlight, notApproved: $json.plan.notApproved, total: $json.plan.total } }}",
      options: { responseCode: "={{ $json.plan.decision === 'nothing' ? ($json.plan.inFlight > 0 ? 503 : 200) : $json.plan.decision === 'superseded' ? 200 : $json.plan.decision === 'config_error' ? 503 : 422 }}" } },
    name: "Respond Not Sent", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5 },
  { ...setNode("Compose", [["subject", "string", expr(SUBJECT)], ["text", "string", expr(TEXT)]], { executeOnce: true }),
    parameters: { ...setNode("Compose", [["subject", "string", expr(SUBJECT)], ["text", "string", expr(TEXT)]]).parameters, includeOtherFields: true } },
  { parameters: { fieldToSplitOut: "plan.toSend", include: "noOtherFields", options: {} }, name: "Split Recipients", type: "n8n-nodes-base.splitOut", typeVersion: 1 },
  { parameters: { batchSize: 1, options: {} }, name: "Each Recipient", type: "n8n-nodes-base.splitInBatches", typeVersion: 3 },
  { parameters: deliveryRow("insert", "sending", { run_token: "={{ $execution.id }}", attempted_at: "={{ $now.toUTC().toISO() }}", sent_at: "" }), name: "Reserve", type: "n8n-nodes-base.dataTable", typeVersion: 1.1 },
  { parameters: { ...loadAll(T_DELIVERIES), filters: { conditions: thisRecipient() } },
    name: "Confirm Reservation", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, alwaysOutputData: true },
  { parameters: boolIf("r1", expr(STILL_OURS)), name: "Still Ours?", type: "n8n-nodes-base.if", typeVersion: 2.2, executeOnce: true },
  { parameters: { resource: "message", operation: "send", sendTo: `={{ ${RECIPIENT}.email }}`, subject: "={{ $('Compose').first().json.subject }}", emailType: "text",
      message: "={{ $('Compose').first().json.text }}", options: { appendAttribution: false, senderName: "PisoWiFi Monitoring" } },
    name: "Send Gmail", type: "n8n-nodes-base.gmail", typeVersion: 2.2, onError: "continueErrorOutput",
    notes: "Credential: Gmail OAuth2 for pisowifimonitoring@gmail.com (scope gmail.send). Not set in this file; select it after import." },
  { parameters: deliveryRow("update", "sent", { sent_at: "={{ $now.toUTC().toISO() }}" }), name: "Record Sent", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, onError: "continueRegularOutput" },
  { parameters: deliveryRow("update", "failed", {}), name: "Record Failed", type: "n8n-nodes-base.dataTable", typeVersion: 1.1, onError: "continueRegularOutput" },
  outcome("Outcome Sent", "sent"),
  outcome("Outcome Failed", "failed"),
  setNode("Outcome Deferred", [["recipientId", "string", `={{ ${RECIPIENT}.recipientId }}`], ["outcome", "string", "deferred"], ["recorded", "boolean", "={{ true }}"]]),
  setNode("Summarize", [["summary", "object", expr(`(() => {
    const o = $input.all().map((i) => i.json);
    const p = $('Plan').first().json.plan;
    return { total: p.total, notApproved: p.notApproved, sent: o.filter((x) => x.outcome === 'sent').length, failed: o.filter((x) => x.outcome === 'failed').length, alreadySent: p.alreadySent, inFlight: p.inFlight + o.filter((x) => x.outcome === 'deferred').length, unrecorded: o.filter((x) => x.outcome === 'sent' && !x.recorded).length };
  })()`)]], { executeOnce: true }),
  { parameters: { respondWith: "json",
      responseBody: "={{ { status: $json.summary.failed + $json.summary.inFlight > 0 ? 'partial' : 'sent', sent: $json.summary.sent, failed: $json.summary.failed, alreadySent: $json.summary.alreadySent, inFlight: $json.summary.inFlight, notApproved: $json.summary.notApproved, total: $json.summary.total } }}",
      options: { responseCode: "={{ $json.summary.failed + $json.summary.inFlight > 0 ? 503 : 200 }}" } },
    name: "Respond Result", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5 },
];
const positions = {
  Webhook: [0, 300], Validate: [200, 300], "Valid Event?": [400, 300], "Respond Invalid": [600, 520],
  "Load Approved Machines": [600, 300], "Load Approved Recipients": [800, 300], "Load Delivery State": [1000, 300], "Load Machine History": [1200, 300],
  Plan: [1400, 300], "Anything To Send?": [1600, 300], "Respond Not Sent": [1800, 520], Compose: [1800, 300], "Split Recipients": [2000, 300],
  "Each Recipient": [2200, 300], Reserve: [2400, 100], "Confirm Reservation": [2600, 100], "Still Ours?": [2800, 100], "Send Gmail": [3000, 0],
  "Record Sent": [3200, -100], "Record Failed": [3200, 120], "Outcome Sent": [3400, -100], "Outcome Failed": [3400, 120], "Outcome Deferred": [3000, 260],
  Summarize: [2400, 520], "Respond Result": [2600, 520],
};
const ordered = nodes.map((n, i) => {
  const { parameters, name, type, typeVersion, ...rest } = n;
  return { parameters, id: nodeId(i + 1), name, type, typeVersion, position: positions[name], ...rest };
});
const to = (...targets) => ({ main: targets.map((t) => (t ? [{ node: t, type: "main", index: 0 }] : [])) });
const connections = {
  Webhook: to("Validate"),
  Validate: to("Valid Event?"),
  "Valid Event?": to("Load Approved Machines", "Respond Invalid"),
  "Load Approved Machines": to("Load Approved Recipients"),
  "Load Approved Recipients": to("Load Delivery State"),
  "Load Delivery State": to("Load Machine History"),
  "Load Machine History": to("Plan"),
  Plan: to("Anything To Send?"),
  "Anything To Send?": to("Compose", "Respond Not Sent"),
  Compose: to("Split Recipients"),
  "Split Recipients": to("Each Recipient"),
  "Each Recipient": to("Summarize", "Reserve"),
  Reserve: to("Confirm Reservation"),
  "Confirm Reservation": to("Still Ours?"),
  "Still Ours?": to("Send Gmail", "Outcome Deferred"),
  "Send Gmail": to("Record Sent", "Record Failed"),
  "Record Sent": to("Outcome Sent"),
  "Record Failed": to("Outcome Failed"),
  "Outcome Sent": to("Each Recipient"),
  "Outcome Failed": to("Each Recipient"),
  "Outcome Deferred": to("Each Recipient"),
  Summarize: to("Respond Result"),
};
const workflow = {
  name: "PisoWiFi status notifications v4",
  nodes: ordered,
  connections,
  active: false,
  settings: {
    executionOrder: "v1", timezone: "Asia/Manila", executionTimeout: 25, saveDataErrorExecution: "none", saveDataSuccessExecution: "none",
    saveManualExecutions: false, saveExecutionProgress: false, callerPolicy: "workflowsFromSameOwner",
  },
  meta: { pisowifiTemplate: "status-notifications v4: approved machines/recipients tables, chronology guard, insert-ordered reservation, [PisoWiFi Alert]/[PisoWiFi Recovery] wording, downtime; credentials not set" },
  pinData: {},
};
const json = JSON.stringify(workflow, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) { console.error("pisowifi-status-workflow.v4.json is out of date: run build-workflow-v4.mjs"); process.exit(1); }
  console.log("v4 workflow JSON is up to date");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${ordered.length} nodes)`);
}
