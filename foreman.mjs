#!/usr/bin/env node
/**
 * Foreman — a multi-model orchestration engine for AI coding agents.
 *
 * A DIRECTOR (you, or a Claude session) writes tickets. A roster of AGENTS — leads on the
 * premium tier, coders/testers on the standard tier, drones/librarians on the economy tier
 * — executes them through opencode, each under a hard budget and a context cap. Foreman is
 * the engine around them:
 *
 *   - routes every task to an agent and a model by kind and tier (health-aware),
 *   - launches the worker with protocol + persona + ticket (+ a checkpoint brief when a
 *     previous session already worked on it), streams its JSON events to disk,
 *   - enforces budgets (steps, output tokens, context, USD, minutes) from the stream,
 *   - keeps per-agent sessions and refuses to continue one past its tier's context cap,
 *   - runs the ticket's gates itself (the worker's claims are never trusted),
 *   - schedules ready tasks with concurrency limits and an escalation ladder (`work`),
 *   - records every hand-off in an event log the dashboard (`foreman ui`) renders.
 *
 * Zero dependencies. Node >= 22.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, createWriteStream, unlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLI_PATH,
  TEMPLATES,
  Workspace,
  checkpointBrief,
  clip,
  depsOf,
  die,
  digestEvent,
  fmtDuration,
  fmtTokens,
  gateTail,
  nowIso,
  parseArgs,
  resolveModel,
  route,
  runCost,
  runShell,
} from "./lib.mjs";

// ---------- init / tickets -----------------------------------------------------------

function cmdInit(args) {
  const root = args._[1] ?? process.cwd();
  const name = args.name ?? resolve(root).split("/").pop();
  const ws = new Workspace(root);
  ws.init(name);
  const synced = ws.syncOpencodeAgents(ws.models());
  ws.activity("manager", `initialised workspace "${name}" with ${synced.length} agents`);
  process.stdout.write(`initialised ${ws.dir} for project "${name}"\nagents: ${synced.map((s) => `${s.name}→${s.model ?? "?"}`).join(", ")}\n`);
}

function cmdTicket(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace (run `foreman init`)");
  const slug = args._[1] ?? die('usage: foreman ticket <slug> --title "..." [--kind implement] [--parent T001]');
  const existing = ws.tickets();
  const parent = args.parent ?? null;
  const id = parent ? `${parent}.${existing.filter((t) => String(t.meta.parent ?? "") === parent).length + 1}` : `T${String(existing.filter((t) => !t.meta.parent).length + 1).padStart(3, "0")}`;
  const file = join(ws.ticketsDir, `${id}-${slug}.md`);
  let tpl = readFileSync(join(TEMPLATES, "ticket.md"), "utf8")
    .replaceAll("{{id}}", id)
    .replaceAll("{{title}}", args.title ?? slug)
    .replaceAll("{{date}}", nowIso().slice(0, 10));
  if (args.kind || parent) tpl = tpl.replace(/^status: queued$/m, `status: queued\nkind: ${args.kind ?? "implement"}${parent ? `\nparent: ${parent}` : ""}`);
  writeFileSync(file, tpl);
  ws.activity("manager", `wrote ticket ${id} — ${args.title ?? slug}`, { ticket: id });
  ws.setManager("writing", `ticket ${id}`);
  process.stdout.write(`${file}\n`);
}

// ---------- agents & models ------------------------------------------------------------

function cmdAgents(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const sub = args._[1];
  if (sub === "sync" || args.sync) {
    const w = ws.syncOpencodeAgents(ws.models());
    process.stdout.write(w.map((x) => `${x.changed ? "wrote " : "ok    "} ${x.path}  model=${x.model ?? "(default)"}`).join("\n") + "\n");
    return;
  }
  if (sub === "install") {
    const added = ws.installDefaultAgents();
    process.stdout.write(added.length ? `installed: ${added.join(", ")}\n` : "all default agents already present\n");
    return;
  }
  const cfg = ws.config();
  const models = ws.models();
  const rows = ws.agents().map((a) => {
    const model = a.name === "director" ? "(you)" : resolveModel(cfg, a, models) ?? "(default)";
    return [a.name.padEnd(10), a.role.padEnd(10), a.tier.padEnd(9), model.padEnd(44), (a.supervisor ?? "—").padEnd(9), (a.state.phase ?? "idle").padEnd(9), (a.state.task ?? "").padEnd(8), `$${(a.state.spend ?? 0).toFixed(2)}`, `${fmtTokens(a.state.tokens)}`, a.kinds.join(",")];
  });
  process.stdout.write(["AGENT      ROLE       TIER      MODEL                                        SUPERVISOR PHASE     TASK     SPEND  TOKENS KINDS", ...rows.map((r) => r.join(" "))].join("\n") + "\n");
}

async function probeModel(model, cwd, timeoutMs = 60_000) {
  const started = Date.now();
  const argv = ["run", "--format", "json", "--pure", "--dir", cwd, "--model", model, "Reply with exactly the word PONG and nothing else. Do not use tools."];
  return new Promise((resolveDone) => {
    const child = spawn("opencode", argv, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("close", () => {
      clearTimeout(t);
      const ms = Date.now() - started;
      const errLine = out.split("\n").find((l) => l.includes('"type":"error"'));
      if (errLine) {
        const m = errLine.match(/"message":"([^"]{0,140})/);
        return resolveDone({ status: "dead", ms, error: m?.[1] ?? "error" });
      }
      if (/PONG/i.test(out)) return resolveDone({ status: "ok", ms });
      resolveDone({ status: ms >= timeoutMs ? "timeout" : "odd", ms, error: (err || out).slice(-160).replace(/\s+/g, " ") });
    });
  });
}

async function cmdModels(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const cfg = ws.config();
  const known = ws.models();
  const candidates = new Set();
  for (const t of Object.values(cfg.tiers)) [t.model, ...(t.fallbacks ?? [])].forEach((m) => m && candidates.add(m));
  for (const a of ws.agents()) if (a.meta.model) candidates.add(a.meta.model);
  if (args._[1]) candidates.add(args._[1]);
  if (args.probe) {
    known.models ??= {};
    for (const m of candidates) {
      process.stdout.write(`probing ${m} … `);
      const r = await probeModel(m, ws.root, Number(args.timeout ?? 60) * 1000);
      known.models[m] = { ...r, at: nowIso() };
      process.stdout.write(`${r.status} ${r.ms}ms${r.error ? " — " + r.error : ""}\n`);
    }
    known.probedAt = nowIso();
    ws.saveModels(known);
    const w = ws.syncOpencodeAgents(known);
    ws.event("models.probed", { models: known.models });
    process.stdout.write(`saved ${ws.modelsPath}; agents re-synced (${w.filter((x) => x.changed).length} changed)\n`);
  }
  process.stdout.write("\nTIER      MODEL                                          HEALTH     LATENCY  CTX CAP  OUT/RUN  $/M in/out\n");
  for (const [name, t] of Object.entries(cfg.tiers)) {
    for (const [i, m] of [t.model, ...(t.fallbacks ?? [])].entries()) {
      const h = known.models?.[m];
      process.stdout.write(`${(i === 0 ? name : "  ↳ fallback").padEnd(9)} ${m.padEnd(46)} ${(h?.status ?? "unknown").padEnd(10)} ${(h ? `${h.ms}ms` : "").padStart(7)}  ${String(t.ctxCap ?? "").padStart(7)}  ${String(t.maxOutPerRun ?? "").padStart(7)}  ${t.inputPerM ?? 0}/${t.outputPerM ?? 0}\n`);
    }
  }
}

// ---------- message composition ------------------------------------------------------

function composeMessage(ws, ticket, { feedback = "", isContinue = false, brief = "", purpose = "work", agent = null }) {
  const cfg = ws.config();
  const parts = [];
  if (purpose === "report") {
    parts.push(
      `# REPORT-ONLY TASK for ${ticket.id}\n\nThe implementation work for this ticket was done by another agent. Do NOT write or change code.\nYour only job: read the ticket, the run log digest at ${ws.latestLog(ticket.id) ?? "(none)"}, and the files it names, then write ${join(ws.runsDir, ticket.id, "REPORT.md")} in the protocol shape below. Claim only what the log and the files prove. Write the report as your FIRST write action, then stop.\n\n## Report shape\n# REPORT ${ticket.id}\n## Done\n## Not done\n## Verify\n## Decisions\n## Questions for the manager\n## Files touched\n\n# TICKET\n` + ticket.text.trim(),
    );
    if (brief) parts.push(brief);
    return parts.join("\n\n");
  }
  if (!isContinue) {
    parts.push("# PROTOCOL (binding)\n\n" + ws.protocol().trim());
    if (agent?.body && !existsSync(join(ws.root, ".opencode", "agent", `${agent.name}.md`))) parts.push(`# YOUR ROLE: ${agent.name}\n\n${agent.body.trim()}`);
    parts.push(`# TICKET ${ticket.id}\n\nTicket file: ${ticket.file}\nProject root: ${ws.root}\nReport file you MUST write: ${join(ws.runsDir, ticket.id, "REPORT.md")}\n\n` + ticket.text.trim());
    if (brief) parts.push(brief);
  } else {
    parts.push(`# MANAGER FEEDBACK on ticket ${ticket.id} (same session — you keep your context)\n\nTicket file: ${ticket.file}\nReport file you MUST rewrite: ${join(ws.runsDir, ticket.id, "REPORT.md")}\n`);
  }
  if (feedback) parts.push("# FEEDBACK\n\n" + feedback.trim());
  const verify = [...(ticket.meta.verify ?? []), ...(cfg.verify ?? [])];
  if (verify.length) parts.push("# VERIFY COMMANDS (run these yourself before reporting; the manager runs them again)\n\n" + verify.map((v) => "    " + v).join("\n"));
  return parts.join("\n\n");
}

// ---------- the run loop (shared by run, ask, report-gen) ----------------------------

/**
 * Launch opencode with `message`, stream events to jsonl + digest, enforce budget and
 * watchdogs, return the run record. `hooks` lets callers react to milestones.
 */
async function executeRun({ ws, cmdName, argv, message, jsonlPath, logPath, reportPath, budget, timeoutMin, idleMin, hooks = {} }) {
  const jsonl = createWriteStream(jsonlPath);
  const log = createWriteStream(logPath);
  const run = hooks.run;
  const child = spawn(cmdName, [...argv, message], { cwd: ws.root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  run.pid = child.pid ?? null;
  const started = Date.now();
  let killedFor = null;
  const terminate = (why) => {
    if (killedFor) return;
    killedFor = why;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  const timer = setTimeout(() => terminate("timeout"), Math.min(timeoutMin, budget.minutes) * 60_000);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const note = `[foreman] no events for ${idleMin}m; report ${existsSync(reportPath) ? "present → treating as finished" : "MISSING → stalled"}`;
      log.write(note + "\n");
      process.stdout.write(note + "\n");
      terminate("idle");
    }, idleMin * 60_000);
  };
  armIdle();
  const say = (s) => {
    log.write(s + "\n");
    process.stdout.write(s + "\n");
  };
  let buf = "";
  let dirty = null;
  const persist = () => hooks.persist?.();
  const markDirty = () => {
    if (dirty) return;
    dirty = setTimeout(() => {
      dirty = null;
      persist();
    }, 2000);
  };
  let first = true;
  const onLine = (line) => {
    if (!line.trim()) return;
    jsonl.write(line + "\n");
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      say(`[raw] ${line.slice(0, 300)}`);
      return;
    }
    armIdle();
    run.lastEventAt = nowIso();
    if (ev.sessionID && !run.sessionID) run.sessionID = ev.sessionID;
    if (first) {
      first = false;
      hooks.onFirst?.(run);
    }
    if (ev.type === "text" && ev.part?.text) run.lastText = ev.part.text.trim();
    if (ev.type === "tool_use") {
      run.tools++;
      const fp = ev.part?.state?.input?.filePath ?? "";
      if (!run.reportSeen && /write|edit/.test(ev.part?.tool ?? "") && fp.endsWith("REPORT.md")) {
        run.reportSeen = true;
        hooks.onReport?.(run);
      }
    }
    if (ev.type === "step_finish") {
      run.steps++;
      const tk = ev.part?.tokens ?? {};
      run.tokens.total = Math.max(run.tokens.total, tk.total ?? 0);
      run.tokens.input += tk.input ?? 0;
      run.tokens.output += tk.output ?? 0;
      run.tokens.reasoning += tk.reasoning ?? 0;
      run.cost += ev.part?.cost ?? 0;
      // Budget enforcement — the engine, not the model, decides when enough is enough.
      const usd = runCost(run, hooks.tierSpec);
      const over =
        run.steps > budget.steps ? `steps ${run.steps} > ${budget.steps}`
        : run.tokens.output > budget.outTokens ? `output tokens ${run.tokens.output} > ${budget.outTokens}`
        : run.tokens.total > budget.ctxKill ? `context ${run.tokens.total} > hard ceiling ${budget.ctxKill}`
        : usd > budget.usd ? `usd ${usd.toFixed(4)} > ${budget.usd}`
        : null;
      if (over) {
        say(`[foreman] OVER BUDGET: ${over} — terminating`);
        run.overBudget = over;
        terminate("budget");
      } else if (run.tokens.total > budget.ctxTokens && !run.ctxWarned) {
        // Past the continuation cap: the run may finish, but this session will not be resumed.
        run.ctxWarned = true;
        say(`[foreman] context ${run.tokens.total} passed the ${budget.ctxTokens} continuation cap — this session will not be resumed; hard ceiling ${budget.ctxKill}`);
      }
    }
    if (ev.type === "error") {
      const data = ev.error?.data ?? {};
      run.apiError = { statusCode: data.statusCode ?? null, message: String(data.message ?? ev.error?.name ?? "error").slice(0, 200) };
      hooks.onError?.(run, ev);
    }
    const d = digestEvent(ev);
    if (d) say(`${fmtDuration(Date.now() - started).padStart(7)} ${d}`);
    markDirty();
  };
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on("data", (chunk) => log.write(chunk.toString().split("\n").filter(Boolean).map((l) => `[stderr] ${l}`).join("\n") + "\n"));
  await new Promise((done) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (dirty) clearTimeout(dirty);
      if (buf.trim()) onLine(buf);
      run.exit = code;
      run.endedAt = nowIso();
      run.report = existsSync(reportPath);
      if (killedFor === "timeout") run.status = "timeout";
      else if (killedFor === "budget") run.status = "over-budget";
      else if (killedFor === "idle") run.status = run.report ? "finished" : "stalled";
      else run.status = code === 0 ? "finished" : "failed";
      run.idleExit = killedFor === "idle";
      run.usd = runCost(run, hooks.tierSpec);
      const summary = `\n# run ${run.ticket ?? ""} #${run.n} ${run.status} exit=${code} in ${fmtDuration(Date.now() - started)} steps=${run.steps} tools=${run.tools} tokens=${run.tokens.total} (in ${run.tokens.input} / out ${run.tokens.output} / reasoning ${run.tokens.reasoning}) usd=${run.usd.toFixed(4)} model=${run.model} agent=${run.agent ?? "-"} session=${run.sessionID ?? "?"} report=${run.report ? "yes" : "MISSING"}\n`;
      say(summary);
      jsonl.end();
      log.end();
      done();
    });
  });
  return run;
}

// ---------- run ----------------------------------------------------------------------

async function cmdRun(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace (run `foreman init`)");
  const idArg = args._[1] ?? die('usage: foreman run <ticket-id> [--message "..."] [--continue|--fresh] [--agent a] [--tier t] [--model p/m] [--purpose work|report] [--timeout min] [--idle min] [--verify] [--auto-report]');
  const ticket = ws.ticket(idArg);
  const cfg = ws.config();
  const purpose = args.purpose ?? "work";
  const r = route(ws, ticket, { agent: args.agent ?? (purpose === "report" ? cfg.routing.report : undefined), model: args.model, tier: args.tier });
  const state0 = ws.state();
  const ts0 = state0.tickets[ticket.id] ?? { status: "queued", runs: [] };
  const last = ts0.runs.at(-1);
  const lastCtx = last?.tokens?.total ?? 0;

  // Session policy: continue only if asked, a session exists, and it is under the cap.
  let isContinue = false;
  let sessionNote = "";
  if (args.continue && last?.sessionID) {
    if (lastCtx <= r.budget.ctxTokens) isContinue = true;
    else sessionNote = `refusing --continue: previous session context ${lastCtx} exceeds the ${r.tier} cap ${r.budget.ctxTokens}; starting fresh from a checkpoint brief`;
  } else if (args.continue) sessionNote = "no prior session to continue; starting fresh";
  if (sessionNote) process.stderr.write(`foreman: ${sessionNote}\n`);

  const feedback = args.message ?? (args["message-file"] ? readFileSync(args["message-file"], "utf8") : "");
  const brief = !isContinue && ts0.runs.length > 0 && purpose === "work" ? await checkpointBrief(ws, ticket, { feedback: "" }) : "";
  const message = composeMessage(ws, ticket, { feedback, isContinue, brief, purpose, agent: r.agent });

  const n = ts0.runs.length + 1;
  const runDir = ws.runDir(ticket.id);
  // A report from a previous run must never count as this run's report (the idle watchdog
  // treats "report present" as finished). Archive it; the brief already carried its content.
  if (purpose === "work" && !isContinue && existsSync(join(runDir, "REPORT.md"))) {
    renameSync(join(runDir, "REPORT.md"), join(runDir, `REPORT.run-${n - 1}.md`));
  }
  const jsonlPath = join(runDir, `run-${n}.jsonl`);
  const logPath = join(runDir, `run-${n}.log`);
  writeFileSync(join(runDir, `run-${n}.message.md`), message);
  const reportPath = join(runDir, "REPORT.md");

  const worker = cfg.worker ?? {};
  const timeoutMin = Number(args.timeout ?? ticket.meta.timeout ?? worker.timeoutMinutes ?? 60);
  const idleMin = Number(args.idle ?? ticket.meta.idle ?? worker.idleMinutes ?? 5);
  const cmdName = worker.command ?? "opencode";
  const argv = ["run", "--format", "json", "--dir", ws.root, "--title", `${cfg.project ?? "foreman"}:${ticket.id}`];
  if (r.model) argv.push("--model", r.model);
  const variant = args.variant ?? ticket.meta.variant ?? worker.variant;
  if (variant) argv.push("--variant", variant);
  if (r.agent?.file && existsSync(join(ws.root, ".opencode", "agent", `${r.agent.name}.md`))) argv.push("--agent", r.agent.name);
  if (isContinue) argv.push("--session", last.sessionID);
  if (args.auto) argv.push("--auto");

  const run = {
    n, ticket: ticket.id, purpose, startedAt: nowIso(), endedAt: null, exit: null, status: "running", pid: null,
    sessionID: isContinue ? last.sessionID : null, continued: isContinue, feedback: feedback ? feedback.slice(0, 400) : "",
    agent: r.agent?.name ?? null, tier: r.tier, model: r.model ?? "(default)", route: r.reason, budget: r.budget,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0 }, cost: 0, usd: 0, steps: 0, tools: 0, lastText: "", lastEventAt: nowIso(),
    jsonl: jsonlPath, log: logPath, report: false, brief: brief.length,
  };
  const persist = () =>
    ws.updateState((s) => {
      const ts = (s.tickets[ticket.id] ??= { status: "queued", runs: [] });
      ts.runs[n - 1] = run;
      ts.status = run.status === "running" ? "running" : run.status === "finished" ? "needs-review" : run.status;
    });
  persist();
  if (r.agent?.name) ws.updateAgentState(r.agent.name, (s) => Object.assign(s, { phase: "running", task: ticket.id, lastActive: nowIso() }));
  const header = `# foreman run ${ticket.id} #${n} — ${run.startedAt}\n# agent=${run.agent ?? "-"} tier=${r.tier} model=${run.model} route="${r.reason}" budget=${JSON.stringify(r.budget)} purpose=${purpose}${isContinue ? " session=continued" : brief ? ` brief=${brief.length}ch` : ""}\n# ${cmdName} ${argv.join(" ")} <message ${message.length} chars>\n\n`;
  process.stdout.write(header);
  writeFileSync(logPath, header);
  ws.setManager(isContinue ? "coaching" : "dispatching", `${ticket.id} → ${run.agent ?? "worker"} (${r.tier})`);
  ws.activity("manager", `${isContinue ? "sent feedback into" : "dispatched"} ${ticket.id} → ${run.agent ?? "worker"} on ${r.tier}/${(run.model ?? "").split("/").pop()} (run #${n}${purpose === "report" ? ", report only" : ""})`, { ticket: ticket.id, agent: run.agent });
  ws.event("run.start", { ticket: ticket.id, n, agent: run.agent, tier: r.tier, model: run.model, budget: r.budget, continued: isContinue, brief: brief.length });

  await executeRun({
    ws, cmdName, argv, message, jsonlPath, logPath, reportPath, budget: r.budget, timeoutMin, idleMin,
    hooks: {
      run,
      tierSpec: r.tierSpec,
      persist,
      onFirst: (rn) => ws.activity("worker", `${rn.agent ?? "worker"} started ${ticket.id} (session ${String(rn.sessionID ?? "?").slice(0, 12)}…)`, { ticket: ticket.id, agent: rn.agent }),
      onReport: () => ws.activity("worker", `${run.agent ?? "worker"} wrote REPORT.md for ${ticket.id}`, { ticket: ticket.id, agent: run.agent }),
      onError: (rn, ev) => ws.activity("worker", `error on ${ticket.id}: ${JSON.stringify(ev.error ?? {}).slice(0, 120)}`, { ticket: ticket.id, level: "error" }),
    },
  });
  // Append a log line to the file (executeRun wrote via stream after the header we pre-wrote).
  persist();
  if (r.agent?.name) {
    ws.updateAgentState(r.agent.name, (s) => {
      s.phase = "idle";
      s.task = null;
      s.runs = (s.runs ?? 0) + 1;
      s.spend = (s.spend ?? 0) + run.usd;
      s.tokens = (s.tokens ?? 0) + run.tokens.input + run.tokens.output;
      s.lastActive = nowIso();
      s.lastRun = { ticket: ticket.id, n, status: run.status };
      if (run.sessionID) {
        const existing = s.sessions.find((x) => x.id === run.sessionID);
        const rec = { id: run.sessionID, ctxTokens: run.tokens.total, spend: run.usd, lastActive: nowIso(), task: ticket.id, model: run.model };
        if (existing) Object.assign(existing, rec);
        else s.sessions.push(rec);
        if (s.sessions.length > 20) s.sessions.splice(0, s.sessions.length - 20);
      }
      if (run.status === "stalled" || run.status === "timeout") s.stalls = (s.stalls ?? 0) + 1;
    });
  }
  ws.event("run.end", { ticket: ticket.id, n, agent: run.agent, tier: r.tier, model: run.model, status: run.status, steps: run.steps, tools: run.tools, tokens: run.tokens, usd: run.usd, report: run.report, overBudget: run.overBudget ?? null });
  ws.activity("worker", `${run.status} ${ticket.id} run #${n} in ${fmtDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))} — ${run.steps} steps, ${run.tools} tools, ${fmtTokens(run.tokens.total)} ctx, $${run.usd.toFixed(4)}, report ${run.report ? "written" : "missing"}${run.overBudget ? ` (OVER BUDGET: ${run.overBudget})` : ""}`, {
    ticket: ticket.id, agent: run.agent, level: run.status === "finished" ? "ok" : "warn",
  });
  ws.setManager("reviewing", `${ticket.id} run #${n} (${run.status})`);

  // A model that errors before its first step is unhealthy right now: record it so the
  // router skips it, and re-dispatch on the tier's next fallback as a new run.
  if (run.steps === 0 && run.apiError && !args.model && Number(args["reroute-depth"] ?? 0) < 2) {
    const m = ws.models();
    m.models ??= {};
    m.models[run.model] = { status: "dead", ms: 0, error: `${run.apiError.statusCode ?? ""} ${run.apiError.message}`.trim(), at: nowIso(), source: "run" };
    ws.saveModels(m);
    ws.syncOpencodeAgents(m);
    ws.event("model.demoted", { model: run.model, error: m.models[run.model].error, ticket: ticket.id });
    ws.activity("foreman", `${run.model} failed before its first step (${m.models[run.model].error}) — marked unhealthy, re-routing ${ticket.id} to the next fallback`, { ticket: ticket.id, level: "warn" });
    const passthrough = Object.entries(args).filter(([k]) => !["_", "reroute-depth"].includes(k)).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)]));
    const { status } = await spawnForeman(["run", ticket.id, ...passthrough, "--reroute-depth", String(Number(args["reroute-depth"] ?? 0) + 1)], ws.root);
    process.exit(status ?? 2);
  }

  if (args["auto-report"] && !run.report && run.status !== "failed" && purpose === "work") {
    process.stdout.write(`\n# report missing — asking the ${cfg.routing.report} to write it from the log\n`);
    await spawnForeman(["run", ticket.id, "--purpose", "report", "--idle", "4", "--timeout", "12"], ws.root);
  }
  if (args.verify) await cmdVerify({ _: ["verify", ticket.id] });
  process.exit(run.status === "finished" ? 0 : 2);
}

// ---------- ask: talk to any agent -----------------------------------------------------

async function cmdAsk(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const name = args._[1] ?? die('usage: foreman ask <agent> "prompt" [--fresh] [--file path] [--model p/m]');
  const agent = ws.agent(name) ?? die(`no agent "${name}" (foreman agents)`);
  if (agent.name === "director") die("the director is you — talk to a lead instead");
  const prompt = args._.slice(2).join(" ") || (args.file ? "" : die("give the agent a prompt"));
  const cfg = ws.config();
  const models = ws.models();
  const tierSpec = cfg.tiers[agent.tier] ?? cfg.tiers.standard;
  const model = args.model ?? resolveModel(cfg, agent, models);
  const st = ws.agentState(agent.name);
  const live = st.sessions.filter((s) => s.id).sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))[0];
  const reuse = !args.fresh && live && (live.ctxTokens ?? 0) < (tierSpec.ctxCap ?? 60_000) && (!live.model || live.model === model);
  const dir = ws.agentDir(agent.name);
  const n = (st.asks ?? 0) + 1;
  const fileText = args.file ? `\n\n# FILE ${args.file}\n\n${clip(readFileSync(args.file, "utf8"), 12_000)}` : "";
  const roleHint = existsSync(join(ws.root, ".opencode", "agent", `${agent.name}.md`)) ? "" : `# YOUR ROLE: ${agent.name}\n\n${agent.body.trim()}\n\n`;
  const message = `${reuse ? "" : roleHint}# QUESTION FROM THE DIRECTOR\n\nProject root: ${ws.root}\nAnswer directly and concretely. Do not modify files unless the question explicitly asks you to.\n\n${prompt}${fileText}`;
  const argv = ["run", "--format", "json", "--dir", ws.root, "--title", `${cfg.project ?? "foreman"}:ask:${agent.name}`];
  if (model) argv.push("--model", model);
  if (existsSync(join(ws.root, ".opencode", "agent", `${agent.name}.md`))) argv.push("--agent", agent.name);
  if (reuse) argv.push("--session", live.id);
  const run = { n, ticket: null, purpose: "ask", startedAt: nowIso(), status: "running", sessionID: reuse ? live.id : null, continued: Boolean(reuse), agent: agent.name, tier: agent.tier, model: model ?? "(default)", tokens: { total: 0, input: 0, output: 0, reasoning: 0 }, cost: 0, usd: 0, steps: 0, tools: 0, lastText: "", lastEventAt: nowIso() };
  const budget = { steps: Number(args.steps ?? 40), outTokens: tierSpec.maxOutPerRun ?? 8000, ctxTokens: tierSpec.ctxCap ?? 60_000, usd: Number(args.usd ?? Infinity), minutes: Number(args.minutes ?? 15) };
  writeFileSync(join(dir, `ask-${n}.prompt.md`), message);
  ws.updateAgentState(agent.name, (s) => Object.assign(s, { phase: "answering", task: `ask#${n}`, lastActive: nowIso(), asks: n }));
  ws.activity("manager", `asked ${agent.name}: ${clip(prompt, 100)}`, { agent: agent.name });
  ws.event("ask.start", { agent: agent.name, n, model, reuse: Boolean(reuse) });
  process.stdout.write(`# ask ${agent.name} #${n} model=${model} ${reuse ? `session=${live.id} (ctx ${live.ctxTokens})` : "fresh session"}\n`);
  await executeRun({ ws, cmdName: cfg.worker?.command ?? "opencode", argv, message, jsonlPath: join(dir, `ask-${n}.jsonl`), logPath: join(dir, `ask-${n}.log`), reportPath: join(dir, "never"), budget, timeoutMin: 15, idleMin: Number(args.idle ?? 3), hooks: { run, tierSpec } });
  if (run.steps === 0 && run.apiError && !args.model && !args["reroute-depth"]) {
    const m = ws.models();
    m.models ??= {};
    m.models[model] = { status: "dead", ms: 0, error: `${run.apiError.statusCode ?? ""} ${run.apiError.message}`.trim(), at: nowIso(), source: "ask" };
    ws.saveModels(m);
    ws.syncOpencodeAgents(m);
    ws.updateAgentState(agent.name, (s) => Object.assign(s, { phase: "idle", task: null }));
    ws.activity("foreman", `${model} failed before answering (${m.models[model].error}) — marked unhealthy, re-asking ${agent.name} on the next fallback`, { agent: agent.name, level: "warn" });
    process.stdout.write(`\n# ${model} errored (${m.models[model].error}); marked unhealthy, retrying on fallback\n`);
    const { status } = await spawnForeman(["ask", agent.name, prompt, "--reroute-depth", "1", ...(args.fresh ? ["--fresh"] : []), ...(args.file ? ["--file", args.file] : [])], ws.root);
    process.exit(status ?? 2);
  }
  const reply = run.lastText || "(no text reply — see the log)";
  writeFileSync(join(dir, "replies", `${n}.md`), `# ${agent.name} → director (ask #${n}, ${run.endedAt})\n\n**Q:** ${prompt}\n\n${reply}\n`);
  ws.updateAgentState(agent.name, (s) => {
    s.phase = "idle";
    s.task = null;
    s.spend = (s.spend ?? 0) + run.usd;
    s.tokens = (s.tokens ?? 0) + run.tokens.input + run.tokens.output;
    s.lastActive = nowIso();
    if (run.sessionID) {
      const rec = { id: run.sessionID, ctxTokens: run.tokens.total, spend: run.usd, lastActive: nowIso(), task: `ask#${n}`, model };
      const ex = s.sessions.find((x) => x.id === run.sessionID);
      if (ex) Object.assign(ex, rec);
      else s.sessions.push(rec);
    }
    s.lastReply = { n, at: run.endedAt, text: clip(reply, 400) };
  });
  ws.event("ask.end", { agent: agent.name, n, status: run.status, tokens: run.tokens, usd: run.usd });
  ws.activity("worker", `${agent.name} answered ask #${n} (${fmtTokens(run.tokens.total)} ctx, $${run.usd.toFixed(4)})`, { agent: agent.name, level: "ok" });
  process.stdout.write(`\n${reply}\n\n[saved ${join(dir, "replies", `${n}.md`)}]\n`);
}

// ---------- verify / accept / note ----------------------------------------------------

async function cmdVerify(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const ticket = ws.ticket(args._[1] ?? die("usage: foreman verify <ticket-id>"));
  const cfg = ws.config();
  const cmds = [...(ticket.meta.verify ?? []), ...(cfg.verify ?? [])];
  if (!cmds.length) die(`ticket ${ticket.id} has no verify commands`);
  const n = (ws.state().tickets[ticket.id]?.verifies ?? 0) + 1;
  ws.setManager("verifying", `${ticket.id} gate #${n}`);
  ws.activity("foreman", `running gate for ${ticket.id}: ${cmds.length} command(s)`, { ticket: ticket.id });
  const logPath = join(ws.runDir(ticket.id), `verify-${n}.log`);
  const results = [];
  let allOk = true;
  let logText = `# foreman verify ${ticket.id} #${n} — ${nowIso()}\n`;
  for (const c of cmds) {
    process.stdout.write(`$ ${c}\n`);
    const started = Date.now();
    const { code, out } = await runShell(c, ws.root);
    const ok = code === 0;
    allOk &&= ok;
    results.push({ cmd: c, exit: code, ok, ms: Date.now() - started });
    logText += `\n$ ${c}\n(exit ${code}, ${fmtDuration(Date.now() - started)})\n${out}\n`;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} (exit ${code}, ${fmtDuration(Date.now() - started)})\n${ok ? "" : out.split("\n").slice(-40).join("\n") + "\n"}`);
  }
  writeFileSync(logPath, logText);
  ws.updateState((s) => {
    const ts = (s.tickets[ticket.id] ??= { status: "queued", runs: [] });
    ts.verifies = n;
    ts.lastVerify = { n, at: nowIso(), ok: allOk, results, log: logPath };
    if (["needs-review", "verified", "verify-failed"].includes(ts.status)) ts.status = allOk ? "verified" : "verify-failed";
  });
  ws.event("gate", { ticket: ticket.id, n, ok: allOk, results });
  ws.activity("foreman", `gate ${ticket.id}: ${allOk ? "ALL PASS" : "FAILED — " + results.filter((r) => !r.ok).map((r) => r.cmd).join(" ; ").slice(0, 120)}`, { ticket: ticket.id, level: allOk ? "ok" : "error" });
  ws.setManager("reviewing", `${ticket.id} (gate ${allOk ? "passed" : "failed"})`);
  process.stdout.write(`\nverify ${ticket.id}: ${allOk ? "ALL PASS" : "FAILED"} → ${logPath}\n`);
  if (!allOk) process.exitCode = 3;
}

function cmdAccept(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const ticket = ws.ticket(args._[1] ?? die('usage: foreman accept <ticket-id> --note "why"'));
  const ts = ws.state().tickets[ticket.id] ?? die(`${ticket.id} has never run`);
  if (!ts.lastVerify?.ok) die(`${ticket.id}: last verify did not pass — run \`foreman verify ${ticket.id}\` first`);
  const note = args.note ?? die("--note is required: say what you reviewed");
  ws.updateState((s) => {
    const t = s.tickets[ticket.id];
    t.acceptance = { at: nowIso(), by: "manager", note, previousStatus: t.runs.at(-1)?.status ?? null };
    t.status = "verified";
  });
  ws.event("accept", { ticket: ticket.id, note });
  ws.activity("manager", `accepted ${ticket.id}: ${note}`, { ticket: ticket.id, level: "ok" });
  ws.setManager("accepted", ticket.id);
  process.stdout.write(`${ticket.id} accepted by manager: ${note}\n`);
}

function cmdNote(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const text = args._.slice(1).join(" ") || die('usage: foreman note "what you did" [--ticket T001] [--phase reviewing]');
  ws.activity("manager", text, args.ticket ? { ticket: args.ticket } : {});
  if (args.phase) ws.setManager(args.phase, args.ticket ?? "");
  process.stdout.write("noted\n");
}

// ---------- scheduler: queue (sequential) and work (daemon with ladder) -------------------

function spawnForeman(argv, cwd) {
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], { cwd, stdio: "inherit", env: process.env });
    child.on("close", (status) => resolveDone({ status }));
  });
}

async function cmdQueue(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const max = Number(args.max ?? 99);
  let ran = 0;
  ws.activity("manager", `started queue (max ${max})`);
  for (;;) {
    const state = ws.state();
    const all = ws.tickets();
    const statusOf = (tid) => state.tickets[tid]?.status ?? "queued";
    const next = all.find((t) => statusOf(t.id) === "queued" && depsOf(t.meta).every((d) => statusOf(d) === "verified"));
    if (!next) {
      const blocked = all.filter((t) => statusOf(t.id) === "queued");
      const msg = blocked.length ? `${blocked.length} ticket(s) blocked on unverified dependencies: ${blocked.map((t) => t.id).join(", ")}` : "nothing left to run";
      process.stdout.write(`queue: ${msg}\n`);
      ws.activity("foreman", `queue idle — ${msg}`);
      ws.setManager("idle", "queue drained");
      return;
    }
    if (ran >= max) return void process.stdout.write(`queue: reached --max ${max}; next would be ${next.id}\n`);
    process.stdout.write(`\n=== queue: dispatching ${next.id} — ${next.meta.title ?? ""} ===\n`);
    const { status } = await spawnForeman(["run", next.id, "--verify", "--auto-report", ...(args.model ? ["--model", args.model] : [])], ws.root);
    ran++;
    const after = ws.state().tickets[next.id]?.status;
    if (after !== "verified") {
      process.stdout.write(`queue: ${next.id} ended as "${after}" (exit ${status}); stopping for manager review\n`);
      ws.activity("foreman", `queue stopped: ${next.id} ended as ${after} — manager review needed`, { ticket: next.id, level: "warn" });
      process.exitCode = 2;
      return;
    }
  }
}

/**
 * The daemon. Picks ready tasks, respects global and per-agent concurrency, runs gates,
 * and walks the escalation ladder on failure:
 *   attempt 1 fails → same agent, fresh session from a checkpoint brief
 *   attempt 2 fails → review task for the supervisor → FEEDBACK.md → attempt 3 with it
 *   attempt 3 fails → blocked; the daemon stops touching it and the dashboard says why
 */
async function cmdWork(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const cfg = ws.config();
  const lock = join(ws.dir, "work.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) die(`another \`foreman work\` is running (pid ${pid}); stop it or remove ${lock}`);
  }
  writeFileSync(lock, String(process.pid));
  const cleanup = () => {
    try {
      unlinkSync(lock);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const globalCap = Number(args.concurrency ?? cfg.concurrency.global ?? 2);
  const maxRuns = Number(args.max ?? 999);
  const watch = Boolean(args.watch);
  const running = new Map(); // ticket id → { agent, promise }
  let ran = 0;
  ws.activity("manager", `started work daemon (concurrency ${globalCap}${watch ? ", watch" : ""})`);
  ws.setManager("scheduling", "work daemon");
  const agents = ws.agents();
  const agentCap = (name) => Number(agents.find((a) => a.name === name)?.meta?.concurrency ?? 1);
  const inFlightFor = (name) => [...running.values()].filter((r) => r.agent === name).length;

  const finish = async (t, outcome) => {
    const state = ws.state();
    const ts = state.tickets[t.id] ?? { status: "queued", runs: [] };
    const attempts = (ts.attempts ?? 0) + 1;
    ws.updateState((s) => ((s.tickets[t.id] ??= { status: "queued", runs: [] }).attempts = attempts));
    const status = ws.state().tickets[t.id]?.status;
    if (status === "verified") {
      const { out } = await runShell("git status --short | head -80", ws.root);
      writeFileSync(join(ws.runDir(t.id), "COMMIT_BOUNDARY.txt"), `# files in the working tree when ${t.id} verified (${nowIso()})\n${out}`);
      ws.event("task.verified", { ticket: t.id, attempts });
      ws.activity("foreman", `${t.id} verified on attempt ${attempts}; commit boundary recorded`, { ticket: t.id, level: "ok" });
      return;
    }
    ws.event("task.failed", { ticket: t.id, attempts, status });
    const agentName = ts.runs?.at(-1)?.agent ?? null;
    const supervisor = agents.find((a) => a.name === agentName)?.supervisor ?? cfg.routing.review ?? "lead";
    const isReview = t.meta.kind === "review" || /\.review-\d+$/.test(t.id);
    if (isReview) {
      // A review never spawns a review of itself. One fresh retry, then it blocks — and so
      // does the task waiting on it, so the director sees exactly where the ladder stopped.
      if (attempts === 1) {
        ws.updateState((s) => (s.tickets[t.id].status = "queued"));
        ws.activity("foreman", `${t.id} (review) ${status} — one fresh retry`, { ticket: t.id, level: "warn" });
      } else {
        ws.updateState((s) => {
          s.tickets[t.id].status = "blocked";
          if (t.meta.parent && s.tickets[t.meta.parent]) s.tickets[t.meta.parent].status = "blocked";
        });
        ws.event("task.blocked", { ticket: t.id, attempts, parent: t.meta.parent ?? null });
        ws.activity("foreman", `${t.id} (review) BLOCKED after ${attempts} attempts — ${t.meta.parent ?? "its parent"} blocked with it; needs the director`, { ticket: t.id, level: "error" });
      }
      return;
    }
    if (attempts === 1) {
      ws.activity("foreman", `${t.id} ${status} (attempt 1) — will retry fresh from a checkpoint brief`, { ticket: t.id, level: "warn" });
      ws.updateState((s) => (s.tickets[t.id].status = "queued"));
    } else if (attempts === 2 && supervisor && supervisor !== "director") {
      const rid = `${t.id}.review-${attempts}`;
      const rfile = join(ws.ticketsDir, `${rid}.md`);
      const tail = gateTail(ws, t.id, 30);
      writeFileSync(
        rfile,
        `---\nid: ${rid}\ntitle: Review why ${t.id} keeps failing and write FEEDBACK.md\nkind: review\nassignee: ${supervisor}\nparent: ${t.id}\ntimeout: 20\nidle: 4\nbudget: { steps: 40, outTokens: 10000 }\nverify:\n  - test -s .foreman/runs/${t.id}/FEEDBACK.md\n---\n\n# Review ${t.id}\n\nTicket ${t.id} (\`${ws.ticketFile(t.id)}\`) failed twice (last status: ${status}). You are its supervisor.\nRead the ticket, the last REPORT.md in \`.foreman/runs/${t.id}/\` if any, and the gate tail below. Do NOT implement anything and do NOT read more than the files the ticket names.\nYour FIRST write must be \`.foreman/runs/${t.id}/FEEDBACK.md\`: the single most likely cause, the exact change required, and what must be true when done — under 300 words. If the ticket itself is wrong, say so first and propose the amendment.\nThen write your own report file named in your header and stop.\n\n## Gate tail\n\n\`\`\`\n${tail}\n\`\`\`\n`,
      );
      ws.activity("foreman", `${t.id} failed twice — escalated to ${supervisor} as ${rid}`, { ticket: t.id, level: "warn" });
      ws.event("task.escalated", { ticket: t.id, review: rid, to: supervisor });
      ws.updateState((s) => (s.tickets[t.id].status = "queued"));
      ws.updateState((s) => (s.tickets[t.id].waitingOn = rid));
    } else {
      ws.updateState((s) => (s.tickets[t.id].status = "blocked"));
      ws.event("task.blocked", { ticket: t.id, attempts });
      ws.activity("foreman", `${t.id} BLOCKED after ${attempts} attempts — needs the director`, { ticket: t.id, level: "error" });
    }
  };

  for (;;) {
    const state = ws.state();
    const all = ws.tickets();
    const statusOf = (tid) => state.tickets[tid]?.status ?? "queued";
    const ready = all.filter((t) => {
      if (running.has(t.id)) return false;
      if (statusOf(t.id) !== "queued") return false;
      if (t.meta.paused) return false;
      if (!depsOf(t.meta).every((d) => statusOf(d) === "verified")) return false;
      const w = state.tickets[t.id]?.waitingOn;
      if (w && statusOf(w) !== "verified") return false;
      if (t.meta.parent && statusOf(t.meta.parent) === "blocked") return false;
      return true;
    });
    for (const t of ready) {
      if (running.size >= globalCap || ran >= maxRuns) break;
      const r = route(ws, { ...t, text: "" }, {});
      const agentName = r.agent?.name ?? "worker";
      if (inFlightFor(agentName) >= agentCap(agentName)) continue;
      ran++;
      process.stdout.write(`\n=== work: ${t.id} → ${agentName} (${r.tier}/${(r.model ?? "").split("/").pop()}) — ${t.meta.title ?? ""} ===\n`);
      const promise = spawnForeman(["run", t.id, "--verify", "--auto-report"], ws.root).then(async () => {
        running.delete(t.id);
        await finish(t, null);
      });
      running.set(t.id, { agent: agentName, promise });
    }
    if (running.size === 0) {
      const queued = all.filter((t) => statusOf(t.id) === "queued" && !running.has(t.id));
      if (ran >= maxRuns || !queued.length || !watch) {
        const blocked = all.filter((t) => statusOf(t.id) === "blocked").map((t) => t.id);
        const msg = ran >= maxRuns ? `reached --max ${maxRuns}` : queued.length ? `${queued.length} queued but not ready (deps/escalation)` : "drained";
        process.stdout.write(`work: ${msg}${blocked.length ? `; blocked: ${blocked.join(", ")}` : ""}\n`);
        ws.activity("foreman", `work daemon stopped — ${msg}${blocked.length ? `; blocked: ${blocked.join(", ")}` : ""}`, { level: blocked.length ? "warn" : "ok" });
        ws.setManager("idle", msg);
        cleanup();
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    await Promise.race([...running.values()].map((r) => r.promise));
  }
}

// ---------- reporting commands -----------------------------------------------------------

function cmdStatus() {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const state = ws.state();
  const rows = ws.tickets().map((t) => {
    const ts = state.tickets[t.id] ?? { status: "queued", runs: [] };
    const last = ts.runs.at(-1);
    const dur = last ? fmtDuration((last.endedAt ? Date.parse(last.endedAt) : Date.now()) - Date.parse(last.startedAt)) : "";
    const tokens = ts.runs.reduce((a, r) => a + (r.tokens?.total ?? 0), 0);
    const usd = ts.runs.reduce((a, r) => a + (r.usd ?? r.cost ?? 0), 0);
    const verify = ts.lastVerify ? (ts.lastVerify.ok ? "pass" : "FAIL") : "-";
    return [t.id.padEnd(7), (ts.status ?? "queued").padEnd(13), String(ts.runs.length).padStart(4), dur.padStart(8), String(tokens).padStart(9), `$${usd.toFixed(2)}`.padStart(7), verify.padEnd(5), (last?.agent ?? "").padEnd(9), t.meta.title ?? t.file];
  });
  process.stdout.write(["ID      STATUS        RUNS      DUR    TOKENS     USD VERIFY AGENT     TITLE", ...rows.map((r) => r.join("  "))].join("\n") + "\n");
}

function cmdCost(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const cfg = ws.config();
  const state = ws.state();
  const by = args.by ?? "tier";
  const rows = new Map();
  const add = (key, run, verified) => {
    const r = rows.get(key) ?? { runs: 0, in: 0, out: 0, ctx: 0, usd: 0, stalls: 0, finished: 0, verified: 0 };
    r.runs++;
    r.in += run.tokens?.input ?? 0;
    r.out += run.tokens?.output ?? 0;
    r.ctx = Math.max(r.ctx, run.tokens?.total ?? 0);
    r.usd += run.usd ?? runCost(run, cfg.tiers[run.tier] ?? {});
    if (run.status === "stalled" || run.status === "timeout") r.stalls++;
    if (run.status === "finished") r.finished++;
    if (verified) r.verified++;
    rows.set(key, r);
  };
  for (const [tid, ts] of Object.entries(state.tickets)) {
    const verified = ts.status === "verified";
    for (const run of ts.runs ?? []) {
      const key = by === "ticket" ? tid : by === "agent" ? run.agent ?? "worker" : by === "model" ? run.model ?? "(default)" : run.tier ?? "standard";
      add(key, run, verified && run === ts.runs.at(-1));
    }
  }
  for (const a of ws.agents()) {
    for (const s of a.state.sessions ?? []) if (String(s.task ?? "").startsWith("ask#")) add(by === "agent" ? a.name : by === "model" ? s.model ?? "?" : by === "ticket" ? s.task : a.tier, { tokens: { input: 0, output: 0, total: s.ctxTokens }, usd: s.spend, status: "finished" }, false);
  }
  if (args.json) return void process.stdout.write(JSON.stringify(Object.fromEntries(rows), null, 2) + "\n");
  const total = [...rows.values()].reduce((a, r) => a + r.usd, 0);
  process.stdout.write(`${by.toUpperCase().padEnd(44)} RUNS   IN TOK  OUT TOK  MAX CTX      USD  STALL  FINISHED\n`);
  for (const [k, r] of [...rows.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].out - a[1].out)) {
    process.stdout.write(`${k.padEnd(44)} ${String(r.runs).padStart(4)} ${fmtTokens(r.in).padStart(8)} ${fmtTokens(r.out).padStart(8)} ${fmtTokens(r.ctx).padStart(8)} ${("$" + r.usd.toFixed(4)).padStart(8)} ${String(r.stalls).padStart(6)} ${String(r.finished).padStart(9)}\n`);
  }
  process.stdout.write(`${"TOTAL".padEnd(44)} ${"".padStart(4)} ${"".padStart(8)} ${"".padStart(8)} ${"".padStart(8)} ${("$" + total.toFixed(4)).padStart(8)}\n`);
  if (total === 0) process.stdout.write("(all runs on free-tier models; set tiers.<name>.inputPerM/outputPerM in .foreman/foreman.json to estimate)\n");
}

function cmdReport(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const ticket = ws.ticket(args._[1] ?? die("usage: foreman report <ticket-id>"));
  const reportPath = join(ws.runDir(ticket.id), "REPORT.md");
  const ts = ws.state().tickets[ticket.id];
  const last = ts?.runs.at(-1);
  if (last) {
    process.stdout.write(`## run #${last.n} ${last.status} ${fmtDuration(Date.parse(last.endedAt ?? nowIso()) - Date.parse(last.startedAt))} agent=${last.agent ?? "-"} model=${last.model} tokens=${last.tokens.total} usd=$${(last.usd ?? 0).toFixed(4)} session=${last.sessionID}\n\n`);
    if (last.lastText) process.stdout.write(`## worker's last words\n\n${last.lastText}\n\n`);
  }
  const fb = join(ws.runDir(ticket.id), "FEEDBACK.md");
  if (existsSync(fb)) process.stdout.write(`## FEEDBACK.md (from the lead)\n\n${readFileSync(fb, "utf8")}\n\n`);
  process.stdout.write(`## REPORT.md\n\n`);
  process.stdout.write(existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "(no report — run `foreman run <id> --purpose report` to have a drone write one from the log)\n");
}

async function cmdDiff() {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const { out } = await runShell("git status --short | head -100; echo; git diff --stat | tail -30", ws.root);
  process.stdout.write(out);
}

function cmdTail(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace");
  const ticket = ws.ticket(args._[1] ?? die("usage: foreman tail <ticket-id> [--lines N]"));
  const file = ws.latestLog(ticket.id) ?? die(`no runs for ${ticket.id}`);
  const lines = Number(args.lines ?? 60);
  const text = readFileSync(file, "utf8").split("\n");
  process.stdout.write(`# ${file} (${text.length} lines, showing last ${lines})\n` + text.slice(-lines).join("\n") + "\n");
}

async function cmdUi(args) {
  const ws = Workspace.find() ?? die("not inside a foreman workspace (run `foreman init`)");
  const { startUi } = await import("./ui.mjs");
  await startUi(ws, args);
}

function cmdHelp() {
  process.stdout.write(`foreman — multi-model orchestration engine for AI coding agents

  foreman                                   open the dashboard (same as \`foreman ui\`) when inside a workspace
  foreman ui [--queue|--work] [--once] [--view org|tasks|agent|cost|stream]
  foreman init [dir] [--name project]       create .foreman/ with the default agent roster; sync .opencode/agent
  foreman agents [sync|install]             roster: role, tier, resolved model, supervisor, phase, spend
  foreman models [--probe] [model]          tiers, fallbacks and model health; --probe pings each model and records it
  foreman ask <agent> "prompt" [--fresh] [--file f] [--model p/m]
                                            talk to any agent in its persistent session (fresh past the tier's context cap)
  foreman ticket <slug> --title "..." [--kind k] [--parent T001]
  foreman run <id> [--message "..."] [--continue] [--agent a] [--tier t] [--model p/m] [--purpose work|report]
                     [--timeout min] [--idle min] [--verify] [--auto-report]
                                            route + dispatch with budgets; --continue is refused past the context cap
  foreman work [--concurrency N] [--max N] [--watch]
                                            daemon: ready tasks → agents, gates, escalation ladder, commit boundaries
  foreman queue [--max N]                   simple sequential runner (stops at first failed gate)
  foreman verify <id>                       run the ticket's gates (recorded; the worker's word is never the gate)
  foreman accept <id> --note "..."          manager promotes a stalled/timeout ticket whose gate passed
  foreman note "..." [--ticket T] [--phase p]
  foreman cost [--by tier|agent|model|ticket] [--json]
  foreman status · report <id> · tail <id> [--lines N] · diff
`);
}

// `foreman status | head` must not stack-trace when the reader closes the pipe early.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const table = { init: cmdInit, ticket: cmdTicket, agents: cmdAgents, models: cmdModels, ask: cmdAsk, run: cmdRun, work: cmdWork, queue: cmdQueue, verify: cmdVerify, accept: cmdAccept, note: cmdNote, cost: cmdCost, status: cmdStatus, report: cmdReport, diff: cmdDiff, tail: cmdTail, ui: cmdUi, help: cmdHelp };
if (!cmd) {
  if (Workspace.find()) await cmdUi(args);
  else cmdHelp();
} else if (!table[cmd]) {
  cmdHelp();
  process.exit(1);
} else await table[cmd](args);
