// Writes pisowifi-status-workflow.v4-clean.json from pisowifi-status-workflow.v4.json (deterministic).
// Only the canvas changes: node positions, six section sticky notes, the workflow name and meta. Every functional node
// (id, parameters, flags), the connections and the settings are copied from v4 unchanged, so v4 stays the source of truth.
// Usage: node apps/api/n8n/build-workflow-v4-clean.mjs [--check]   (--check: fail if the committed JSON differs)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("./pisowifi-status-workflow.v4.json", import.meta.url));
const OUT = fileURLToPath(new URL("./pisowifi-status-workflow.v4-clean.json", import.meta.url));
const v4 = JSON.parse(readFileSync(SRC, "utf8"));

// Lanes: MAIN is the happy-path spine (Webhook → … → Respond Result); branches drop to lower lanes.
const MAIN = 300, LOW = 500, LOW2 = 700, LOW3 = 900;
const sections = [
  { title: "1 · Event Ingress", color: 7,
    text: "Authenticated POST from the PisoWiFi dispatcher (Header Auth, loopback only).",
    nodes: { Webhook: [0, MAIN] } },
  { title: "2 · Security and Validation", color: 3,
    text: "Checks the event-ID and timestamp headers and every payload field. Invalid events stop here with **400**.",
    nodes: { Validate: [280, MAIN], "Valid Event?": [500, MAIN], "Respond Invalid": [720, LOW] } },
  { title: "3 · Approved Machines and Recipients", color: 6,
    text: "Loads the allow-lists (machine IDs, user IDs) from n8n Data Tables. No email addresses are stored.",
    nodes: { "Load Approved Machines": [1000, MAIN], "Load Approved Recipients": [1220, MAIN] } },
  { title: "4 · Deduplication and Event Planning", color: 5,
    text: "Reads per-recipient delivery state and machine history, then decides. Duplicate, in-progress, superseded or not-approved events are answered without sending.",
    nodes: { "Load Delivery State": [1500, MAIN], "Load Machine History": [1720, MAIN], Plan: [1940, MAIN], "Anything To Send?": [2160, MAIN], "Respond Not Sent": [2380, LOW] } },
  { title: "5 · Gmail Delivery", color: 4,
    text: "One recipient at a time: reserve, confirm the reservation is ours, then send through Gmail. Emails say **Offline** / **Back Online**.",
    nodes: { Compose: [2660, MAIN], "Split Recipients": [2880, MAIN], "Each Recipient": [3100, MAIN], Reserve: [3320, LOW], "Confirm Reservation": [3540, LOW], "Still Ours?": [3760, LOW], "Send Gmail": [3980, LOW] } },
  { title: "6 · Delivery Results and Error Handling", color: 2,
    text: "Records **sent** / **failed** (or defers an in-flight recipient) and loops to the next one. Then responds **200** all sent, **503** retry.",
    nodes: { "Record Sent": [4260, LOW], "Outcome Sent": [4480, LOW], "Record Failed": [4260, LOW2], "Outcome Failed": [4480, LOW2], "Outcome Deferred": [4480, LOW3],
      Summarize: [4260, MAIN], "Respond Result": [4480, MAIN] } },
];

const positions = Object.assign({}, ...sections.map((s) => s.nodes));
const names = v4.nodes.map((n) => n.name);
const missing = names.filter((n) => !positions[n]);
const extra = Object.keys(positions).filter((n) => !names.includes(n));
if (missing.length || extra.length) throw new Error(`layout out of sync with v4: missing ${missing.join()} extra ${extra.join()}`);

// Sticky boxes wrap their nodes (100×100, label below) with room for the heading; all share the same top edge.
const NODE = 100, PAD_X = 60, TOP = MAIN - 200, MIN_W = 280;
const stickies = sections.map((s, i) => {
  const xs = Object.values(s.nodes).map(([x]) => x);
  const ys = Object.values(s.nodes).map(([, y]) => y);
  const right = Math.max(...xs) + NODE + PAD_X;
  const left = Math.min(right - MIN_W, Math.min(...xs) - PAD_X);
  const bottom = Math.max(Math.max(...ys), LOW) + NODE + 60;
  return {
    parameters: { content: `## ${s.title}\n${s.text}`, height: bottom - TOP, width: right - left, color: s.color },
    id: `7a4c2e10-4d5b-4f86-9c31-5ec7${String(i + 1).padStart(8, "0")}`,
    name: `Section ${s.title}`,
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position: [left, TOP],
  };
});

const workflow = {
  name: "PisoWiFi Status Notifications — Clean v4",
  nodes: [...v4.nodes.map((n) => ({ ...n, position: positions[n.name] })), ...stickies],
  connections: v4.connections,
  active: v4.active,
  settings: v4.settings,
  meta: { pisowifiTemplate: "status-notifications v4, clean layout: same nodes, parameters, connections and settings as pisowifi-status-workflow.v4.json; only positions, section notes and name differ; credentials not set" },
  pinData: v4.pinData,
};
const json = JSON.stringify(workflow, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) { console.error("pisowifi-status-workflow.v4-clean.json is out of date: run build-workflow-v4-clean.mjs"); process.exit(1); }
  console.log("v4-clean workflow JSON is up to date");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${v4.nodes.length} nodes + ${stickies.length} sticky notes)`);
}
