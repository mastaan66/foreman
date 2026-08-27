import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, parseFrontmatter, route, computeBudget, resolveModel, stalledModels, checkpointBrief, depsOf, DEFAULT_TIERS } from "../lib.mjs";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "foreman-test-"));
  const ws = new Workspace(root);
  ws.init("t");
  return { root, ws };
}

test("frontmatter: flow objects, nested objects, lists, comments, empty keys", () => {
  const { meta } = parseFrontmatter(`---\nid: X\nbudget: { steps: 60, usd: 0.5 }\npermission:\n  edit: allow\n  bash: deny\nkinds: [implement, fix]\ndepends_on:\nsupervisor:\nverify:\n  - npm test\n  # a comment\n  - "! grep -rn foo src"\n---\nbody`);
  assert.deepEqual(meta.budget, { steps: 60, usd: 0.5 });
  assert.deepEqual(meta.permission, { edit: "allow", bash: "deny" });
  assert.deepEqual(meta.kinds, ["implement", "fix"]);
  assert.deepEqual(depsOf(meta), []);
  assert.deepEqual(meta.verify, ["npm test", "! grep -rn foo src"]);
});

test("init installs the default roster and syncs opencode agents (not the director)", () => {
  const { ws, root } = scratch();
  const names = ws.agents().map((a) => a.name);
  for (const n of ["lead", "coder", "tester", "drone", "librarian", "director"]) assert.ok(names.includes(n), n);
  assert.equal(ws.agent("director").supervisor, null);
  assert.equal(ws.agent("coder").supervisor, "lead");
  const w = ws.syncOpencodeAgents();
  assert.ok(!w.some((x) => x.name === "director"));
  assert.ok(existsSync(join(root, ".opencode", "agent", "coder.md")));
  const text = readFileSync(join(root, ".opencode", "agent", "coder.md"), "utf8");
  assert.match(text, /^model: /m);
  assert.match(text, /permission:\n  edit: allow/);
  assert.doesNotMatch(text, /^tier:/m);
});

test("route: assignee > routing[kind] > default; tierMin raises; budget bounded by tier", () => {
  const { ws } = scratch();
  const mk = (meta) => ({ id: "T1", meta, text: "" });
  assert.equal(route(ws, mk({ kind: "report" })).agent.name, "drone");
  assert.equal(route(ws, mk({ kind: "review" })).tier, "premium");
  assert.equal(route(ws, mk({ kind: "implement", assignee: "tester" })).agent.name, "tester");
  const raised = route(ws, mk({ kind: "chore", tierMin: "standard" }));
  assert.equal(raised.tier, "standard");
  const b = route(ws, mk({ kind: "implement", budget: { outTokens: 999999, steps: 10 } })).budget;
  assert.equal(b.steps, 10);
  assert.equal(b.outTokens, DEFAULT_TIERS.standard.maxOutPerRun);
  assert.equal(route(ws, mk({}), { model: "x/y" }).model, "x/y");
});

test("resolveModel skips dead and timed-out models and avoided ones", () => {
  const cfg = { tiers: { standard: { model: "a/dead", fallbacks: ["b/slow", "c/ok", "d/ok"] } } };
  const models = { models: { "a/dead": { status: "dead" }, "b/slow": { status: "timeout" } } };
  assert.equal(resolveModel(cfg, { tier: "standard", meta: {} }, models), "c/ok");
  assert.equal(resolveModel(cfg, { tier: "standard", meta: {} }, models, new Set(["c/ok"])), "d/ok");
  assert.equal(resolveModel(cfg, { tier: "standard", meta: { model: "z/mine" } }, models), "z/mine");
});

test("stalledModels: a model that stalled twice on a ticket is avoided; once is not", () => {
  const ts = { runs: [{ model: "m1", status: "stalled" }, { model: "m1", status: "timeout" }, { model: "m2", status: "stalled" }] };
  assert.deepEqual([...stalledModels(ts)], ["m1"]);
});

test("route steps around a model that stalled twice on this ticket", () => {
  const { ws } = scratch();
  ws.updateState((s) => (s.tickets.T9 = { status: "stalled", runs: [{ model: DEFAULT_TIERS.standard.model, status: "stalled" }, { model: DEFAULT_TIERS.standard.model, status: "stalled" }] }));
  const r = route(ws, { id: "T9", meta: { kind: "implement" }, text: "" });
  assert.notEqual(r.model, DEFAULT_TIERS.standard.model);
  assert.match(r.reason, /stalled/);
});

test("computeBudget merges task, tier and overrides", () => {
  const b = computeBudget({ steps: 5, usd: 1 }, { maxOutPerRun: 100, ctxCap: 1000 }, { minutes: 3 });
  assert.deepEqual(b, { steps: 5, outTokens: 100, ctxTokens: 1000, ctxKill: 120_000, usd: 1, minutes: 3 });
  assert.equal(computeBudget({}, { ctxCap: 80_000, ctxKill: 150_000 }).ctxKill, 150_000);
  assert.ok(computeBudget({}, { ctxCap: 70_000 }).ctxKill >= 140_000, "kill ceiling is far above the continuation cap");
});

test("checkpoint brief is deterministic, capped, and carries report + gate tail", async () => {
  const { ws } = scratch();
  const id = "T3";
  mkdirSync(ws.ticketsDir, { recursive: true });
  writeFileSync(join(ws.ticketsDir, `${id}-x.md`), `---\nid: ${id}\ntitle: x\n---\n# x`);
  const rd = ws.runDir(id);
  writeFileSync(join(rd, "REPORT.md"), "# REPORT T3\n## Done\n- thing " + "y".repeat(5000));
  writeFileSync(join(rd, "verify-1.log"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  ws.updateState((s) => (s.tickets[id] = { status: "stalled", runs: [{ n: 1, status: "stalled", steps: 9, tools: 3, tokens: { total: 123 } }] }));
  const brief = await checkpointBrief(ws, ws.ticket(id), { cap: 3000 });
  assert.ok(brief.length <= 3000);
  assert.match(brief, /CHECKPOINT BRIEF for T3/);
  assert.match(brief, /Previous run #1: stalled, 9 steps/);
  assert.match(brief, /line 99/);
  assert.match(brief, /REPORT T3/);
});

test("events: append-only jsonl, tail reads, rotation past 5MB", () => {
  const { ws } = scratch();
  ws.event("a", { x: 1 });
  ws.event("b", { x: 2 });
  const ev = ws.events(10);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].type, "b");
  writeFileSync(ws.eventsPath, "x".repeat(5 * 1024 * 1024 + 1));
  ws.event("c");
  assert.ok(statSync(ws.eventsPath).size < 1000, "rotated");
});

test("agent state is per-agent and survives read-modify-write", () => {
  const { ws } = scratch();
  ws.updateAgentState("coder", (s) => {
    s.spend += 0.5;
    s.sessions.push({ id: "s1", ctxTokens: 10 });
  });
  ws.updateAgentState("coder", (s) => (s.runs = 2));
  const s = ws.agentState("coder");
  assert.equal(s.spend, 0.5);
  assert.equal(s.runs, 2);
  assert.equal(s.sessions[0].id, "s1");
  assert.equal(ws.agentState("drone").spend, 0);
});
