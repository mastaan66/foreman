/**
 * Shared core for foreman: workspace/state access, ticket + agent parsing, tiers, routing,
 * budgets, event log, checkpoint briefs, opencode agent sync, event digest, helpers.
 * Imported by the CLI (foreman.mjs), the daemon and the dashboard (ui.mjs).
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = join(HERE, "templates");
export const CLI_PATH = join(HERE, "foreman.mjs");

export function die(msg, code = 1) {
  process.stderr.write(`foreman: ${msg}\n`);
  process.exit(code);
}

export const nowIso = () => new Date().toISOString();

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

// ---------- frontmatter (YAML subset) ------------------------------------------

/** Parse a YAML flow value: numbers, booleans, quoted strings, [a, b], { k: v }. */
function parseScalar(v) {
  const s = v.trim();
  if (s === "") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(parseScalar).filter((x) => x !== "");
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      obj[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
    }
    return obj;
  }
  return s;
}

function splitFlow(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * Minimal YAML-subset frontmatter: `key: value` (flow scalars/arrays/objects), `key:`
 * followed by `- item` lines, and one level of nested `key:` + indented `sub: value`.
 * Comment lines (`#`) are ignored.
 */
export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let listKey = null;
  let objKey = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(parseScalar(item[1]));
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (nested && objKey) {
      meta[objKey][nested[1]] = parseScalar(nested[2]);
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      const [, k, v] = kv;
      listKey = objKey = null;
      if (v === "") {
        meta[k] = [];
        listKey = k;
        objKey = k; // becomes an object if the next lines are `  sub: value`
      } else meta[k] = parseScalar(v);
    }
  }
  // A key that collected `sub: value` lines was initialised as [] — convert.
  for (const [k, v] of Object.entries(meta)) if (Array.isArray(v) && Object.keys(v).some((x) => Number.isNaN(Number(x)))) meta[k] = { ...v };
  return { meta, body: m[2] };
}

export const depsOf = (meta) => {
  const d = meta?.depends_on;
  if (Array.isArray(d)) return d.map(String);
  return String(d ?? "").split(/[,\s]+/).filter(Boolean);
};

// ---------- defaults: tiers, routing, roles --------------------------------------

// Defaults reflect a live probe on 2026-08-26 (`foreman models --probe`): minimax-m3 answered
// in 10 s, mimo/hy3/big-pickle in ~13 s, muse-spark in 21 s; both nemotron free models hung
// past 90 s and most NVIDIA NIM models were 410 Gone. Re-probe; models rot.
// `ctxCap` is the CONTINUATION gate: a session past it is never resumed, a fresh one starts
// from a checkpoint brief. `ctxKill` is the mid-run hard ceiling (observed: real work on a
// monorepo sits at 50–70k context within ten steps, so the kill must be far above the cap).
export const DEFAULT_TIERS = {
  premium: { model: "nvidia/minimaxai/minimax-m3", fallbacks: ["opencode/mimo-v2.5-free", "opencode/muse-spark-1.2-contributor-free"], inputPerM: 0, outputPerM: 0, ctxCap: 90_000, ctxKill: 180_000, maxOutPerRun: 12_000 },
  standard: { model: "opencode/muse-spark-1.2-contributor-free", fallbacks: ["opencode/mimo-v2.5-free", "nvidia/minimaxai/minimax-m3"], inputPerM: 0, outputPerM: 0, ctxCap: 60_000, ctxKill: 140_000, maxOutPerRun: 30_000 },
  economy: { model: "opencode/hy3-free", fallbacks: ["opencode/big-pickle", "opencode/mimo-v2.5-free"], inputPerM: 0, outputPerM: 0, ctxCap: 40_000, ctxKill: 90_000, maxOutPerRun: 8_000 },
};

export const DEFAULT_ROUTING = {
  plan: "lead",
  review: "lead",
  implement: "coder",
  fix: "coder",
  test: "tester",
  chore: "drone",
  summarise: "drone",
  report: "drone",
  research: "librarian",
};

export const DEFAULT_ROLES = ["director", "lead", "coder", "tester", "drone", "librarian"];

// ---------- workspace ----------------------------------------------------------

export class Workspace {
  constructor(root) {
    this.root = resolve(root);
    this.dir = join(this.root, ".foreman");
    this.ticketsDir = join(this.dir, "tickets");
    this.runsDir = join(this.dir, "runs");
    this.agentsDir = join(this.dir, "agents");
    this.statePath = join(this.dir, "state.json");
    this.configPath = join(this.dir, "foreman.json");
    this.eventsPath = join(this.dir, "events.jsonl");
    this.modelsPath = join(this.dir, "models.json");
  }

  static find(start = process.cwd()) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, ".foreman"))) return new Workspace(dir);
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  init(name) {
    for (const d of [this.dir, this.ticketsDir, this.runsDir, this.agentsDir]) mkdirSync(d, { recursive: true });
    if (!existsSync(this.configPath)) {
      writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            project: name,
            worker: { command: "opencode", model: null, variant: null, agent: null, timeoutMinutes: 60, idleMinutes: 5 },
            tiers: DEFAULT_TIERS,
            routing: DEFAULT_ROUTING,
            concurrency: { global: 2 },
            verify: [],
          },
          null,
          2,
        ) + "\n",
      );
    }
    if (!existsSync(join(this.dir, "PROTOCOL.md"))) writeFileSync(join(this.dir, "PROTOCOL.md"), readFileSync(join(TEMPLATES, "PROTOCOL.md"), "utf8"));
    if (!existsSync(this.statePath)) this.saveState({ tickets: {}, activity: [], manager: null });
    this.installDefaultAgents();
  }

  /** Copy the default roster into .foreman/agents/ (never overwrites an existing agent). */
  installDefaultAgents() {
    mkdirSync(this.agentsDir, { recursive: true });
    const src = join(TEMPLATES, "agents");
    if (!existsSync(src)) return [];
    const added = [];
    for (const f of readdirSync(src).filter((f) => f.endsWith(".md"))) {
      const dst = join(this.agentsDir, f);
      if (!existsSync(dst)) {
        writeFileSync(dst, readFileSync(join(src, f), "utf8"));
        added.push(f.replace(/\.md$/, ""));
      }
    }
    return added;
  }

  config() {
    const cfg = JSON.parse(readFileSync(this.configPath, "utf8"));
    cfg.tiers = { ...DEFAULT_TIERS, ...(cfg.tiers ?? {}) };
    cfg.routing = { ...DEFAULT_ROUTING, ...(cfg.routing ?? {}) };
    cfg.concurrency = { global: 2, ...(cfg.concurrency ?? {}) };
    return cfg;
  }

  state() {
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8"));
      s.tickets ??= {};
      s.activity ??= [];
      return s;
    } catch {
      return { tickets: {}, activity: [], manager: null };
    }
  }

  saveState(state) {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, this.statePath);
  }

  /** Read-modify-write so concurrent foreman processes only touch their own slice. */
  updateState(mutate) {
    const state = this.state();
    mutate(state);
    this.saveState(state);
    return state;
  }

  activity(actor, text, extra = {}) {
    this.updateState((s) => {
      s.activity.push({ at: nowIso(), actor, text, ...extra });
      if (s.activity.length > 300) s.activity.splice(0, s.activity.length - 300);
    });
    this.event("activity", { actor, text, ...extra });
  }

  setManager(phase, detail = "") {
    this.updateState((s) => {
      s.manager = { phase, detail, at: nowIso() };
    });
  }

  // ----- events: append-only, rotated, tailed -----

  event(type, data = {}) {
    try {
      if (existsSync(this.eventsPath) && statSync(this.eventsPath).size > 5 * 1024 * 1024) {
        renameSync(this.eventsPath, this.eventsPath.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
      }
      appendFileSync(this.eventsPath, JSON.stringify({ at: nowIso(), type, ...data }) + "\n");
    } catch {
      /* the event log is best-effort */
    }
  }

  /** Last `n` events (reads only the tail of the file). */
  events(n = 200) {
    if (!existsSync(this.eventsPath)) return [];
    const size = statSync(this.eventsPath).size;
    const chunk = Math.min(size, 256 * 1024);
    const fd = readFileSync(this.eventsPath); // small files: whole; large: still bounded by rotation
    const text = fd.subarray(size - chunk).toString("utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  protocol() {
    return readFileSync(join(this.dir, "PROTOCOL.md"), "utf8");
  }

  // ----- tickets / tasks -----

  ticketFile(id) {
    if (!existsSync(this.ticketsDir)) return null;
    const files = readdirSync(this.ticketsDir).filter((f) => f.endsWith(".md"));
    const exact = files.find((f) => f === `${id}.md`);
    if (exact) return join(this.ticketsDir, exact);
    const prefixed = files.find((f) => f.startsWith(`${id}-`) || f.startsWith(`${id}_`));
    if (prefixed) return join(this.ticketsDir, prefixed);
    return null;
  }

  ticket(id) {
    const file = this.ticketFile(id);
    if (!file) die(`no ticket matching "${id}" in ${this.ticketsDir}`);
    const text = readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(text);
    return { id: meta.id ?? id, file, meta, body, text };
  }

  tickets() {
    if (!existsSync(this.ticketsDir)) return [];
    return readdirSync(this.ticketsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const text = readFileSync(join(this.ticketsDir, f), "utf8");
        const { meta } = parseFrontmatter(text);
        return { id: meta.id ?? f.replace(/\.md$/, ""), file: f, meta };
      });
  }

  runDir(id) {
    const d = join(this.runsDir, id);
    mkdirSync(d, { recursive: true });
    return d;
  }

  latestLog(id) {
    const d = join(this.runsDir, id);
    if (!existsSync(d)) return null;
    const logs = readdirSync(d)
      .filter((f) => /^run-\d+\.log$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    return logs.length ? join(d, logs.at(-1)) : null;
  }

  latestVerifyLog(id) {
    const d = join(this.runsDir, id);
    if (!existsSync(d)) return null;
    const logs = readdirSync(d)
      .filter((f) => /^verify-\d+\.log$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    return logs.length ? join(d, logs.at(-1)) : null;
  }

  // ----- agents -----

  agents() {
    if (!existsSync(this.agentsDir)) return [];
    return readdirSync(this.agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const text = readFileSync(join(this.agentsDir, f), "utf8");
        const { meta, body } = parseFrontmatter(text);
        const name = f.replace(/\.md$/, "");
        const supervisor = typeof meta.supervisor === "string" && meta.supervisor ? meta.supervisor : null;
        return { name, file: join(this.agentsDir, f), meta, body, role: meta.role ?? name, tier: meta.tier ?? "standard", supervisor, kinds: Array.isArray(meta.kinds) ? meta.kinds.map(String) : [], state: this.agentState(name) };
      });
  }

  agent(name) {
    return this.agents().find((a) => a.name === name) ?? null;
  }

  agentStatePath(name) {
    return join(this.agentsDir, `${name}.state.json`);
  }

  agentState(name) {
    try {
      return JSON.parse(readFileSync(this.agentStatePath(name), "utf8"));
    } catch {
      return { name, sessions: [], spend: 0, tokens: 0, runs: 0, lastActive: null, phase: "idle", task: null };
    }
  }

  updateAgentState(name, mutate) {
    const s = this.agentState(name);
    mutate(s);
    const p = this.agentStatePath(name);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, p);
    return s;
  }

  agentDir(name) {
    const d = join(this.agentsDir, name);
    mkdirSync(join(d, "replies"), { recursive: true });
    return d;
  }

  /**
   * Write .opencode/agent/<name>.md for every foreman agent so opencode itself enforces the
   * model, temperature and permissions (foreman fields are stripped; the persona body is kept).
   */
  syncOpencodeAgents(models = null) {
    const cfg = this.config();
    const outDir = join(this.root, ".opencode", "agent");
    mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const a of this.agents()) {
      if (a.name === "director" || a.meta.concurrency === 0) continue; // the director is a person, not a model
      const model = resolveModel(cfg, a, models);
      const fm = [
        `description: ${JSON.stringify(a.meta.description ?? `${a.role} (foreman ${a.tier} tier)`)}`,
        `mode: ${a.meta.mode ?? "primary"}`,
        model ? `model: ${model}` : null,
        a.meta.temperature !== undefined ? `temperature: ${a.meta.temperature}` : null,
        a.meta.permission ? `permission:\n${Object.entries(a.meta.permission).map(([k, v]) => `  ${k}: ${v}`).join("\n")}` : null,
      ].filter(Boolean);
      const text = `---\n${fm.join("\n")}\n---\n\n${a.body.trim()}\n`;
      const p = join(outDir, `${a.name}.md`);
      const prev = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (prev !== text) writeFileSync(p, text);
      written.push({ name: a.name, model, path: p, changed: prev !== text });
    }
    return written;
  }

  models() {
    try {
      return JSON.parse(readFileSync(this.modelsPath, "utf8"));
    } catch {
      return { probedAt: null, models: {} };
    }
  }

  saveModels(m) {
    writeFileSync(this.modelsPath, JSON.stringify(m, null, 2) + "\n");
  }
}

// ---------- routing, budgets, briefs ---------------------------------------------

/**
 * Resolve an agent's model: agent.meta.model > tier.model > fallbacks, skipping models
 * marked dead/timeout by the probe and any model in `avoid` (e.g. one that already stalled
 * twice on this very ticket — retrying it blind would burn the same tokens again).
 */
export function resolveModel(cfg, agent, models = null, avoid = new Set()) {
  const tier = cfg.tiers[agent.tier] ?? cfg.tiers.standard;
  const candidates = [agent.meta?.model, tier?.model, ...(tier?.fallbacks ?? [])].filter(Boolean);
  const health = models?.models ?? {};
  for (const m of candidates) {
    const h = health[m];
    if (h && (h.status === "dead" || h.status === "timeout")) continue;
    if (avoid.has(m)) continue;
    return m;
  }
  return candidates.find((m) => !avoid.has(m)) ?? candidates[0] ?? null;
}

/** Models that stalled/timed out ≥ `n` times on this ticket — the router steps around them. */
export function stalledModels(ticketState, n = 2, defaultModel = null) {
  const counts = new Map();
  for (const r of ticketState?.runs ?? []) {
    if (r.status !== "stalled" && r.status !== "timeout") continue;
    // v1 runs recorded "(default)" when no --model was passed; that was the tier default.
    const m = !r.model || r.model === "(default)" ? defaultModel ?? "(default)" : r.model;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, c]) => c >= n).map(([m]) => m));
}

/**
 * route(ws, ticket, overrides) → { agent, model, tier, budget, reason }
 * assignee > routing[kind] > default worker. `tierMin` prevents a design task from
 * landing on the economy tier. Overrides: --agent, --model, --tier.
 */
export function route(ws, ticket, overrides = {}) {
  const cfg = ws.config();
  const models = ws.models();
  const agents = ws.agents();
  const kind = ticket.meta.kind ?? "implement";
  let reason;
  let agentName = overrides.agent ?? ticket.meta.assignee;
  if (agentName) reason = overrides.agent ? "override --agent" : "ticket assignee";
  else {
    agentName = cfg.routing[kind] ?? cfg.routing.implement ?? "coder";
    reason = `routing[${kind}]`;
  }
  let agent = agents.find((a) => a.name === agentName) ?? null;
  if (!agent) {
    // No roster (v1 workspace): synthesize a standard worker so `run` keeps working.
    agent = { name: agentName ?? "worker", role: "coder", tier: "standard", meta: {}, body: "", kinds: [], supervisor: null };
    reason += " (no agent file; synthesized)";
  }
  const order = ["economy", "standard", "premium"];
  let tierName = overrides.tier ?? agent.tier ?? "standard";
  const tierMin = ticket.meta.tierMin;
  if (tierMin && order.indexOf(tierName) < order.indexOf(tierMin)) {
    tierName = tierMin;
    reason += `; raised to tierMin=${tierMin}`;
  }
  const tier = cfg.tiers[tierName] ?? cfg.tiers.standard;
  const avoid = stalledModels(ws.state().tickets?.[ticket.id], 2, cfg.worker?.model ?? cfg.tiers.standard?.model ?? null);
  const model = overrides.model ?? resolveModel(cfg, { ...agent, tier: tierName }, models, avoid);
  if (avoid.size && !overrides.model && avoid.has(tier.model)) reason += `; ${tier.model.split("/").pop()} stalled ≥2× on this ticket → fallback`;
  const budget = computeBudget(ticket.meta.budget, tier, overrides);
  return { agent, model, tier: tierName, tierSpec: tier, budget, kind, reason };
}

export function computeBudget(taskBudget = {}, tier = {}, overrides = {}) {
  const b = typeof taskBudget === "object" && taskBudget ? taskBudget : {};
  return {
    steps: Number(overrides.steps ?? b.steps ?? 120),
    outTokens: Math.min(Number(b.outTokens ?? Infinity), Number(tier.maxOutPerRun ?? Infinity), Number(overrides.outTokens ?? Infinity)),
    ctxTokens: Number(overrides.ctxTokens ?? b.ctxTokens ?? tier.ctxCap ?? 60_000),
    ctxKill: Number(overrides.ctxKill ?? b.ctxKill ?? tier.ctxKill ?? Math.max(2 * Number(tier.ctxCap ?? 60_000), 120_000)),
    usd: Number(overrides.usd ?? b.usd ?? Infinity),
    minutes: Number(overrides.minutes ?? b.minutes ?? Infinity),
  };
}

/** USD for a run: reported cost if any, else tier prices × tokens. */
export function runCost(run, tierSpec = {}) {
  if (run?.cost) return run.cost;
  const inM = (run?.tokens?.input ?? 0) / 1_000_000;
  const outM = (run?.tokens?.output ?? 0) / 1_000_000;
  return inM * (tierSpec.inputPerM ?? 0) + outM * (tierSpec.outputPerM ?? 0);
}

/** Last `n` lines of the latest gate log, or "". */
export function gateTail(ws, id, n = 40) {
  const f = ws.latestVerifyLog(id);
  if (!f) return "";
  return readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-n).join("\n");
}

/**
 * Deterministic checkpoint brief for a fresh session: what the task is, what exists, what
 * the gate said, what changed. No LLM involved; capped so an expensive tier never receives
 * more than `cap` characters of context from the engine.
 */
export async function checkpointBrief(ws, ticket, { feedback = "", cap = 6000 } = {}) {
  const runDir = ws.runDir(ticket.id);
  const report = existsSync(join(runDir, "REPORT.md")) ? readFileSync(join(runDir, "REPORT.md"), "utf8") : "";
  const feedbackFile = existsSync(join(runDir, "FEEDBACK.md")) ? readFileSync(join(runDir, "FEEDBACK.md"), "utf8") : "";
  const { out: stat } = await runShell("git diff --stat 2>/dev/null | tail -25; git status --short 2>/dev/null | head -40", ws.root);
  const state = ws.state().tickets[ticket.id];
  const last = state?.runs?.at(-1);
  const sections = [
    `# CHECKPOINT BRIEF for ${ticket.id} (fresh session; a previous session worked on this)`,
    last ? `Previous run #${last.n}: ${last.status}, ${last.steps} steps, ${last.tools} tool calls, ctx ${last.tokens?.total ?? 0} tokens. Work on disk is REAL — read it, reuse it, do not start over.` : "",
    stat.trim() ? `## Working tree (git)\n${stat.trim()}` : "",
    report ? `## Last REPORT.md (worker's own claims — unverified)\n${clip(report, 2000)}` : "## No REPORT.md was written by the previous session.",
    gateTail(ws, ticket.id) ? `## Last gate output (tail)\n${clip(gateTail(ws, ticket.id), 1800)}` : "",
    feedbackFile ? `## FEEDBACK.md from the lead\n${clip(feedbackFile, 1500)}` : "",
    feedback ? `## Manager feedback\n${clip(feedback, 1200)}` : "",
  ].filter(Boolean);
  return clip(sections.join("\n\n"), cap);
}

export function clip(s, n) {
  return s.length <= n ? s : s.slice(0, n - 20) + `\n…[clipped ${s.length - n + 20} chars]`;
}

// ---------- event digest ---------------------------------------------------------

export function digestEvent(ev) {
  const p = ev.part ?? {};
  switch (ev.type) {
    case "step_start":
      return null;
    case "text": {
      const t = (p.text ?? "").trim();
      return t ? `[worker] ${t}` : null;
    }
    case "tool_use": {
      const tool = p.tool ?? "tool";
      const st = p.state ?? {};
      const input = st.input ?? {};
      let what = st.title ?? "";
      if (tool === "bash" && input.command) what = input.command;
      else if (input.filePath) what = input.filePath;
      else if (input.pattern) what = input.pattern;
      what = String(what).split("\n")[0].slice(0, 200);
      const status = st.status && st.status !== "completed" ? ` (${st.status})` : "";
      let tail = "";
      if (tool === "bash" && st.metadata && typeof st.metadata.exit === "number" && st.metadata.exit !== 0) tail = ` → exit ${st.metadata.exit}`;
      if (st.status === "error" && st.error) tail = ` → ERROR ${String(st.error).slice(0, 200)}`;
      return `[tool:${tool}]${status} ${what}${tail}`;
    }
    case "step_finish": {
      const tk = p.tokens ?? {};
      const cache = tk.cache ?? {};
      return `[step] ${p.reason ?? ""} tokens=${tk.total ?? "?"} in=${tk.input ?? "?"} out=${tk.output ?? "?"} reason=${tk.reasoning ?? 0} cacheRead=${cache.read ?? 0} cost=${p.cost ?? 0}`;
    }
    case "error":
      return `[ERROR] ${JSON.stringify(ev.error ?? ev).slice(0, 500)}`;
    default:
      return `[${ev.type}]`;
  }
}

export function runShell(cmd, cwd) {
  return new Promise((resolveDone) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("close", (code) => resolveDone({ code, out }));
  });
}
