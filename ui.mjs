/**
 * foreman ui — live terminal dashboard for the multi-model workforce.
 *
 *   ▌FOREMAN▐ project · LIVE · spend · clock
 *   NOW      three plain sentences: what the workers, the director and the scheduler are doing
 *   views    1 STREAM (manager ⇄ worker pipe, pipeline graph, tickets, worker stream)
 *            2 ORG    (hierarchy tree with live state per agent; select one, prompt it, read its reply)
 *            3 TASKS  (ticket → subtask tree with status, assignee, attempts, budget)
 *            4 COST   (spend by tier / agent / model, budgets, stall rates)
 *   keys · flash · prompt
 *
 * Phosphor theme. Pure ANSI, zero dependencies. Repaints the instant anything under
 * .foreman/ changes (fs.watch) plus a fast tick for animation. Actions launched here are
 * detached child processes — quitting never kills a running agent.
 */

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { CLI_PATH, depsOf, fmtDuration, fmtTokens, resolveModel, runCost, runShell } from "./lib.mjs";

// ---------- theme ----------------------------------------------------------------

const ESC = "\x1b[";
const fg = (n) => `${ESC}38;5;${n}m`;
const T = { reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, inv: `${ESC}7m`, g1: fg(46), g2: fg(40), g3: fg(28), g4: fg(22), amber: fg(214), red: fg(196), cyan: fg(51), teal: fg(44), grey: fg(243), ghost: fg(238), white: fg(255), mag: fg(207), blue: fg(75) };
const col = (c, s) => `${c}${s}${T.reset}`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI_RE, "");
const vlen = (s) => strip(s).length;

function fit(s, n) {
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < n) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    seen++;
    i++;
  }
  if (seen < n) out += " ".repeat(n - seen);
  return out + T.reset;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE = ["░", "▒", "▓", "█", "▓", "▒"];
const BARS = "▁▂▃▄▅▆▇█";
const STATUS = {
  queued: { glyph: "○", color: T.grey, label: "QUEUED" },
  running: { glyph: "◐", color: T.amber, label: "RUNNING" },
  "needs-review": { glyph: "◔", color: T.cyan, label: "REVIEW" },
  verified: { glyph: "●", color: T.g1, label: "VERIFIED" },
  "verify-failed": { glyph: "✗", color: T.red, label: "GATE FAIL" },
  stalled: { glyph: "✗", color: T.red, label: "STALLED" },
  failed: { glyph: "✗", color: T.red, label: "FAILED" },
  timeout: { glyph: "✗", color: T.red, label: "TIMEOUT" },
  "over-budget": { glyph: "✗", color: T.red, label: "OVER BUDGET" },
  blocked: { glyph: "⊘", color: T.red, label: "BLOCKED" },
};
const st = (s) => STATUS[s] ?? STATUS.queued;
const BROKEN = ["stalled", "failed", "timeout", "verify-failed", "over-budget", "blocked"];
const usd = (n) => `$${(n ?? 0).toFixed(n && n < 0.01 ? 4 : 2)}`;
const TIER_COLOR = { premium: T.mag, standard: T.amber, economy: T.teal };

function bar(fraction, width, color) {
  const f = Math.max(0, Math.min(1, fraction));
  const n = Math.round(f * width);
  return col(color, "█".repeat(n)) + col(T.ghost, "░".repeat(width - n));
}
function sparkline(values, width, color = T.g2) {
  const v = values.slice(-width);
  if (!v.length) return col(T.ghost, "·".repeat(width));
  const max = Math.max(...v, 1);
  return col(T.ghost, "·".repeat(width - v.length)) + col(color, v.map((x) => BARS[Math.min(7, Math.floor((x / max) * 7))]).join(""));
}

// ---------- model ----------------------------------------------------------------

function snapshot(ws) {
  const state = ws.state();
  const cfg = ws.config();
  const models = ws.models();
  const tickets = ws.tickets().map((t) => {
    const ts = state.tickets[t.id] ?? { status: "queued", runs: [] };
    const last = ts.runs.at(-1) ?? null;
    return { ...t, ts, last, status: ts.status ?? "queued", deps: depsOf(t.meta), parent: t.meta.parent ? String(t.meta.parent) : null };
  });
  const running = tickets.filter((t) => t.status === "running");
  const allRuns = tickets.flatMap((t) => t.ts.runs.map((r) => ({ ...r, id: t.id })));
  const costOf = (r) => r.usd ?? runCost(r, cfg.tiers[r.tier] ?? {});
  const spend = allRuns.reduce((a, r) => a + costOf(r), 0);
  const tokensAll = allRuns.reduce((a, r) => a + (r.tokens?.output ?? 0) + (r.tokens?.input ?? 0), 0);
  const agents = ws.agents().map((a) => ({ ...a, model: a.name === "director" ? "(you)" : resolveModel(cfg, a, models) }));
  return { state, cfg, models, tickets, running, allRuns, agents, activity: state.activity ?? [], manager: state.manager ?? null, spend, tokensAll, costOf, estimated: !allRuns.some((r) => r.cost) && Object.values(cfg.tiers).some((t) => t.inputPerM || t.outputPerM) };
}

function parseLog(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const m = line.match(/^\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s+(.*)$/);
    if (m && (m[1] || m[2] || m[3])) out.push({ offset: ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000, text: m[4], raw: line });
    else out.push({ offset: null, text: line, raw: line });
  }
  return out;
}
const shortPath = (s) => s.replace(/\/home\/[^ ]*?\/(packages|apps|src|docs|\.foreman)\//g, "$1/");

function workerPhase(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const l = entries[i].text;
    if (l.startsWith("[foreman] OVER BUDGET")) return { phase: "over budget", detail: l.slice(10), verb: "was stopped: over budget" };
    if (l.startsWith("[foreman]")) return { phase: "stopped", detail: l.slice(10), verb: "was stopped by the watchdog" };
    if (l.startsWith("# run ")) return { phase: "done", detail: l.slice(2), verb: "has finished" };
    if (l.startsWith("[step] stop")) return { phase: "finished turn", detail: "", verb: "ended its turn" };
    const m = l.match(/^\[tool:(\w+)\]\s*(.*)$/);
    if (m) {
      const verbs = { read: "reading", write: "writing", edit: "editing", bash: "running", grep: "searching", glob: "searching", list: "listing", todowrite: "planning", task: "delegating", webfetch: "fetching" };
      const v = verbs[m[1]] ?? m[1];
      return { phase: v, detail: shortPath(m[2]), verb: `is ${v} ${shortPath(m[2]).slice(0, 56)}` };
    }
    if (l.startsWith("[worker]")) return { phase: "thinking", detail: l.slice(9), verb: `says: ${l.slice(9, 76)}` };
    if (l.startsWith("[ERROR]")) return { phase: "error", detail: l.slice(8), verb: "hit an error" };
  }
  return { phase: "starting", detail: "", verb: "is starting up" };
}
function heartbeat(entries, startMs, width, bucketMs = 5000) {
  const now = Date.now();
  const b = new Array(width).fill(0);
  for (const e of entries) {
    if (e.offset === null) continue;
    const idx = width - 1 - Math.floor((now - (startMs + e.offset)) / bucketMs);
    if (idx >= 0 && idx < width) b[idx]++;
  }
  const max = Math.max(...b, 1);
  return b.map((n, i) => (n ? col(i >= width - 2 ? T.white : T.g1, BARS[Math.min(7, Math.ceil((n / max) * 7))]) : col(T.ghost, "·"))).join("");
}
const stepTokens = (entries) => entries.map((e) => e.text.match(/^\[step\].*?tokens=(\d+)/)).filter(Boolean).map((m) => Number(m[1]));

// ---------- graph ----------------------------------------------------------------

const U = 1, D = 2, L = 4, R = 8;
const JOIN = { [L | R]: "─", [U | D]: "│", [D | R]: "┌", [D | L]: "┐", [U | R]: "└", [U | L]: "┘", [U | D | R]: "├", [U | D | L]: "┤", [L | R | D]: "┬", [L | R | U]: "┴", [U | D | L | R]: "┼", [U]: "│", [D]: "│", [L]: "─", [R]: "─" };

function drawGraph(tickets, selectedId, frame, maxWidth) {
  const top = tickets.filter((t) => !t.parent); // subtasks are shown in the TASKS view
  const byId = new Map(top.map((t) => [t.id, t]));
  const level = new Map();
  const lvl = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = byId.get(id);
    const deps = t ? t.deps.filter((d) => byId.has(d)) : [];
    const v = deps.length ? 1 + Math.max(...deps.map((d) => lvl(d, seen))) : 0;
    level.set(id, v);
    return v;
  };
  top.forEach((t) => lvl(t.id));
  const columns = [];
  for (const t of top) (columns[level.get(t.id)] ??= []).push(t);
  if (!columns.length) return { lines: [col(T.grey, 'no tickets yet — foreman ticket <slug> --title "..."')] };
  const NW = 20;
  const edges = top.flatMap((t) => t.deps.filter((d) => byId.has(d)).map((d) => ({ from: d, to: t.id })));
  const gapNeeded = (li) => Math.max(3, edges.filter((e) => level.get(e.from) === li && level.get(e.to) === li + 1).length + 2);
  const colX = [];
  let x = 0;
  columns.forEach((_, li) => {
    colX[li] = x;
    x += NW + gapNeeded(li) + 1;
  });
  const skipEdges = edges.filter((e) => level.get(e.to) - level.get(e.from) > 1);
  const nodeRows = Math.max(...columns.map((c) => c.length)) * 2 - 1;
  const H = nodeRows + (skipEdges.length ? 1 + skipEdges.length : 0);
  const W = x;
  const mask = Array.from({ length: H }, () => new Uint8Array(W));
  const lit = Array.from({ length: H }, () => new Uint8Array(W));
  const pos = new Map();
  columns.forEach((cItems, li) => cItems.forEach((t, i) => pos.set(t.id, { x: colX[li], y: i * 2, li })));
  const chain = new Set();
  if (selectedId && byId.has(selectedId)) {
    const up = (id) => {
      if (chain.has(id)) return;
      chain.add(id);
      byId.get(id)?.deps.forEach(up);
    };
    up(selectedId);
    const down = (id) => top.filter((t) => t.deps.includes(id)).forEach((t) => (chain.has(t.id) ? null : (chain.add(t.id), down(t.id))));
    down(selectedId);
  }
  const hline = (y, x1, x2, on) => {
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let i = a; i <= b; i++) {
      if (i > a) mask[y][i] |= L;
      if (i < b) mask[y][i] |= R;
      if (on) lit[y][i] = 1;
    }
  };
  const vline = (xx, y1, y2, on) => {
    const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let j = a; j <= b; j++) {
      if (j > a) mask[j][xx] |= U;
      if (j < b) mask[j][xx] |= D;
      if (on) lit[j][xx] = 1;
    }
  };
  const railUse = new Map();
  const arrows = [];
  [...edges]
    .sort((p, q) => (pos.get(q.to)?.y ?? 0) - (pos.get(p.to)?.y ?? 0))
    .forEach((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return;
      const on = chain.has(e.from) && chain.has(e.to);
      const ax = a.x + NW;
      const bx = b.x - 1;
      if (b.li === a.li + 1) {
        const used = railUse.get(a.li) ?? 0;
        railUse.set(a.li, used + 1);
        const rail = ax + 1 + used;
        hline(a.y, ax, rail, on);
        vline(rail, a.y, b.y, on);
        hline(b.y, rail, bx, on);
      } else {
        const bus = nodeRows + 1 + skipEdges.indexOf(e);
        hline(a.y, ax, ax + 1, on);
        vline(ax + 1, a.y, bus, on);
        hline(bus, ax + 1, bx - 1, on);
        vline(bx - 1, bus, b.y, on);
        hline(b.y, bx - 1, bx, on);
      }
      arrows.push({ x: bx, y: b.y, on });
    });
  const grid = mask.map((row, y) => Array.from(row, (m, xx) => (m ? col(lit[y][xx] ? T.cyan : T.g4, JOIN[m] ?? "┼") : " ")));
  arrows.forEach(({ x: ax, y, on }) => (grid[y][ax] = col(on ? T.cyan : T.g4, "▶")));
  for (const t of top) {
    const p = pos.get(t.id);
    const s = st(t.status);
    const glyph = t.status === "running" ? SPINNER[frame % SPINNER.length] : s.glyph;
    const title = String(t.meta.title ?? "").slice(0, NW - 8);
    const dimmed = chain.size && !chain.has(t.id);
    let label = fit(dimmed ? col(T.ghost, `${glyph} ${t.id} ${title}`) : `${col(s.color, glyph)} ${col(T.g1 + T.bold, t.id)} ${col(T.g3, title)}`, NW);
    if (t.id === selectedId) label = `${T.inv}${T.g1}${strip(label)}${T.reset}`;
    grid[p.y].splice(p.x, NW, ...Array(NW - 1).fill(""), label);
  }
  return { lines: grid.map((row) => fit(row.join(""), Math.min(W, maxWidth))) };
}

// ---------- panels ---------------------------------------------------------------

function box(title, inner, width, height, titleColor = T.g1) {
  const head = `┌─[ ${title} ]`;
  const top = col(T.g3, "┌─[ ") + col(titleColor + T.bold, title) + col(T.g3, " ]" + "─".repeat(Math.max(0, width - vlen(head) - 2)) + "┐");
  const rows = [];
  for (let i = 0; i < height - 2; i++) rows.push(col(T.g3, "│") + " " + fit(inner[i] ?? "", width - 4) + " " + col(T.g3, "│"));
  return [fit(top, width), ...rows, col(T.g3, "└" + "─".repeat(width - 2) + "┘")];
}
const lbl = (s) => col(T.g3, s.padEnd(8));

function nowPanel(snap, frame, width, ctx) {
  const { running, manager, tickets } = snap;
  const review = tickets.filter((t) => t.status === "needs-review");
  const broken = tickets.filter((t) => BROKEN.includes(t.status));
  const nextQueued = tickets.find((t) => t.status === "queued" && t.deps.every((d) => tickets.find((x) => x.id === d)?.status === "verified"));
  let worker;
  if (running.length) {
    worker = running
      .slice(0, 2)
      .map((r) => {
        const wp = workerPhase(parseLog(ctx.ws.latestLog(r.id)));
        const run = r.last;
        return `${col(T.amber + T.bold, (run?.agent ?? "WORKER").toUpperCase())} ${wp.verb} ${col(T.grey, `— ${r.id} #${run?.n ?? "?"} on ${(run?.model ?? "").split("/").pop()}, ${fmtDuration(Date.now() - Date.parse(run?.startedAt ?? 0))}`)}`;
      })
      .join("  ┃  ");
  } else if (broken.length) worker = `${col(T.red + T.bold, "WORKERS")} idle; ${broken.map((t) => `${t.id} ${st(t.status).label.toLowerCase()}`).join(", ")} ${col(T.grey, "— needs you: c coach · v gate · a accept · p ask the lead")}`;
  else worker = `${col(T.grey + T.bold, "WORKERS")} idle ${col(T.grey, nextQueued ? `— ${nextQueued.id} is ready (r run · w work)` : "— nothing ready to dispatch")}`;
  const mp = manager?.phase ?? "idle";
  const mSince = manager ? fmtDuration(Date.now() - Date.parse(manager.at)) : "";
  const mText = { dispatching: `handed ${manager?.detail ?? ""} to a worker`, coaching: `sent feedback into ${manager?.detail ?? ""}`, verifying: `is running the gate for ${manager?.detail ?? ""}`, reviewing: `is reviewing ${manager?.detail ?? ""}${review.length ? " — a report is waiting" : ""}`, accepted: `accepted ${manager?.detail ?? ""}`, writing: `is writing ${manager?.detail ?? ""}`, scheduling: `started the work daemon`, idle: "is idle" }[mp] ?? mp;
  const mgr = `${col(T.cyan + T.bold, "DIRECTOR")} ${mText} ${col(T.grey, mSince ? `— ${mSince} ago` : "")}`;
  const queued = tickets.filter((t) => t.status === "queued");
  const sched = ctx.workRunning
    ? `${col(T.g1 + T.bold, "SCHEDULER")} work daemon running ${col(T.grey, `— ${running.length} in flight, ${queued.length} queued; failures climb the ladder (fresh → lead review → blocked)`)}`
    : ctx.queueRunning
      ? `${col(T.g1 + T.bold, "SCHEDULER")} queue running ${col(T.grey, `— ${queued.length} queued; stops at the first failed gate`)}`
      : `${col(T.grey + T.bold, "SCHEDULER")} not running ${col(T.grey, `— ${queued.length} queued; w starts the work daemon, q the simple queue`)}`;
  return box(`NOW ${PULSE[frame % PULSE.length]}`, [worker, mgr, sched], width, 5, T.g1);
}

function agentsPanel(snap, entries, frame, width, ctx) {
  const { manager, running, tickets, cfg } = snap;
  const r0 = running[0] ?? null;
  const verified = tickets.filter((t) => t.status === "verified").length;
  const review = tickets.filter((t) => t.status === "needs-review").length;
  const broken = tickets.filter((t) => BROKEN.includes(t.status)).length;
  const since = manager ? fmtDuration(Date.now() - Date.parse(manager.at)) : "";
  const mgr = [
    `${lbl("phase")}${col(T.cyan + T.bold, (manager?.phase ?? "idle").toUpperCase())} ${col(T.grey, (manager?.detail ?? "").slice(0, 36))}`,
    `${lbl("since")}${since || "—"}`,
    `${lbl("tickets")}${tickets.length}  ${col(T.g1, `● ${verified}`)}  ${col(T.cyan, `◔ ${review}`)}  ${broken ? col(T.red, `✗ ${broken}`) : col(T.ghost, "✗ 0")}`,
    `${lbl("done")}${bar(tickets.length ? verified / tickets.length : 0, 20, T.g1)} ${verified}/${tickets.length}`,
    `${lbl("git")}${col(T.grey, (ctx.gitHead ?? "").slice(0, 44))}`,
    `${lbl("spend")}${col(T.amber + T.bold, usd(snap.spend))} ${col(T.grey, snap.spend ? (snap.estimated ? "estimated" : "reported") : "free tier — $0 reported")} ${col(T.grey, `· ${fmtTokens(snap.tokensAll)} tokens`)}`,
  ];
  const run = r0?.last;
  const hbWidth = Math.max(12, Math.min(40, Math.floor(width / 2) - 44));
  let wk;
  if (r0 && run) {
    const wp = workerPhase(entries);
    const startMs = Date.parse(run.startedAt);
    const elapsedMs = Date.now() - startMs;
    const idleMs = run.lastEventAt ? Date.now() - Date.parse(run.lastEventAt) : elapsedMs;
    const idleLimit = Number(r0.meta.idle ?? cfg.worker?.idleMinutes ?? 5) * 60_000;
    const budget = run.budget ?? {};
    const evPerMin = entries.filter((e) => e.offset !== null && startMs + e.offset > Date.now() - 60_000).length;
    const idleColor = idleMs > idleLimit * 0.66 ? T.red : idleMs > idleLimit * 0.33 ? T.amber : T.g1;
    const tc = TIER_COLOR[run.tier] ?? T.amber;
    wk = [
      `${lbl("phase")}${col(T.amber + T.bold, wp.phase.toUpperCase())} ${col(T.grey, wp.detail.slice(0, 44))}`,
      `${lbl("who")}${col(tc + T.bold, run.agent ?? "worker")} ${col(tc, run.tier ?? "")} ${col(T.grey, (run.model ?? "").split("/").pop())}  ${col(T.g1 + T.bold, r0.id)} #${run.n}${run.continued ? col(T.mag, " ↩") : run.brief ? col(T.teal, " ⟲brief") : ""}  ${fmtDuration(elapsedMs)}`,
      `${lbl("pulse")}${heartbeat(entries, startMs, hbWidth)} ${col(T.grey, `${evPerMin} ev/min · steps ${run.steps}/${budget.steps ?? "∞"} · tools ${run.tools}`)}`,
      `${lbl("tokens")}${sparkline(stepTokens(entries), hbWidth)} ${col(T.grey, `ctx ${fmtTokens(run.tokens?.total)}/${fmtTokens(budget.ctxTokens)} · out ${fmtTokens(run.tokens?.output)}/${fmtTokens(budget.outTokens === Infinity ? 0 : budget.outTokens) || "∞"}`)}`,
      `${lbl("idle")}${bar(idleMs / idleLimit, 12, idleColor)} ${col(idleColor, fmtDuration(idleMs))}${col(T.grey, `/${fmtDuration(idleLimit)} stall`)}  ${lbl("ctx").trim()} ${bar((run.tokens?.total ?? 0) / (budget.ctxTokens || 1), 8, T.teal)}`,
      `${lbl("usd")}${col(T.amber + T.bold, usd(snap.costOf(run)))} ${col(T.grey, run.cost ? "this run" : "this run (free tier)")}${running.length > 1 ? col(T.grey, `   +${running.length - 1} more running — see ORG`) : ""}`,
    ];
  } else {
    const lastRun = snap.allRuns.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    const nextQueued = tickets.find((t) => t.status === "queued" && t.deps.every((d) => tickets.find((x) => x.id === d)?.status === "verified"));
    wk = [
      `${lbl("phase")}${col(T.grey + T.bold, "IDLE")}${review ? col(T.cyan, "  waiting for the director's review") : ""}`,
      lastRun ? `${lbl("last")}${lastRun.id} #${lastRun.n} ${col(st(lastRun.status === "finished" ? "needs-review" : lastRun.status).color, lastRun.status)} ${col(T.grey, `by ${lastRun.agent ?? "worker"} on ${(lastRun.model ?? "").split("/").pop()} · ${fmtDuration(Date.parse(lastRun.endedAt ?? lastRun.startedAt) - Date.parse(lastRun.startedAt))} · ${fmtTokens(lastRun.tokens?.total)} ctx · ${usd(snap.costOf(lastRun))}`)}` : `${lbl("last")}no runs yet`,
      `${lbl("pulse")}${col(T.ghost, "·".repeat(hbWidth))}`,
      `${lbl("ready")}${nextQueued ? `${col(T.g1 + T.bold, nextQueued.id)} ${col(T.grey, String(nextQueued.meta.title ?? "").slice(0, 44))}` : col(T.ghost, "nothing dispatchable")}`,
      ``,
      `${lbl("roster")}${snap.agents.filter((a) => a.name !== "director").map((a) => col(TIER_COLOR[a.tier] ?? T.grey, a.name)).join(" ")}`,
    ];
  }
  const w = 16;
  const shift = frame % 4;
  const flowRight = col(T.amber, Array.from({ length: w }, (_, i) => ((i + shift) % 4 === 0 ? "▶" : "═")).join(""));
  const flowLeft = col(T.cyan, Array.from({ length: w }, (_, i) => ((i - shift + 8) % 4 === 0 ? "◀" : "═")).join(""));
  const still = col(T.ghost, "─".repeat(w));
  const lastAct = snap.activity.at(-1);
  const who = (a) => (a === "worker" ? col(T.amber, "W") : a === "manager" ? col(T.cyan, "D") : col(T.g2, "F"));
  const pipe = ["", col(T.g3, "  ticket ▸"), running.length ? flowRight : still, !running.length && (review > 0 || manager?.phase === "reviewing") ? flowLeft : still, col(T.g3, "  ◂ report"), lastAct ? `${col(T.ghost, lastAct.at.slice(11, 16))} ${who(lastAct.actor)}` : ""];
  const side = Math.floor((width - w - 6) / 2);
  const leftBox = box("DIRECTOR :: YOU / CLAUDE", mgr, side, 8, T.cyan);
  const rightBox = box(`WORKER :: ${(run?.agent ?? "roster").toUpperCase()}`, wk, width - side - w - 6, 8, T.amber);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(leftBox[i] + " " + fit(pipe[i - 1] ?? "", w + 4) + " " + rightBox[i]);
  return out;
}

function ticketsPanel(snap, selectedIdx, width, height, changed) {
  const lines = snap.tickets.map((t, i) => {
    const s = st(t.status);
    const verify = t.ts.lastVerify ? (t.ts.lastVerify.ok ? col(T.g1, "GATE✓") : col(T.red, "GATE✗")) : col(T.ghost, "gate–");
    const runs = t.ts.runs.length ? col(T.grey, `r${t.ts.runs.length}`) : "  ";
    const cost = usd(t.ts.runs.reduce((a, r) => a + snap.costOf(r), 0));
    const who = t.last?.agent ? col(TIER_COLOR[t.last.tier] ?? T.grey, t.last.agent.slice(0, 6).padEnd(6)) : "      ";
    const fresh = changed.get(t.id) && Date.now() - changed.get(t.id) < 6000;
    let line = `${t.parent ? " └" : ""}${col(s.color, s.glyph)} ${col(T.g1 + T.bold, t.id.padEnd(7))} ${col(s.color, s.label.padEnd(9))} ${who} ${runs} ${verify} ${col(T.amber, cost.padStart(6))} ${col(T.g3, String(t.meta.title ?? ""))}`;
    if (fresh) line = `${T.bold}${T.white}${strip(line)}${T.reset}`;
    if (i === selectedIdx) line = T.inv + T.g1 + strip(line) + T.reset;
    return line;
  });
  return box(`TICKETS ${snap.tickets.length}  ↑↓ · enter`, lines, width, height);
}

function streamPanel(snap, entries, mode, sel, scroll, width, height, ws) {
  const inner = height - 2;
  const window = (arr) => {
    const end = Math.max(0, arr.length - scroll);
    return arr.slice(Math.max(0, end - inner), end);
  };
  const scrollTag = scroll ? col(T.amber, ` ▲${scroll} end=follow`) : col(T.g3, " ⟳ following");
  if (mode === "activity") {
    const lines = window(snap.activity).map((a) => {
      const who = a.actor === "manager" ? col(T.cyan, "DIRECTR") : a.actor === "worker" ? col(T.amber, (a.agent ?? "worker").slice(0, 7).padEnd(7)) : col(T.g2, "FOREMAN");
      const lvl = a.level === "error" ? T.red : a.level === "warn" ? T.amber : a.level === "ok" ? T.g1 : T.g2;
      const fresh = Date.now() - Date.parse(a.at) < 8000 ? T.bold : "";
      return `${col(T.ghost, a.at.slice(11, 19))} ${who} ${fresh}${lvl}${a.text}${T.reset}`;
    });
    return box(`ACTIVITY  hand-offs${scrollTag}  [tab]`, lines, width, height, T.teal);
  }
  if (mode === "report") {
    const p = sel ? join(ws.runsDir, sel.id, "REPORT.md") : null;
    const fb = sel ? join(ws.runsDir, sel.id, "FEEDBACK.md") : null;
    let text = p && existsSync(p) ? readFileSync(p, "utf8") : `(no REPORT.md for ${sel?.id ?? "—"} yet)`;
    if (fb && existsSync(fb)) text = `# FEEDBACK.md (lead)\n${readFileSync(fb, "utf8")}\n\n${text}`;
    const lines = window(text.split("\n")).map((l) => (l.startsWith("## ") ? col(T.g1 + T.bold, l) : l.startsWith("# ") ? col(T.amber + T.bold, l) : col(T.g2, l)));
    return box(`REPORT ${sel?.id ?? ""}  the worker's claims — the gate decides${scrollTag}  [tab]`, lines, width, height, T.g1);
  }
  if (mode === "detail" && sel) {
    const ts = sel.ts;
    const lines = [
      `${col(T.g1 + T.bold, sel.id)}  ${col(T.g2, sel.meta.title ?? "")}`,
      `${lbl("status")}${col(st(sel.status).color, sel.status)}   ${lbl("kind").trim()} ${sel.meta.kind ?? "implement"}   ${lbl("deps").trim()} ${sel.deps.join(", ") || "—"}   ${lbl("attempts").trim()} ${ts.attempts ?? 0}${ts.waitingOn ? `   waiting on ${ts.waitingOn}` : ""}`,
      `${lbl("gate")}${col(T.grey, (sel.meta.verify ?? []).join(" && ") || "—")}`,
      ts.acceptance ? `${lbl("accept")}${col(T.g1, ts.acceptance.at.slice(0, 16))} ${ts.acceptance.note}` : "",
      "",
      col(T.g3, "runs    #  status       agent    tier      model                  started      duration  steps  tools   ctx      usd"),
      ...ts.runs.map((r) => `       ${String(r.n).padStart(2)}  ${col(st(r.status === "finished" ? "needs-review" : r.status).color, (r.status ?? "").padEnd(11))} ${(r.agent ?? "-").padEnd(8)} ${col(TIER_COLOR[r.tier] ?? T.grey, (r.tier ?? "").padEnd(9))} ${(r.model ?? "").split("/").pop().slice(0, 22).padEnd(22)} ${col(T.grey, r.startedAt.slice(5, 16).replace("T", " "))} ${fmtDuration(Date.parse(r.endedAt ?? new Date().toISOString()) - Date.parse(r.startedAt)).padStart(8)}  ${String(r.steps).padStart(5)}  ${String(r.tools).padStart(5)}  ${fmtTokens(r.tokens?.total).padStart(6)}  ${col(T.amber, usd(snap.costOf(r)).padStart(7))}${r.continued ? col(T.mag, " ↩") : ""}${r.overBudget ? col(T.red, ` ${r.overBudget}`) : ""}`),
      "",
      ts.lastVerify ? `${lbl("gate")}#${ts.lastVerify.n} ${ts.lastVerify.ok ? col(T.g1 + T.bold, "ALL PASS") : col(T.red + T.bold, "FAILED")} ${col(T.grey, ts.lastVerify.at.slice(0, 16))}` : `${lbl("gate")}not run`,
      ...(ts.lastVerify?.results ?? []).map((r) => `        ${r.ok ? col(T.g1, "PASS") : col(T.red, "FAIL")} ${col(T.grey, fmtDuration(r.ms).padStart(6))}  ${r.cmd}`),
    ];
    return box(`DETAIL ${sel.id}   esc/enter closes`, lines, width, height, T.mag);
  }
  const now = Date.now();
  const startMs = snap.streamRun ? Date.parse(snap.streamRun.startedAt) : 0;
  const lines = window(entries).map((e) => {
    let l = shortPath(e.raw);
    const fresh = e.offset !== null && startMs && now - (startMs + e.offset) < 4000;
    if (l.includes("[tool:bash]")) l = l.replace("[tool:bash]", col(T.amber, "$"));
    else if (l.includes("[tool:write]") || l.includes("[tool:edit]")) l = l.replace(/\[tool:(write|edit)\]/, col(T.g1, "✎ $1"));
    else if (l.includes("[tool:")) l = l.replace(/\[tool:(\w+)\]/, col(T.teal, "⌕ $1"));
    else if (l.includes("[worker]")) l = l.replace("[worker]", col(T.mag, "💬"));
    else if (l.includes("[step]")) l = col(T.ghost, l);
    else if (l.includes("[foreman]") || l.includes("[ERROR]")) l = col(T.red + T.bold, l);
    else if (l.startsWith("# ")) l = col(T.g3, l);
    else l = col(T.g2, l);
    return fresh ? `${T.bold}${T.white}${strip(l)}${T.reset}` : l;
  });
  return box(`STREAM ${snap.streamTicket ?? "—"}  ${entries.length} events${scrollTag}  [tab]`, lines, width, height, T.amber);
}

// ---------- ORG view --------------------------------------------------------------

function orgTree(agents) {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const children = (n) => agents.filter((a) => a.supervisor === n).sort((p, q) => p.name.localeCompare(q.name));
  const roots = agents.filter((a) => !a.supervisor || !byName.has(a.supervisor));
  const out = [];
  const walk = (a, prefix, last) => {
    out.push({ agent: a, prefix, last });
    const kids = children(a.name);
    kids.forEach((k, i) => walk(k, prefix + (last ? "   " : "│  "), i === kids.length - 1));
  };
  roots.forEach((r, i) => walk(r, "", i === roots.length - 1));
  return out;
}

function agentLiveState(ws, snap, a) {
  const runningTicket = snap.running.find((t) => t.last?.agent === a.name);
  if (runningTicket) {
    const entries = parseLog(ws.latestLog(runningTicket.id));
    const wp = workerPhase(entries);
    return { phase: wp.phase, detail: wp.detail, ticket: runningTicket.id, run: runningTicket.last, entries, live: true };
  }
  const s = a.state ?? {};
  if (s.phase === "answering") {
    const dir = join(ws.agentsDir, a.name);
    const logs = existsSync(dir) ? readdirSync(dir).filter((f) => /^ask-\d+\.log$/.test(f)).sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0])) : [];
    const entries = logs.length ? parseLog(join(dir, logs.at(-1))) : [];
    const wp = workerPhase(entries);
    return { phase: `answering · ${wp.phase}`, detail: wp.detail, ticket: s.task, entries, live: true };
  }
  return { phase: "idle", detail: s.lastRun ? `last ${s.lastRun.ticket} #${s.lastRun.n} ${s.lastRun.status}` : "", entries: [], live: false };
}

function orgPanel(ws, snap, selectedAgent, frame, width, height) {
  const rows = orgTree(snap.agents);
  const lines = rows.map(({ agent: a, prefix, last }) => {
    const live = agentLiveState(ws, snap, a);
    const tc = TIER_COLOR[a.tier] ?? T.grey;
    const branch = col(T.g4, prefix + (prefix === "" ? "" : last ? "└─ " : "├─ "));
    const glyph = live.live ? col(T.amber, SPINNER[frame % SPINNER.length]) : a.name === "director" ? col(T.cyan, "◆") : col(T.g3, "●");
    const sessions = (a.state?.sessions ?? []).length;
    const ctxCap = snap.cfg.tiers[a.tier]?.ctxCap ?? 0;
    const lastSess = (a.state?.sessions ?? []).at(-1);
    const ctxPart = lastSess ? `${fmtTokens(lastSess.ctxTokens)}/${fmtTokens(ctxCap)}` : "—";
    let line = `${branch}${glyph} ${col(T.g1 + T.bold, a.name.padEnd(10))} ${col(tc, a.tier.padEnd(8))} ${col(T.grey, String(a.model ?? "").split("/").pop().slice(0, 22).padEnd(22))} ${live.live ? col(T.amber, live.phase.toUpperCase().padEnd(10)) : col(T.ghost, "idle".padEnd(10))} ${col(T.grey, (live.ticket ?? "").padEnd(9))} ${col(T.amber, usd(a.state?.spend ?? 0).padStart(6))} ${col(T.grey, `${a.state?.runs ?? 0}r ${sessions}s ctx ${ctxPart}`)}${a.state?.stalls ? col(T.red, ` ${a.state.stalls}✗`) : ""}`;
    if (a.name === selectedAgent) line = T.inv + T.g1 + strip(line) + T.reset;
    return line;
  });
  lines.push("", col(T.g3, "tier ") + Object.entries(snap.cfg.tiers).map(([n, t]) => `${col(TIER_COLOR[n] ?? T.grey, n)} ${col(T.grey, (t.model ?? "").split("/").pop())} ${col(T.ghost, `cap ${fmtTokens(t.ctxCap)}`)}`).join("   "));
  return box(`ORG  hierarchy · live phase · spend · sessions   ↑↓ select · p prompt · enter detail`, lines, width, height, T.mag);
}

function agentPanel(ws, snap, a, scroll, width, height) {
  if (!a) return box("AGENT", ["select an agent"], width, height, T.mag);
  const inner = height - 2;
  const live = agentLiveState(ws, snap, a);
  const dir = join(ws.agentsDir, a.name);
  const replies = existsSync(join(dir, "replies")) ? readdirSync(join(dir, "replies")).filter((f) => f.endsWith(".md")).sort((x, y) => Number(x) - Number(y)) : [];
  const lastReply = replies.length ? readFileSync(join(dir, "replies", replies.at(-1)), "utf8") : "";
  const tc = TIER_COLOR[a.tier] ?? T.grey;
  const head = [
    `${col(T.g1 + T.bold, a.name.toUpperCase())} ${col(tc, a.tier)} ${col(T.grey, a.model ?? "")}   ${col(T.g3, "role")} ${a.role}   ${col(T.g3, "reports to")} ${a.supervisor ?? "—"}   ${col(T.g3, "kinds")} ${a.kinds.join(", ") || "—"}`,
    `${col(T.g3, "now ")} ${live.live ? col(T.amber + T.bold, live.phase.toUpperCase()) : col(T.ghost, "IDLE")} ${col(T.grey, live.detail.slice(0, 70))}${live.ticket ? col(T.grey, `  on ${live.ticket}`) : ""}`,
    `${col(T.g3, "life")} ${a.state?.runs ?? 0} runs · ${(a.state?.sessions ?? []).length} sessions · ${fmtTokens(a.state?.tokens)} tokens · ${col(T.amber, usd(a.state?.spend ?? 0))}${a.state?.stalls ? col(T.red, ` · ${a.state.stalls} stalls`) : ""} · last active ${a.state?.lastActive ? fmtDuration(Date.now() - Date.parse(a.state.lastActive)) + " ago" : "never"}`,
    col(T.g4, "─".repeat(Math.max(10, width - 6))),
  ];
  let body;
  if (live.live && live.entries.length) {
    body = live.entries.slice(-(inner - head.length)).map((e) => {
      let l = shortPath(e.raw);
      if (l.includes("[tool:bash]")) l = l.replace("[tool:bash]", col(T.amber, "$"));
      else if (/\[tool:(write|edit)\]/.test(l)) l = l.replace(/\[tool:(write|edit)\]/, col(T.g1, "✎ $1"));
      else if (l.includes("[tool:")) l = l.replace(/\[tool:(\w+)\]/, col(T.teal, "⌕ $1"));
      else if (l.includes("[worker]")) l = l.replace("[worker]", col(T.mag, "💬"));
      else if (l.includes("[step]")) l = col(T.ghost, l);
      return l;
    });
  } else {
    const persona = a.body.trim().split("\n").slice(0, 6).map((l) => col(T.g3, l));
    const rep = lastReply ? lastReply.split("\n").map((l) => (l.startsWith("# ") ? col(T.amber + T.bold, l) : l.startsWith("**Q:**") ? col(T.cyan, l) : col(T.g2, l))) : [col(T.ghost, "no replies yet — press p to ask this agent something")];
    body = [...persona, "", col(T.g3, `last reply (${replies.length} total)`), ...rep];
    const end = Math.max(0, body.length - scroll);
    body = body.slice(Math.max(0, end - (inner - head.length)), end);
  }
  return box(`AGENT ${a.name}   p prompt · pgup/pgdn scroll · esc back`, [...head, ...body], width, height, T.mag);
}

// ---------- TASKS view -------------------------------------------------------------

function tasksPanel(snap, selectedIdx, width, height) {
  const top = snap.tickets.filter((t) => !t.parent);
  const kids = (id) => snap.tickets.filter((t) => t.parent === id);
  const lines = [];
  const walk = (t, depth) => {
    const s = st(t.status);
    const b = t.last?.budget ?? {};
    const used = t.last ? `${t.last.steps}/${b.steps ?? "∞"} steps · ${fmtTokens(t.last.tokens?.output)}/${b.outTokens && b.outTokens !== Infinity ? fmtTokens(b.outTokens) : "∞"} out` : "";
    const i = lines.length;
    let line = `${"  ".repeat(depth)}${depth ? col(T.g4, "└ ") : ""}${col(s.color, s.glyph)} ${col(T.g1 + T.bold, t.id.padEnd(12))} ${col(s.color, s.label.padEnd(11))} ${col(T.teal, String(t.meta.kind ?? "implement").padEnd(9))} ${col(TIER_COLOR[t.last?.tier] ?? T.grey, (t.last?.agent ?? t.meta.assignee ?? "").padEnd(9))} ${col(T.grey, `a${t.ts.attempts ?? 0}`)} ${col(T.grey, used.padEnd(28))} ${col(T.g3, String(t.meta.title ?? "").slice(0, 50))}`;
    if (i === selectedIdx) line = T.inv + T.g1 + strip(line) + T.reset;
    lines.push(line);
    kids(t.id).forEach((k) => walk(k, depth + 1));
  };
  top.forEach((t) => walk(t, 0));
  return box(`TASKS  ticket → subtasks · kind · assignee · attempts · budget used   ↑↓ · enter detail`, lines, width, height, T.teal);
}

// ---------- COST view --------------------------------------------------------------

function costPanel(snap, width, height) {
  const fold = (keyOf) => {
    const m = new Map();
    for (const r of snap.allRuns) {
      const k = keyOf(r);
      const x = m.get(k) ?? { runs: 0, in: 0, out: 0, usd: 0, stalls: 0, ok: 0 };
      x.runs++;
      x.in += r.tokens?.input ?? 0;
      x.out += r.tokens?.output ?? 0;
      x.usd += snap.costOf(r);
      if (r.status === "stalled" || r.status === "timeout") x.stalls++;
      if (r.status === "finished") x.ok++;
      m.set(k, x);
    }
    return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].out - a[1].out);
  };
  const maxUsd = Math.max(...snap.allRuns.map((r) => snap.costOf(r)), 0.0001);
  const table = (title, rows, colorOf) => [
    col(T.g1 + T.bold, title),
    col(T.g3, `${"".padEnd(28)} runs    in tok   out tok      usd  stall  ok   share`),
    ...rows.map(([k, x]) => `${colorOf(k)}${String(k).split("/").pop().slice(0, 28).padEnd(28)}${T.reset} ${String(x.runs).padStart(4)} ${fmtTokens(x.in).padStart(9)} ${fmtTokens(x.out).padStart(9)} ${col(T.amber, usd(x.usd).padStart(8))} ${x.stalls ? col(T.red, String(x.stalls).padStart(6)) : String(x.stalls).padStart(6)} ${String(x.ok).padStart(3)}   ${bar(snap.spend ? x.usd / snap.spend : x.out / Math.max(1, snap.allRuns.reduce((a, r) => a + (r.tokens?.output ?? 0), 0)), 12, T.g2)}`),
    "",
  ];
  const lines = [
    `${col(T.g3, "total spend")} ${col(T.amber + T.bold, usd(snap.spend))} ${col(T.grey, snap.spend ? (snap.estimated ? "(estimated from tier prices)" : "(reported by opencode)") : "(free-tier models report $0 — set tiers.<t>.inputPerM/outputPerM in .foreman/foreman.json to estimate)")}   ${col(T.g3, "tokens")} ${fmtTokens(snap.tokensAll)}   ${col(T.g3, "runs")} ${snap.allRuns.length}   ${col(T.g3, "verified")} ${snap.tickets.filter((t) => t.status === "verified").length}/${snap.tickets.length}`,
    "",
    ...table("BY TIER", fold((r) => r.tier ?? "standard"), (k) => TIER_COLOR[k] ?? T.grey),
    ...table("BY AGENT", fold((r) => r.agent ?? "worker"), () => T.g1),
    ...table("BY MODEL", fold((r) => r.model ?? "(default)"), () => T.grey),
    ...table("BY TICKET", fold((r) => r.id), () => T.g2),
  ];
  void maxUsd;
  return box(`COST  spend and stall rate by tier · agent · model · ticket`, lines, width, height, T.amber);
}

// ---------- app ------------------------------------------------------------------

export async function startUi(ws, args) {
  const once = Boolean(args.once);
  const out = process.stdout;
  let cols = out.columns || 120;
  let rows = out.rows || 40;
  let frame = 0;
  let view = args.view ?? "stream"; // stream | org | tasks | cost
  let selected = 0;
  let selectedAgent = null;
  let mode = "stream"; // right panel in stream view: stream | activity | report | detail
  let agentDetail = false;
  let scroll = 0;
  let prompt = null;
  let flash = "";
  let flashUntil = 0;
  let gitHead = "";
  let queueRunning = false;
  let workRunning = false;
  let stopped = false;
  const changed = new Map();
  let prevStatus = new Map();
  {
    const first = snapshot(ws);
    const latest = first.running[0] ?? first.tickets.filter((t) => t.last).sort((a, b) => Date.parse(b.last.startedAt) - Date.parse(a.last.startedAt))[0];
    if (latest) selected = Math.max(0, first.tickets.findIndex((t) => t.id === latest.id));
    selectedAgent = first.agents.find((a) => a.name === "lead")?.name ?? first.agents[0]?.name ?? null;
  }
  const say = (msg, ms = 4000) => {
    flash = msg;
    flashUntil = Date.now() + ms;
  };
  const launch = (argv, label) => {
    const fd = openSync(join(ws.dir, "ui-launch.log"), "a");
    const child = spawn(process.execPath, [CLI_PATH, ...argv], { cwd: ws.root, detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
    ws.activity("manager", `${label} (from dashboard)`);
    say(`launched: foreman ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a.slice(0, 40)) : a)).join(" ")}`);
  };
  const refreshExternal = async () => {
    const { out: head } = await runShell("git log --oneline -1 2>/dev/null | cut -c1-60", ws.root);
    gitHead = head.trim();
    const { out: ps } = await runShell("pgrep -f '[f]oreman.mjs queue' >/dev/null 2>&1 && echo q; pgrep -f '[f]oreman.mjs work' >/dev/null 2>&1 && echo w", ws.root);
    queueRunning = ps.includes("q");
    workRunning = ps.includes("w");
  };

  const render = () => {
    const snap = snapshot(ws);
    for (const t of snap.tickets) {
      const prev = prevStatus.get(t.id);
      if (prev && prev !== t.status) {
        changed.set(t.id, Date.now());
        say(`${t.id}: ${prev} → ${t.status}`, 6000);
      }
    }
    prevStatus = new Map(snap.tickets.map((t) => [t.id, t.status]));
    if (selected >= snap.tickets.length) selected = Math.max(0, snap.tickets.length - 1);
    const sel = snap.tickets[selected] ?? null;
    const streamTicket = snap.running[0] ?? sel;
    snap.streamTicket = streamTicket?.id ?? null;
    snap.streamRun = streamTicket?.last ?? null;
    const entries = parseLog(streamTicket ? ws.latestLog(streamTicket.id) : null);
    const ctx = { ws, gitHead, queueRunning, workRunning };
    const width = cols;
    const lines = [];
    const clock = new Date().toTimeString().slice(0, 8);
    const live = snap.running.length ? col(T.amber + T.bold, `${SPINNER[frame % SPINNER.length]} LIVE ×${snap.running.length}`) : col(T.ghost, "· IDLE");
    const tabs = ["stream", "org", "tasks", "cost"].map((v, i) => (v === view ? `${T.inv}${T.g1} ${i + 1} ${v.toUpperCase()} ${T.reset}` : col(T.g3, ` ${i + 1} ${v} `))).join("");
    lines.push(fit(`${T.inv}${T.g1}${T.bold} ▌FOREMAN▐ ${T.reset} ${col(T.g1 + T.bold, String(snap.cfg.project ?? "").toUpperCase())}  ${live}  ${tabs}  ${col(T.amber, usd(snap.spend))}${col(T.grey, " spend")}  ${col(T.grey, `${snap.agents.length} agents`)}  ${col(T.g2, clock)}`, width));
    lines.push(...nowPanel(snap, frame, width, ctx));
    const bottomStart = () => lines.length;
    if (view === "org") {
      const h = rows - lines.length - 2;
      if (agentDetail) lines.push(...agentPanel(ws, snap, snap.agents.find((a) => a.name === selectedAgent), scroll, width, h));
      else {
        const orgH = Math.min(snap.agents.length + 5, Math.max(8, Math.floor(h * 0.45)));
        lines.push(...orgPanel(ws, snap, selectedAgent, frame, width, orgH));
        lines.push(...agentPanel(ws, snap, snap.agents.find((a) => a.name === selectedAgent), scroll, width, h - orgH));
      }
    } else if (view === "tasks") {
      const h = rows - lines.length - 2;
      if (mode === "detail") lines.push(...streamPanel(snap, entries, "detail", sel, 0, width, h, ws));
      else lines.push(...tasksPanel(snap, selected, width, h));
    } else if (view === "cost") {
      lines.push(...costPanel(snap, width, rows - lines.length - 2));
    } else {
      lines.push(...agentsPanel(snap, entries, frame, width, ctx));
      const g = drawGraph(snap.tickets, sel?.id, frame, width - 4);
      const graphH = Math.min(g.lines.length + 2, Math.max(5, Math.floor(rows * 0.22)));
      lines.push(...box("PIPELINE  columns = depth · edges = depends_on · cyan = selected chain", g.lines, width, graphH));
      const bottomH = Math.max(6, rows - lines.length - 2);
      if (mode === "detail") lines.push(...streamPanel(snap, entries, mode, sel, 0, width, bottomH, ws));
      else {
        const leftW = Math.min(66, Math.floor(width * 0.44));
        const left = ticketsPanel(snap, selected, leftW, bottomH, changed);
        const right = streamPanel(snap, entries, mode, sel, scroll, width - leftW - 1, bottomH, ws);
        for (let i = 0; i < bottomH; i++) lines.push(left[i] + " " + right[i]);
      }
    }
    void bottomStart;
    const k = (a, b) => `${col(T.g1 + T.bold, a)}${col(T.g3, ":" + b)}`;
    const keys =
      view === "org"
        ? `${k("↑↓", "agent")}  ${k("p", "prompt agent")}  ${k("enter", "detail")}  ${k("1-4", "views")}  ${k("w", "work daemon")}  ${k("Q", "quit")}`
        : `${k("r", "run")}  ${k("c", "continue+msg")}  ${k("v", "gate")}  ${k("a", "accept")}  ${k("w", "work")}  ${k("q", "queue")}  ${k("p", "ask lead")}  ${k("tab", "stream/activity/report")}  ${k("enter", "detail")}  ${k("1-4", "views")}  ${k("Q", "quit")}`;
    lines.push(fit(Date.now() < flashUntil ? col(T.amber + T.bold, `▶ ${flash}`) : keys, width));
    if (prompt) lines.push(fit(`${col(T.g1 + T.bold, "> " + prompt.label)} ${col(T.white, prompt.value)}${T.inv} ${T.reset}   ${col(T.grey, "enter=send · esc=cancel")}`, width));
    else lines.push(fit(col(T.ghost, `> .foreman/state.json · runs/<id>/ · agents/<name>/ · events.jsonl · agents keep running after Q`), width));
    return lines.slice(0, rows);
  };
  const paint = () => out.write(`${ESC}H` + render().join("\n") + `${ESC}J`);

  if (once) {
    await refreshExternal();
    out.write(render().join("\n") + "\n");
    return;
  }
  out.write(`${ESC}?1049h${ESC}?25l`);
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const restore = () => {
    if (stopped) return;
    stopped = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    out.write(`${ESC}?25h${ESC}?1049l`);
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(0);
  });
  out.on("resize", () => {
    cols = out.columns || cols;
    rows = out.rows || rows;
    paint();
  });
  if (args.queue) launch(["queue"], "started queue");
  if (args.work) launch(["work", "--watch"], "started work daemon");

  process.stdin.on("keypress", (str, key) => {
    if (prompt) {
      if (key.name === "escape") prompt = null;
      else if (key.name === "return") {
        const p = prompt;
        prompt = null;
        p.onSubmit(p.value.trim());
      } else if (key.name === "backspace") prompt.value = prompt.value.slice(0, -1);
      else if (str && !key.ctrl && !key.meta) prompt.value += str;
      paint();
      return;
    }
    if ((key.ctrl && key.name === "c") || str === "Q") {
      restore();
      process.exit(0);
    }
    const snap = snapshot(ws);
    const t = snap.tickets[selected] ?? null;
    const agentNames = snap.agents.map((a) => a.name);
    const ai = Math.max(0, agentNames.indexOf(selectedAgent));
    const askAgent = (name) => {
      prompt = { label: `ask ${name}:`, value: "", onSubmit: (v) => v && launch(["ask", name, v], `asked ${name}`) };
    };
    switch (key.name ?? str) {
      case "1": view = "stream"; scroll = 0; break;
      case "2": view = "org"; scroll = 0; break;
      case "3": view = "tasks"; scroll = 0; break;
      case "4": view = "cost"; scroll = 0; break;
      case "up":
        if (view === "org") selectedAgent = agentNames[Math.max(0, ai - 1)] ?? selectedAgent;
        else selected = Math.max(0, selected - 1);
        scroll = 0;
        break;
      case "down":
        if (view === "org") selectedAgent = agentNames[Math.min(agentNames.length - 1, ai + 1)] ?? selectedAgent;
        else selected = selected + 1;
        scroll = 0;
        break;
      case "tab": mode = mode === "stream" ? "activity" : mode === "activity" ? "report" : "stream"; scroll = 0; break;
      case "return":
        if (view === "org") agentDetail = !agentDetail;
        else mode = mode === "detail" ? "stream" : "detail";
        break;
      case "escape": agentDetail = false; if (mode === "detail") mode = "stream"; scroll = 0; break;
      case "pageup": scroll += 10; break;
      case "pagedown": scroll = Math.max(0, scroll - 10); break;
      case "end": scroll = 0; break;
      case "p": if (view === "org" && selectedAgent && selectedAgent !== "director") askAgent(selectedAgent); else askAgent(snap.cfg.routing.review ?? "lead"); break;
      case "r": if (t) launch(["run", t.id, "--verify", "--auto-report"], `dispatched ${t.id}`); break;
      case "v": if (t) launch(["verify", t.id], `gate ${t.id}`); break;
      case "w": launch(["work", "--watch"], "started work daemon"); break;
      case "q": launch(["queue"], "started queue"); break;
      case "a": if (t) prompt = { label: `accept ${t.id} — note:`, value: "", onSubmit: (v) => v && launch(["accept", t.id, "--note", v], `accepted ${t.id}`) }; break;
      case "c": if (t) prompt = { label: `feedback → ${t.id} (same session if under cap):`, value: "", onSubmit: (v) => v && launch(["run", t.id, "--continue", "--verify", "--auto-report", "--message", v], `sent feedback to ${t.id}`) }; break;
      case "?": say("1-4 views · ↑↓ select · enter detail · p prompt agent · r run · c continue · v gate · a accept · w work · q queue · tab panels · Q quit", 10000); break;
      default: return;
    }
    paint();
  });

  let watchTimer = null;
  const onChange = () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      paint();
    }, 60);
  };
  try {
    watch(ws.dir, { recursive: true }, onChange);
  } catch {
    try {
      watch(ws.dir, onChange);
      watch(ws.runsDir, onChange);
    } catch {}
  }
  await refreshExternal();
  paint();
  const tick = setInterval(() => {
    frame++;
    paint();
  }, 120);
  const slow = setInterval(refreshExternal, 4000);
  await new Promise(() => {});
  clearInterval(tick);
  clearInterval(slow);
}
