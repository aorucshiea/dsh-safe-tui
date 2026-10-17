// DeepSeek Harness safe-mode recovery TUI.
//
// This plugin runs on top of dsh-base with NO web UI and NO user plugin
// bundles. It intentionally only exposes the shipped system presets
// (`minimal`, `standard`, `ptc`, `cordis`) and never loads user-authored
// presets, the web client, or user plugins. It can repair the web profile's
// fragile patched files from pristine copies.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { checkAll, repairAll, printReport } from "./repair.js";
import { repairSessionFile } from "./session-repair.js";
import { applyWebConsole } from "./web-console.js";
import { trackingAgentSetup, registerWebAgentTools, registerSafeAgentTools, enforceMinimalPresetTools } from "./agent-tools.js";
import { acquireSessionLease, tryAcquireSessionLease, releaseSessionLease, releaseAllSessionLeases, inspectSessionLease } from "./session-lease.js";
import { TUI, cyan, green, gray, dim, red, yellow, blue, bold, messageBlocks } from "./tui.js";

export const name = "safe-tui";
export const inject = [
  "cmdlineArgs",
  "loader",
  "agents",
  "sessions",
  "sessionPersistence",
  "agentDefaultModel",
  "agentPresets",
  "llm"
];

/**
 * DSH rc.3 can re-enter the cordis preset while its old standing mount still
 * owns the process-global inspect providers. `dsh-tool-cordis` treats the
 * duplicate as a fatal mount error. Make registration idempotent at the
 * service seam instead of patching the installed package.
 */
const CORDIS_INSPECT_PATCHED = Symbol.for("dsh-safe-tui.cordis-inspect-idempotent");
function patchCordisInspect(ctx) {
  try {
    const inspect = ctx.get("cordisInspect");
    if (!inspect || typeof inspect.register !== "function" || inspect[CORDIS_INSPECT_PATCHED]) return;
    const original = inspect.register.bind(inspect);
    inspect.register = (registration) => {
      const id = registration?.manifest?.id;
      try {
        if (id && typeof inspect.list === "function") {
          const exists = inspect.list().some((provider) => provider?.platform === "host" && provider?.id === id);
          if (exists) return () => {};
        }
      } catch { /* fall through to the real register */ }
      try {
        return original(registration);
      } catch (error) {
        if (!String(error?.message ?? error).includes("already registered")) throw error;
        return () => {};
      }
    };
    inspect[CORDIS_INSPECT_PATCHED] = true;
  } catch { /* service absent in this profile */ }
}

/** Web-side session leases, keyed by live agent. */
const webSessionLeases = new WeakMap();

function detachWebAgentForSession(ctx, sessionId) {
  setTimeout(() => {
    try {
      const sessions = ctx.get("sessions");
      const live = sessions?.get?.(sessionId);
      if (live && typeof sessions.liveEntryFor === "function") {
        const entry = sessions.liveEntryFor(live);
        if (entry?.detach) entry.detach();
      }
    } catch { /* best effort */ }
  }, 0);
}

function holdWebSessionLease(ctx, agent) {
  const sessionId = String(agent?.session?.id ?? "");
  if (!/^session-[0-9a-fA-F-]+$/.test(sessionId) || webSessionLeases.has(agent)) return;
  let lease = null;
  try {
    lease = tryAcquireSessionLease(sessionId, "web");
  } catch (error) {
    console.warn("[safe-tui] session lease error for " + sessionId + ": " + (error instanceof Error ? error.message : String(error)));
    return;
  }
  if (lease !== null) {
    webSessionLeases.set(agent, lease);
    return;
  }
  const current = inspectSessionLease(sessionId);
  console.warn("[safe-tui] session " + sessionId + " is already owned by " + (current?.owner ?? "unknown") + " (pid " + (current?.pid ?? "?") + "); detaching the Web agent to avoid concurrent writes");
  detachWebAgentForSession(ctx, sessionId);
}

function releaseWebSessionLease(agent) {
  const lease = webSessionLeases.get(agent);
  if (lease === undefined) return;
  releaseSessionLease(lease);
  webSessionLeases.delete(agent);
}

/** Enforce one writer per session between the Web host and the Safe TUI. */
function enforceWebSessionLeases(ctx) {
  const agents = ctx.get("agents");
  if (!agents) return;
  for (const agent of agents.list?.() ?? []) holdWebSessionLease(ctx, agent);
  ctx.on("agent/created", ({ agent }) => holdWebSessionLease(ctx, agent));
  ctx.on("agent/disposed", ({ agent }) => releaseWebSessionLease(agent));
  ctx.effect(() => () => {
    const live = ctx.get("agents");
    for (const agent of live?.list?.() ?? []) releaseWebSessionLease(agent);
  }, "dsh-safe-tui: web session leases");
}

// Official shipped system presets only. User-authored presets stay hidden.
// ptc = PTC mode (Standard + run_code TS SDK; older builds called it code),
// cordis = 创造模式 (runtime inspection / plugin experimentation / preset authoring).
const ALLOWED_PRESETS = ["minimal", "standard", "ptc", "cordis"];
const PRESET_ALIASES = { code: "ptc" };

const PRESET_META = {
  minimal: {
    name: "极简模式",
    description: "仅持久 bash 与 str_replace_editor 的双工具编码 Agent"
  },
  standard: {
    name: "标准模式",
    description: "完整编码 Agent：文件编辑、Shell、检索、Skills、计划、目标、子代理、工作流"
  },
  ptc: {
    name: "PTC 模式",
    description: "标准全部能力 + Code Mode SDK，用 TypeScript 程序组合多步操作"
  },
  cordis: {
    name: "创造模式",
    description: "标准全部能力 + 运行时检查、插件实验、preset 创作指导"
  }
};

function normalizePresetId(id) {
  return PRESET_ALIASES[id] ?? id;
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * rc.3: Session exposes its events via `snapshotEvents()`; older versions had a
 * plain `.events` property. Reading the property returns undefined on rc.3,
 * which made every resumed session look empty.
 */
function sessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
  } catch { /* fall through */ }
  return session.events ?? [];
}

function printEvent(event, out = console.log) {
  if (event.type === "user/message") {
    const text = messageText(event.data?.message);
    if (text) out(`\n[you] ${text}`);
    return;
  }
  if (event.type === "assistant/message") {
    for (const block of messageBlocks(event.data?.message)) {
      if (block.kind === "text") out(`\n[assistant] ${block.text}`);
      else if (block.kind === "reasoning") out(`\n  [thinking] ${block.text}`);
      else if (block.kind === "tool") out(`\n  [tool] ⚙ ${block.text}`);
      else if (block.kind === "tool-result") out(`\n  [result] ${block.text}`);
    }
    return;
  }
  if (event.type === "turn/start") {
    out("\n[ turn started ]");
  } else if (event.type === "turn/end") {
    const reason = event.data?.reason?.kind ?? "unknown";
    out(`[ turn ended: ${reason} ]`);
  }
}

async function printHistoryTail(ctx, agent, count = 8, out = console.log) {
  const events = (await historyEventsFor(ctx, agent)).filter(
    (event) => event.type === "user/message" || event.type === "assistant/message"
  );
  const tail = events.slice(-count);
  if (tail.length === 0) {
    out("[safe] (empty session)");
    return;
  }
  out(`\n[safe] showing last ${tail.length} persisted messages:`);
  for (const event of tail) printEvent(event, out);
}

/**
 * 2026-09-23: rc.3 下 resume 出来的 agent 其 session.events 可能是空的（历史
 * 由持久化层持有，不再回填到 live session）。这里先取 live，空则回退到
 * persistence.inspect(id).events，保证 /resume 能看到历史。
 */
async function historyEventsFor(ctx, agent) {
  const live = sessionEvents(agent?.session);
  try {
    const persistence = ctx.get("sessionPersistence");
    const id = agent?.session?.id;
    if (!persistence || !id) return live;
    const events = await readPersistedEvents(persistence, id, 0);
    // Persisted history can be complete while the rc.3 live session only holds
    // events produced after resume. Prefer the longer snapshot.
    return events.length >= live.length ? events : live;
  } catch {
    return live;
  }
}

async function printTuiHistory(ctx, agent, tui, count = 20) {
  const types = new Set([
    "user/message",
    "assistant/message",
    "tool/result",
    "turn/start",
    "turn/end"
  ]);
  const all = await historyEventsFor(ctx, agent);
  const events = all.filter((event) => types.has(event.type));
  const tail = events.slice(-count);
  if (tail.length === 0) {
    const liveN = sessionEvents(agent?.session).length;
    tui.println(gray(`[safe] (empty session: live=${liveN} loaded=${all.length})`));
    return;
  }
  tui.println(gray(`[safe] showing last ${tail.length} persisted events:`));
  for (const event of tail) tui.addEvent(event);
}

function modelSelection(ctx) {
  return ctx.get("agentDefaultModel").currentSelection();
}

function safeDefaultPreset(ctx) {
  // 2026-09-23: rc.3 的 standard preset 依赖 Host 层的 model-selection-settings /
  // subagent / workflows 等服务，safe profile（dsh-base + safe-tui）不发布这些，
  // 挂载必失败（"cannot get property agent/model-selection-settings without
  // inject"）。safe 模式一律用 minimal（自洽、无 host 依赖）。
  return "minimal";
}

function safePresetForSession(presetId) {
  // 同上：safe 模式下恢复会话也一律用 minimal 挂载（历史记录不受影响，
  // 只是工具面变小）。需要完整工具面请回 Web UI。
  return "minimal";
}

// agentSetup = trackingAgentSetup (imported): keeps the live ModelSelectionRef
// per agent so the Safe TUI `console_set_model` tool can switch the current
// agent's model without creating a new session.

async function createNewAgent(ctx, out = console.log) {
  const selection = modelSelection(ctx);
  const presets = ctx.get("agentPresets");
  const presetId = safeDefaultPreset(ctx);
  const handle = await ctx.get("agents").create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: trackingAgentSetup(selection, presets, presetId)
  });
  agentHandles.set(handle.agent, handle.dispose);
  out(`\n[safe] new session: ${handle.agent.id} (preset: ${presetId})`);
  return handle.agent;
}

/**
 * 2026-09-23: rc.3 的 sessionPersistence.list() 返回快照对象
 * `{ header, revision, sizeBytes }`（旧版直接返回 header）。这里统一归一化，
 * 否则调用方拿到的 header.id/cwd/createdAt 全是 undefined——表现为会话列表
 * 显示 "(no cwd) / 1/1/1970"，并且 /resume 传 undefined 后崩在 `.length` 上。
 */
async function persistedHeaders(persistence) {
  const raw = (await persistence.list()) ?? [];
  return raw
    .map((entry) => (entry && typeof entry === "object" && entry.header ? entry.header : entry))
    .filter(Boolean);
}

async function resumeAgent(ctx, sessionId, out = console.log) {
  const selection = modelSelection(ctx);
  const presets = ctx.get("agentPresets");
  const headers = await persistedHeaders(ctx.get("sessionPersistence"));
  const stored = headers.find((header) => header.id === sessionId)?.agentPreset;
  const presetId = safePresetForSession(stored);
  const handle = await ctx.get("agents").resume({
    resumeSessionId: sessionId,
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: trackingAgentSetup(selection, presets, presetId)
  });
  agentHandles.set(handle.agent, handle.dispose);
  out(`\n[safe] resumed session: ${handle.agent.id} (safe preset: ${presetId})`);
  return handle.agent;
}

async function repairSessionById(ctx, sessionId, out = console.log) {
  const persistence = ctx.get("sessionPersistence")
  const headers = await persistedHeaders(persistence)
  const header = headers.find((item) => item.id === sessionId)
  if (!header) throw new Error(`session not found: ${sessionId}`)
  const loc = typeof persistence.locate === "function" ? persistence.locate(header) : void 0
  if (!loc?.path) throw new Error(`session has no filesystem location: ${sessionId}`)
  const backup = repairSessionFile(loc.path)
  if (backup) {
    out(`\n[safe] repaired session ${sessionId} (backup: ${backup})`)
  } else {
    out(`\n[safe] session ${sessionId} already readable`)
  }
  return Boolean(backup)
}

async function resumeOrRepair(ctx, sessionId, out = console.log) {
  try {
    return await resumeAgent(ctx, sessionId, out)
  } catch (originalError) {
    // 只有"日志损坏"类错误才值得尝试修复；写锁冲突等修复无用。
    const message = originalError instanceof Error ? originalError.message : String(originalError)
    const repairable = /corrupt|seq gap|SessionFormatError|unparsable/i.test(message)
    if (!repairable) throw originalError
    try {
      const repaired = await repairSessionById(ctx, sessionId, out)
      if (repaired) out(`[safe] 已修复会话日志，重试恢复…`)
      return await resumeAgent(ctx, sessionId, out)
    } catch (error2) {
      const reason = error2 instanceof Error ? error2.message : String(error2)
      out(`${red("error")} 修复后仍无法恢复: ${reason}`)
      throw originalError
    }
  }
}

/**
 * Resume a session for the Web Console shuttle. When the Web profile still
 * holds the session live ("cannot prepare ... while it is live"), wait and
 * retry so the console can take over right after the Web server/agent stops.
 */
async function resumeWithWait(ctx, sessionId, out = console.log, maxAttempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await resumeOrRepair(ctx, sessionId, out);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("while it is live")) throw error;
      out(`[safe] waiting for Web side to release session ${sessionId} (${attempt}/${maxAttempts})…`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

/**
 * rc.3: persistence 的 readFrom()/inspect() 都被移除了，读取统一走
 * open(id, "read") → handle.read(offset) → {events} → handle.close()。
 * 保留旧 API 回退，兼容 rc.2。
 */
async function readPersistedEvents(persistence, id, offset = 0) {
  if (!persistence) return [];
  if (typeof persistence.open === "function") {
    const handle = await persistence.open(id, "read");
    try {
      const view = await handle.read(offset);
      return view?.events ?? [];
    } finally {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
  if (typeof persistence.readFrom === "function") {
    const view = await persistence.readFrom(id, offset);
    return view?.events ?? [];
  }
  if (typeof persistence.inspect === "function" && offset <= 0) {
    const view = await persistence.inspect(id);
    return view?.events ?? [];
  }
  return [];
}

async function sessionTitle(persistence, id) {
  try {
    const events = await readPersistedEvents(persistence, id, 0);
    const last = [...events].reverse().find((event) => event.type === "session/title");
    return last?.data?.title ?? "";
  } catch {
    return "";
  }
}

function sessionDateCategory(time) {
  const date = new Date(Number(time) || 0);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString();
}

async function cleanEmptySessions(ctx, out = console.log, dryRun = false) {
  const persistence = ctx.get("sessionPersistence");
  const headers = await persistedHeaders(persistence);
  const empty = [];
  for (const header of headers) {
    let hasAi = false;
    try {
      const events = await readPersistedEvents(persistence, header.id, 0);
      hasAi = events.some((event) =>
        event.type === "assistant/message" ||
        event.type === "assistant/chunk" ||
        event.type === "tool/call"
      );
    } catch { /* unreadable session: keep it rather than deleting blindly */ }
    if (!hasAi) empty.push(header);
  }
  if (dryRun) {
    for (const header of empty) out(`[clean] would delete ${header.id}`);
    out(`[clean] found ${empty.length} empty session(s)`);
    return empty.length;
  }
  let deleted = 0;
  for (const header of empty) {
    const loc = typeof persistence.locate === "function" ? persistence.locate(header) : void 0;
    if (loc?.path) {
      try {
        await rm(dirname(loc.path), { recursive: true, force: true });
        deleted += 1;
        out(`[clean] deleted empty ${header.id}`);
      } catch (error) {
        out(`[clean] could not delete ${header.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      out(`[clean] no filesystem location for ${header.id}; skipped`);
    }
  }
  out(`[clean] removed ${deleted} empty session(s)`);
  return deleted;
}

async function removeSession(persistence, header) {
  const loc = typeof persistence.locate === "function" ? persistence.locate(header) : void 0;
  if (!loc?.path) throw new Error("session has no filesystem location");
  await rm(dirname(loc.path), { recursive: true, force: true });
}

async function listSessions(ctx, out = console.log, includeAll = false) {
  const persistence = ctx.get("sessionPersistence");
  const headers = await persistedHeaders(persistence);
  const rows = [];
  for (const header of headers) {
    const title = await sessionTitle(persistence, header.id);
    if (!includeAll && title === "") continue;
    rows.push({ header, title });
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.header.cwd ?? "(no cwd)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  out(includeAll ? "\nall saved sessions by workspace:" : "\nsaved conversations by workspace:");
  if (rows.length === 0) {
    out("  (none)");
    return;
  }
  for (const key of keys) {
    const items = groups.get(key).sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0));
    out(`\n${key}`);
    for (const row of items) {
      const header = row.header;
      const preset = header.agentPreset ? ` preset:${header.agentPreset}` : "";
      if (row.title !== "") {
        out(`  ${row.title}`);
        out(`    id:${header.id}  cwd:${header.cwd ?? "?"}${preset}`);
      } else {
        out(`  ${header.id}  cwd:${header.cwd ?? "?"}${preset}`);
      }
    }
  }
}

async function listModels(ctx, out = console.log) {
  const llm = ctx.get("llm");
  const current = modelSelection(ctx);
  out("\navailable models:");
  const providers = llm.listProviders();
  if (providers.length === 0) {
    out("  (none)");
    return;
  }
  for (const provider of providers) {
    const models = await llm.listModels(provider.id);
    for (const model of models) {
      const mark = model.id === current.model && provider.id === current.provider ? "  *current*" : "";
      out(`  ${provider.id}/${model.id}${mark}`);
    }
  }
  out("\n  switch with: /models <provider/model>");
}

async function listProviders(ctx, out = console.log) {
  const llm = ctx.get("llm");
  const current = modelSelection(ctx);
  const providers = llm.listProviders();
  out("\nmodel providers:");
  if (providers.length === 0) {
    out("  (none active)");
  } else {
    for (const provider of providers) {
      const mark = provider.id === current.provider ? "  *current*" : "";
      out(`  ${provider.id}  ${provider.name ?? ""}${mark}`);
    }
  }
  const configurable = typeof llm.listConfigurableProviders === "function"
    ? llm.listConfigurableProviders()
    : [];
  const dormant = configurable.filter((entry) => !providers.some((provider) => provider.id === entry.provider));
  if (dormant.length > 0) {
    out("\nconfigurable (not yet enabled) providers:");
    for (const entry of dormant) {
      out(`  ${entry.provider}  ${entry.displayName ?? ""}`);
    }
    out("\n  enable them by adding an 'llm-pi-ai:' section to ~/.dsh/settings.yaml");
  }
  out("\n  switch with: /model <provider/model>");
}

async function setModel(ctx, spec, out = console.log) {
  const llm = ctx.get("llm");
  const providers = llm.listProviders();
  let providerId;
  let modelId;
  if (spec.includes("/")) {
    [providerId, modelId] = spec.split("/", 2);
  } else {
    for (const provider of providers) {
      const models = await llm.listModels(provider.id);
      const found = models.find((model) => model.id === spec);
      if (found !== void 0) {
        providerId = provider.id;
        modelId = found.id;
        break;
      }
    }
    if (providerId === void 0) throw new Error(`model not found: ${spec}`);
  }
  const models = await llm.listModels(providerId);
  const found = models.find((model) => model.id === modelId);
  if (found === void 0) throw new Error(`model not found: ${providerId}/${modelId}`);
  await ctx.get("agentDefaultModel").saveSelection({
    provider: providerId,
    model: modelId
  });
  out(`[safe] default model set: ${providerId}/${modelId}`);
}

async function runOneShot(ctx, task) {
  const agent = await createNewAgent(ctx);
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: task }],
      source: { kind: "user" }
    })
  );
  await agent.whenIdle();
  await ctx.get("sessions").flush(agent.session);
  let text = "";
  let reason;
  for (const event of sessionEvents(agent.session)) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = messageText(event.data?.message);
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data?.reason;
  }
  process.stdout.write(`\n${text}\n`);
  return reason?.kind === "completed" ? 0 : 1;
}

/** Agent-handle disposers for sessions this TUI created or resumed. */
const agentHandles = new WeakMap();

function sessionIdOf(agent) {
  return String(agent?.session?.id ?? "");
}

async function disposeAgentHandle(agent) {
  const dispose = agentHandles.get(agent);
  if (dispose === undefined) return;
  agentHandles.delete(agent);
  try { agent.cancel?.({ kind: "user" }); } catch { /* best effort */ }
  try {
    await Promise.race([
      Promise.resolve(dispose()),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
  } catch { /* best effort */ }
}

/** Replace the current agent and tear down the previous writer cleanly. */
async function setCurrentAgent(state, agent) {
  const previous = state.agent;
  state.agent = agent;
  if (previous === undefined || previous === agent) return;
  const previousId = sessionIdOf(previous);
  await disposeAgentHandle(previous);
  const previousLease = state.leases?.get(previousId);
  if (previousLease !== undefined) {
    releaseSessionLease(previousLease);
    state.leases.delete(previousId);
  }
  if (state.lease?.sessionId === previousId) {
    state.lease = agent === undefined ? undefined : state.leases?.get(sessionIdOf(agent));
  }
}

/** Drop a lease when resuming that session did not actually succeed. */
function abandonConsoleLease(state, sessionId) {
  const id = String(sessionId);
  const lease = state.leases?.get(id);
  if (lease !== undefined) {
    releaseSessionLease(lease);
    state.leases.delete(id);
  }
  if (state.lease?.sessionId === id) {
    state.lease = state.agent !== undefined ? state.leases?.get(sessionIdOf(state.agent)) : undefined;
  }
}

/** Ensure this Safe TUI process is the sole writer of a session. */
async function ensureConsoleLease(ctx, state, sessionId, out = console.log) {
  const id = String(sessionId ?? "");
  if (!/^session-[0-9a-fA-F-]+$/.test(id)) return null;
  if (state.lease?.sessionId === id) return state.lease;
  if (state.leases === undefined) state.leases = new Map();
  let lease = state.leases.get(id);
  if (lease === undefined) {
    lease = await acquireSessionLease(id, "console", {
      waitMs: process.env.DSH_SAFE_CONSOLE_WAIT === "1" ? 60_000 : 3_000,
      onWait: (current) => out(`[safe] waiting for ${current?.owner ?? "another process"} to release ${id}…`)
    });
    if (lease === null) {
      const current = inspectSessionLease(id);
      throw new Error(`session ${id} is owned by ${current?.owner ?? "another process"} (pid ${current?.pid ?? "?"})`);
    }
    state.leases.set(id, lease);
  }
  state.lease = lease;
  return lease;
}

async function sendUserText(ctx, state, text, out = console.log) {
  // Claim the busy flag BEFORE creating the session so a fast double Enter
  // during first-session creation queues instead of spawning two agents.
  if (state.busy) {
    state.queue.push(text);
    out("[safe] (turn is running; input queued)");
    return;
  }
  state.busy = true;
  try {
    if (state.agent === void 0) {
      const next = await createNewAgent(ctx, out);
      try {
        await ensureConsoleLease(ctx, state, next.session.id, out);
        await setCurrentAgent(state, next);
      } catch (error) {
        abandonConsoleLease(state, next.session.id);
        await disposeAgentHandle(next);
        throw error;
      }
    }
    await ensureConsoleLease(ctx, state, state.agent.session.id, out);
    state.agent.followup(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" }
      })
    );
    await state.agent.whenIdle();
    await ctx.get("sessions").flush(state.agent.session);
  } finally {
    state.busy = false;
  }
  while (state.queue.length > 0) {
    const next = state.queue.shift();
    await sendUserText(ctx, state, next, out);
  }
}

/**
 * Live-mirror events written to the persisted session by another process
 * (usually the Web conversation holding the same session). The Safe TUI stays
 * read-only while mirroring: it tails the durable log and renders new events,
 * so the Web stream appears in the TUI in near real-time without this process
 * becoming a second writer.
 */
function startLiveMirror(ctx, state, addEvent, seenSeqs = new Set()) {
  const persistence = ctx.get("sessionPersistence");
  if (!persistence) return () => {};
  let currentId = "";
  let nextIndex = 0;
  let primed = false;
  let running = false;
  let stopped = false;

  /** Prime a session without replaying the history already printed by the TUI. */
  const prime = async (sessionId) => {
    const events = await readPersistedEvents(persistence, sessionId, 0);
    currentId = String(sessionId);
    nextIndex = events.length;
    primed = true;
  };

  const remember = (seq) => {
    if (!Number.isFinite(seq)) return;
    seenSeqs.add(seq);
    // Keep the dedupe set bounded on very long sessions.
    if (seenSeqs.size > 4000) {
      const first = seenSeqs.values().next().value;
      if (first !== undefined) seenSeqs.delete(first);
    }
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const agent = state.agent;
      if (!agent) return;
      const id = String(agent.session.id);
      if (!primed || id !== currentId) {
        seenSeqs.clear();
        await prime(id);
      }
      if (stopped || state.agent?.session?.id !== id) return;
      const events = await readPersistedEvents(persistence, id, nextIndex);
      if (events.length === 0) return;
      nextIndex += events.length;
      const active = sessionEvents(state.agent?.session);
      const activeSeqs = new Set(active.map((event) => event?.seq).filter(Number.isFinite));
      for (const event of events) {
        if (Number.isFinite(event?.seq) && (activeSeqs.has(event.seq) || seenSeqs.has(event.seq))) continue;
        remember(event?.seq);
        try { addEvent(event); } catch { /* display-only */ }
      }
    } catch { /* transient read race; try again next tick */ }
    finally { running = false; }
  };

  void tick();
  const timer = setInterval(tick, 700);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function runREPL(ctx, initialSessionId) {
  const state = {
    agent: void 0,
    busy: false,
    queue: [],
    lease: void 0
  };

  const seenSeqs = new Set();
  const offEvent = ctx.on("session/event", (session, event) => {
    if (state.agent === void 0 || session.id !== state.agent.session.id) return;
    if (Number.isFinite(event?.seq)) seenSeqs.add(event.seq);
    printEvent(event);
  });

  if (initialSessionId) {
    try {
      await ensureConsoleLease(ctx, state, initialSessionId, console.log);
      const next = process.env.DSH_SAFE_CONSOLE_WAIT === "1"
        ? await resumeWithWait(ctx, initialSessionId)
        : await resumeOrRepair(ctx, initialSessionId);
      await setCurrentAgent(state, next);
      await printHistoryTail(ctx, next, 8);
    } catch (error) {
      abandonConsoleLease(state, initialSessionId);
      console.error(`[safe] failed to resume ${initialSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      console.log("[safe] 用 /resume 选其它会话，或 /new 新建（发送第一条消息时才会真正创建）");
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    prompt: "\n[safe]> "
  });

  const stopLiveMirror = startLiveMirror(ctx, state, (event) => printEvent(event), seenSeqs);

  if (!initialSessionId) {
    // claude 式欢迎：✻ 符号 + 精简两行，不画大框（TUI 自带 header/footer 骨架）。
    console.log("");
    console.log(`  ${green("✻")} ${bold("Safe TUI")} ${dim("已就绪")}`);
    console.log(`    ${gray("/ 命令面板 · /sessions 切换会话 · /help 全部命令")}`);
  }

  rl.prompt();
  const safePrompt = () => {
    if (!rl.closed) rl.prompt();
  };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (state.agent) await ctx.get("sessions").flush(state.agent.session);
    } catch { /* exit anyway */ }
    offEvent?.();
    releaseAllSessionLeases();
    process.exit(0);
  };

  rl.on("line", async (line) => {
    const input = line.trim();
    rl.setPrompt("\n[safe]> ");
    if (input === "") {
      safePrompt();
      return;
    }
    if (input === "/quit" || input === "/exit" || input === "/q") {
      await shutdown();
      return;
    }
    if (input === "/help") {
      console.log(`\nsafe-mode commands:
  /sessions             open sessions history (list + resume + delete)
  /sessions all         open all saved sessions including untitled
  /list [all]           list saved sessions
  /resume <id>          resume a saved session
  /new                  start a fresh session
  /preset               show current preset / allowed presets
  /preset <id>          switch preset: ${ALLOWED_PRESETS.join(", ")} (history switch with warning)
  /models | /model       list available models
  /add-provider          add an LLM provider
  /providers             list active model providers
  /models <id> | /model <id>   switch default model
  /status               show session / preset / model
  /repair               repair broken web client files (restore pristine)
  /check                check web client file health
  /quit                 exit safe mode
`);
      safePrompt();
      return;
    }
    if (input === "/sessions") {
      try {
        await listSessions(ctx, console.log, false);
      } catch (error) {
        console.error(`[safe] sessions failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/sessions all") {
      try {
        await listSessions(ctx, console.log, true);
      } catch (error) {
        console.error(`[safe] sessions failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/list" || input === "/list all") {
      try {
        await listSessions(ctx, console.log, input === "/list all");
      } catch (error) {
        console.error(`[safe] list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/resume") {
      try {
        await listSessions(ctx, console.log, true);
      } catch (error) {
        console.error(`[safe] sessions failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input.startsWith("/resume ")) {
      const resumeId = input.slice("/resume ".length).trim();
      try {
        await ensureConsoleLease(ctx, state, resumeId, console.log);
        const next = await resumeOrRepair(ctx, resumeId, console.log);
        await setCurrentAgent(state, next);
        await printHistoryTail(ctx, next, 8);
      } catch (error) {
        abandonConsoleLease(state, resumeId);
        console.error(`[safe] resume failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/new") {
      try {
        const next = await createNewAgent(ctx);
        await setCurrentAgent(state, next);
      } catch (error) {
        console.error(`[safe] new failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/preset") {
      const presets = ctx.get("agentPresets");
      console.log(`\navailable presets: ${ALLOWED_PRESETS.join(", ")}`);
      console.log(`current default preset: ${presets.defaultId}`);
      if (state.agent) {
        const currentPreset = presets.composedPreset(state.agent.ctx);
        const hasHistory = sessionEvents(state.agent.session).some((event) => event.type === "turn/start");
        console.log(`current session preset: ${currentPreset ?? "(none)"}`);
        console.log(`current session has history: ${hasHistory ? "yes (switchable with warning)" : "no"}`);
      }
      safePrompt();
      return;
    }
    if (input.startsWith("/preset ")) {
      const id = normalizePresetId(input.slice("/preset ".length).trim());
      if (!ALLOWED_PRESETS.includes(id)) {
        console.error(`[safe] not allowed: ${id}; allowed: ${ALLOWED_PRESETS.join(", ")}`);
        safePrompt();
        return;
      }
      if (!state.agent) {
        console.log("[safe] no current session; start /new first, then switch preset.");
        safePrompt();
        return;
      }
      const hasHistory = sessionEvents(state.agent.session).some((event) => event.type === "turn/start");
      if (hasHistory) {
        console.log("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible");
      }
      try {
        const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, id);
        state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
        console.log(`[safe] now using preset: ${preset.id}`);
      } catch (error) {
        console.error(`[safe] preset switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/status") {
      const presets = ctx.get("agentPresets");
      const selection = modelSelection(ctx);
      const currentPreset = state.agent ? presets.composedPreset(state.agent.ctx) : void 0;
      console.log(`\nsafe mode status`);
      console.log(`  session: ${state.agent ? state.agent.id : "(none)"}`);
      console.log(`  current preset: ${currentPreset ?? "(none)"}`);
      console.log(`  default preset: ${presets.defaultId}`);
      console.log(`  model: ${selection.provider}/${selection.model}`);
      console.log(`  workdir: ${process.cwd()}`);
      safePrompt();
      return;
    }
    if (input === "/add-provider") {
      console.log("[safe] /add-provider requires the full TUI; run 'deepseek' in a real terminal.");
      safePrompt();
      return;
    }
    if (input === "/providers") {
      try {
        await listProviders(ctx);
      } catch (error) {
        console.error(`[safe] providers failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/models" || input === "/model") {
      try {
        await listModels(ctx);
      } catch (error) {
        console.error(`[safe] models failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input.startsWith("/models ") || input.startsWith("/model ")) {
      const spec = (input.startsWith("/models ") ? input.slice("/models ".length) : input.slice("/model ".length)).trim();
      try {
        await setModel(ctx, spec);
      } catch (error) {
        console.error(`[safe] model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/repair" || input === "/repair-only") {
      const report = repairAll();
      const ok = printReport(report);
      console.log(ok ? "[safe] repair complete." : "[safe] repair FAILED - see above.");
      safePrompt();
      return;
    }
    if (input === "/clean" || input === "/clean-empty") {
      try {
        await cleanEmptySessions(ctx);
      } catch (error) {
        console.error(`[safe] clean failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/check") {
      const report = checkAll();
      const ok = printReport(report);
      console.log(ok ? "[safe] check complete." : "[safe] health problems found.");
      safePrompt();
      return;
    }
    try {
      await sendUserText(ctx, state, input);
    } catch (error) {
      console.error(`[safe] turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    safePrompt();
  });

  rl.on("close", () => {
    void shutdown();
  });
}

async function runTUI(ctx, initialSessionId) {
  const state = {
    agent: void 0,
    busy: false,
    queue: [],
    lease: void 0
  };

  // On Windows, force the console to UTF-8 so Chinese/IME input decodes correctly.
  if (process.platform === "win32") {
    try {
      spawnSync("chcp", ["65001"], { stdio: "ignore" });
    } catch { /* best-effort */ }
  }

  const say = (text) => tui.println(String(text));

  const tui = new TUI({
    statusProvider: () => {
      const presets = ctx.get("agentPresets");
      const selection = modelSelection(ctx);
      const currentPreset = state.agent ? presets.composedPreset(state.agent.ctx) : "none";
      const sid = state.agent?.session?.id ? String(state.agent.session.id).replace(/^session-/, "").slice(0, 8) : "";
      const modelId = `${selection.provider}/${selection.model}`;
      // 窄面板（~60 列）里过长模型名会把状态行顶成两行，截到 34 格。
      const modelShort = modelId.length > 34 ? modelId.slice(0, 33) + "…" : modelId;
      const parts = [
        green("● safe"),
        cyan(String(currentPreset ?? "none")),
        gray(modelShort)
      ];
      if (sid) parts.push(dim(sid));
      return `  ${parts.join(gray(" · "))}`;
    },
    onSubmit: async (raw) => {
      const input = raw.trim();
      if (input === "") return;
      if (input === "/quit" || input === "/exit" || input === "/q") {
        tui.quit();
        return;
      }
      if (input === "/help") {
        say(helpText());
        return;
      }
      if (input === "/sessions") {
        // opencode 同款：/sessions 直接列全部（未命名的用 id 显示）。此前默认
        // 只列"有标题的"，而标题读取在 rc.3 下一直是坏的 → 列表永远为空，
        // 看起来就像没反应。
        await openSessionPicker(true);
        return;
      }
      if (input === "/sessions all") {
        await openSessionPicker(true);
        return;
      }
      // 2026-09-23: 帮助里宣传的 /list 与 /resume 此前没有实现，输入会直接
      // 落到聊天框（AI 会收到 "/list" 这种无意义消息）。这里补齐分发。
      if (input === "/list" || input === "/list all") {
        await listSessions(ctx, say, input === "/list all");
        return;
      }
      if (input === "/resume") {
        await openSessionPicker(true);
        return;
      }
      if (input.startsWith("/resume ")) {
        const resumeId = input.slice("/resume ".length).trim();
        if (!resumeId) {
          await openSessionPicker(true);
          return;
        }
        // Already on this session: resuming again would hit the write-lease
        // ("already owned by an active write handle" — owned by ourselves).
        if (state.agent?.session?.id === resumeId) {
          say(gray(`[safe] already in ${resumeId}`));
          return;
        }
        if (state.busy) {
          say(yellow("[safe] a turn is running; cancel it before switching sessions"));
          return;
        }
        try {
          await ensureConsoleLease(ctx, state, resumeId, say);
          const next = await resumeOrRepair(ctx, resumeId, say);
          await setCurrentAgent(state, next);
          await printTuiHistory(ctx, next, tui);
        } catch (error) {
          abandonConsoleLease(state, resumeId);
          say(`${red("error")} resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/new") {
        if (state.busy) {
          say(yellow("[safe] a turn is running; cancel it before switching sessions"));
          return;
        }
        try {
          const next = await createNewAgent(ctx, say);
          await ensureConsoleLease(ctx, state, next.session.id, say);
          await setCurrentAgent(state, next);
        } catch (error) {
          say(`${red("error")} new failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/preset") {
        await openPresetPicker();
        return;
      }
      if (input.startsWith("/preset ")) {
        const id = normalizePresetId(input.slice("/preset ".length).trim());
        if (!ALLOWED_PRESETS.includes(id)) {
          say(`${red("error")} not allowed: ${id}; allowed: ${ALLOWED_PRESETS.join(", ")}`);
          return;
        }
        if (!state.agent) {
          say("[safe] no current session; start /new first, then switch preset.");
          return;
        }
        const hasHistory = sessionEvents(state.agent.session).some((event) => event.type === "turn/start");
        if (hasHistory) {
          say(yellow("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible"));
        }
        try {
          const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, id);
          state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
          say(`[safe] now using preset: ${preset.id}`);
        } catch (error) {
          say(`${red("error")} preset switch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/status") {
        const presets = ctx.get("agentPresets");
        const selection = modelSelection(ctx);
        const currentPreset = state.agent ? presets.composedPreset(state.agent.ctx) : void 0;
        say(`\nsafe mode status`);
        say(`  session: ${state.agent ? state.agent.id : "(none)"}`);
        say(`  current preset: ${currentPreset ?? "(none)"}`);
        say(`  default preset: ${presets.defaultId}`);
        say(`  model: ${selection.provider}/${selection.model}`);
        say(`  workdir: ${process.cwd()}`);
        return;
      }
      if (input === "/add-provider") {
        await addProviderFlow();
        return;
      }
      if (input === "/providers") {
        try {
          await listProviders(ctx, say);
        } catch (error) {
          say(`${red("error")} providers failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/models" || input === "/model") {
        await openModelPicker();
        return;
      }
      if (input.startsWith("/models ") || input.startsWith("/model ")) {
        const spec = (input.startsWith("/models ") ? input.slice("/models ".length) : input.slice("/model ".length)).trim();
        try {
          await setModel(ctx, spec, say);
        } catch (error) {
          say(`${red("error")} model switch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/repair" || input === "/repair-only") {
        const report = repairAll();
        const ok = printReport(report, say);
        say(ok ? "[safe] repair complete." : "[safe] repair FAILED - see above.");
        return;
      }
      if (input === "/clean" || input === "/clean-empty") {
        try {
          await cleanEmptySessions(ctx, say);
        } catch (error) {
          say(`${red("error")} clean failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/check") {
        const report = checkAll();
        const ok = printReport(report, say);
        say(ok ? "[safe] check complete." : "[safe] health problems found.");
        return;
      }

      // No local echo here: the session/event listener renders the persisted
      // user message; echoing both displayed every message twice.

      if (state.busy) {
        state.queue.push(input);
        say(gray("[safe] turn is running; input queued"));
        return;
      }
      tui.setBusy(true);
      try {
        await sendUserText(ctx, state, input, say);
      } catch (error) {
        say(`${red("error")} turn failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        tui.setBusy(false);
      }
    },
    onCommandSelect: async (command) => {
      const base = command.split(/\s+/)[0];
      if (base === "/model" || base === "/models") {
        await openModelPicker();
        return;
      }
      if (base === "/sessions" || (base === "/resume" && !/\s\S/.test(command))) {
        // /sessions 一律列全部（与 opencode 一致），未命名会话用 id 展示。
        await openSessionPicker(true);
        return;
      }
      if (base === "/list") {
        await listSessions(ctx, say, /\ball\b/i.test(command));
        return;
      }
      if (base === "/preset") {
        await openPresetPicker();
        return;
      }
      await tui.onSubmit(command);
    },
    onCancel: () => {
      if (!state.agent || !state.busy) return;
      try {
        state.agent.cancel({ kind: "user" });
        say(yellow("[safe] cancellation requested; waiting for the turn to stop…"));
      } catch (error) {
        say(`${red("error")} cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    onQuit: () => {
      // Flush the durable log before leaving so the final events survive.
      void (async () => {
        try {
          if (state.agent) await ctx.get("sessions").flush(state.agent.session);
        } catch { /* exit anyway */ }
        releaseAllSessionLeases();
        process.exit(0);
      })();
    }
  });

  const openModelPicker = async () => {
    const llm = ctx.get("llm");
    const providers = llm.listProviders();
    const items = [];
    for (const provider of providers) {
      const models = await llm.listModels(provider.id);
      for (const model of models) {
        items.push({
          label: `${provider.id}/${model.id}`,
          value: `${provider.id}/${model.id}`
        });
      }
    }
    if (items.length === 0) {
      say(gray("[safe] no models available"));
      return;
    }
    tui.openPicker({
      title: "Select model",
      items,
      onSelect: async (item) => {
        try {
          await setModel(ctx, item.value, say);
          say(gray("new sessions will use this model; /new to start one"));
        } catch (error) {
          say(`${red("error")} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

  const openSessionPicker = async (includeAll = false) => {
    const persistence = ctx.get("sessionPersistence");
    const headers = await persistedHeaders(persistence);
    const rows = [];
    for (const header of headers) {
      const title = await sessionTitle(persistence, header.id);
      if (!includeAll && title === "") continue;
      const preset = header.agentPreset ? ` · ${header.agentPreset}` : "";
      rows.push({ header, title, preset });
    }
    const currentId = state.agent?.session?.id;
    const items = rows
      .sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0))
      .map((row) => {
        const cwd = row.header.cwd ?? "(no cwd)";
        const workspaceName = cwd === "(no cwd)" ? cwd : (basename(cwd) || cwd);
        return {
          label: row.title !== "" ? row.title : row.header.id,
          value: row.header.id,
          category: sessionDateCategory(row.header.createdAt),
          footer: workspaceName,
          detail: `${row.header.id} · ${cwd}${row.preset}`,
          current: row.header.id === currentId,
          header: row.header
        };
      });
    if (items.length === 0) {
      say(includeAll ? gray("[safe] no saved sessions") : gray("[safe] no titled conversations; use /sessions all to see every saved session"));
      return;
    }
    let deleteArm = null;
    tui.openPicker({
      title: "Sessions",
      items,
      filterable: true,
      onDelete: async (item) => {
        if (deleteArm === item.value) {
          deleteArm = null;
          try {
            await removeSession(persistence, item.header);
            say(green(`[safe] deleted ${item.label}`));
            tui.closePicker();
            await openSessionPicker(includeAll);
          } catch (error) {
            say(`${red("error")} delete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          deleteArm = item.value;
          say(yellow(`[safe] press ctrl+x again to delete ${item.label}`));
        }
      },
      onSelect: async (item) => {
        if (state.busy) {
          say(yellow("[safe] a turn is running; cancel it before switching sessions"));
          return;
        }
        try {
          await ensureConsoleLease(ctx, state, item.value, say);
          const next = await resumeOrRepair(ctx, item.value, say);
          await setCurrentAgent(state, next);
          await printTuiHistory(ctx, next, tui);
        } catch (error) {
          abandonConsoleLease(state, item.value);
          say(`${red("error")} resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

  const openPresetPicker = async () => {
    let currentId;
    try {
      const presets = ctx.get("agentPresets");
      currentId = state.agent ? presets.composedPreset(state.agent.ctx) : presets.defaultId;
    } catch { /* no active session/default */ }
    const items = ALLOWED_PRESETS.map((id) => ({
      label: id,
      value: id,
      current: id === currentId,
      detail: `${PRESET_META[id]?.name ?? id} — ${PRESET_META[id]?.description ?? ""}`
    }));
    tui.openPicker({
      title: "Select preset",
      items,
      onSelect: async (item) => {
        if (!state.agent) {
          say("[safe] no current session; /new first, then switch preset");
          return;
        }
        const hasHistory = sessionEvents(state.agent.session).some((event) => event.type === "turn/start");
        if (hasHistory) {
          say(yellow("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible"));
        }
        try {
          const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, item.value);
          state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
          say(`[safe] now using preset: ${preset.id}`);
        } catch (error) {
          say(`${red("error")} preset switch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

  const addProviderFlow = async () => {
    const llm = ctx.get("llm");
    const configurable = typeof llm.listConfigurableProviders === "function"
      ? llm.listConfigurableProviders()
      : [];
    if (configurable.length > 0) {
      say(gray("known configurable providers: " + configurable.map((p) => p.provider).join(", ")));
    }
    say(gray("type /cancel to abort at any step"));

    const askOrCancel = async (question) => {
      const answer = ((await tui.ask(question)) ?? "").trim();
      return answer === "/cancel" ? null : answer;
    };

    const providerId = await askOrCancel("Provider id (e.g. local, openai, anthropic):");
    if (providerId === null || providerId === "") {
      say(gray("[add-provider] cancelled"));
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
      say(red("[add-provider] invalid provider id: " + providerId));
      return;
    }
    const displayName = await askOrCancel(`Display name (default: ${providerId}):`);
    if (displayName === null) {
      say(gray("[add-provider] cancelled"));
      return;
    }
    const apiKeyEnv = await askOrCancel("API key environment variable (optional):");
    if (apiKeyEnv === null) {
      say(gray("[add-provider] cancelled"));
      return;
    }
    const baseURL = await askOrCancel("Base URL (optional for known providers, required for custom):");
    if (baseURL === null) {
      say(gray("[add-provider] cancelled"));
      return;
    }
    const modelsRaw = await askOrCancel("Model id(s), comma separated (optional for known providers):");
    if (modelsRaw === null) {
      say(gray("[add-provider] cancelled"));
      return;
    }
    const providerIdFinal = providerId;
    const displayNameFinal = displayName.trim() !== "" ? displayName.trim() : providerIdFinal;
    const apiKeyEnvFinal = apiKeyEnv.trim();
    const baseURLFinal = baseURL.trim();
    const modelIds = modelsRaw.split(",").map((x) => x.trim()).filter(Boolean);

    const profile = { displayName: displayNameFinal };
    if (apiKeyEnvFinal !== "") profile.apiKeyEnv = apiKeyEnvFinal;
    if (baseURLFinal !== "") {
      profile.baseURL = baseURLFinal;
      profile.api = "openai-completions";
    }
    if (modelIds.length > 0) profile.models = modelIds.map((id) => ({ id }));

    const settings = ctx.get("settings");
    if (settings === void 0) {
      say(red("[add-provider] settings service is not available"));
      return;
    }
    try {
      await settings.update("llm-pi-ai", {
        providers: { [providerIdFinal]: profile }
      });
      say(green(`[add-provider] added ${providerIdFinal} (${displayNameFinal})`));
      say(gray("it will appear in /models; no restart needed"));
    } catch (error) {
      say(red(`[add-provider] failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const seenSeqs = new Set();
  const offEvent = ctx.on("session/event", (session, event) => {
    if (state.agent !== void 0 && session.id === state.agent.session.id) {
      if (Number.isFinite(event?.seq)) seenSeqs.add(event.seq);
      tui.addEvent(event);
    }
  });

  tui.start();

  if (!initialSessionId) {
    const selection = modelSelection(ctx);
    tui.printWelcome({
      model: `${selection.provider}/${selection.model}`,
      cwd: process.cwd(),
      preset: ctx.get("agentPresets")?.defaultId ?? "minimal"
    });
  }

  if (initialSessionId) {
    try {
      const waitForWeb = process.env.DSH_SAFE_CONSOLE_WAIT === "1";
      await ensureConsoleLease(ctx, state, initialSessionId, say);
      const next = waitForWeb
        ? await resumeWithWait(ctx, initialSessionId, say)
        : await resumeOrRepair(ctx, initialSessionId, say);
      await setCurrentAgent(state, next);
      await printTuiHistory(ctx, next, tui);
    } catch (error) {
      abandonConsoleLease(state, initialSessionId);
      // 2026-09-23: 不再在失败时自动新建会话——每次连接都会留下一个空会话，
      // 在 Web 侧栏堆成一片 "Administrator"。改为提示，用 /new 或 /resume 决定。
      say(`${red("error")} failed to resume ${initialSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      say(gray("[safe] 用 /resume 选其它会话，或 /new 新建（发送第一条消息时才会真正创建）"));
    }
  }

  const stopLiveMirror = startLiveMirror(ctx, state, (event) => tui.addEvent(event), seenSeqs);

  // Keep a reference so the event listener does not get GC'd; the TUI owns the
  // process lifetime and exits through onQuit.
  void offEvent;
  void stopLiveMirror;
}

function helpText() {
  return `DeepSeek Harness safe mode

CLI:
  dsh --profile safe                    interactive recovery TUI
  dsh --profile safe "task text"        answer one task and exit
  dsh --profile safe --list             list saved sessions and exit
  dsh --profile safe --resume <id>      open interactive TUI on a saved session
  dsh --profile safe --new              create a new session (with safe preset) and exit
  dsh --profile safe --check            check web client file health and exit
  dsh --profile safe --models           list available models and exit
  dsh --profile safe --providers        list active model providers and exit
  dsh --profile safe --model <id>       switch default model and exit
  dsh --profile safe --clean            delete empty sessions with no AI output
  dsh --profile safe --repair           repair broken web client files and exit

TUI commands:
  /sessions            切换会话（浏览 / 恢复 / 删除）
  /new                 新建会话（发首条消息才落盘）
  /preset              切换 preset（minimal / standard / ptc / cordis）
  /model               切换模型
  /providers           查看模型提供方
  /add-provider        引导式添加模型提供方
  /status              当前会话 / preset / 模型
  /check               健康检查
  /clean-empty         清理没有 AI 输出的空会话
  /help                本帮助
  /quit                退出 safe 模式

  兼容写法仍可用：/resume <id>、/list [all]、/sessions all、/preset <id>、/model <id>

Safe mode loads only dsh-base + safe-tui. No user plugins, no web UI,
no user-authored presets. Only official system presets are offered:
minimal / standard / ptc / cordis.`;
}

export function apply(ctx) {
  const args = ctx.get("cmdlineArgs")?.get() ?? [];

  const finish = (code) => {
    const exit = ctx.get("appExit");
    if (exit) exit(code);
    else process.exit(code);
  };

  const run = async () => {
    await ctx.get("loader")?.await();

    patchCordisInspect(ctx);

    // Keep live agents in sync with the official `minimal` two-tool mask,
    // regardless of how the preset was selected (console_set_preset, /preset,
    // or a new session that starts on minimal).
    enforceMinimalPresetTools(ctx)

    // In a Web profile this package acts as the Web Console host. By the time
    // the Loader is settled the webServer service is available, so this is the
    // reliable moment to detect web mode; a safe/CLI profile has no webServer.
    try {
      if (ctx.get("webServer")) {
        enforceWebSessionLeases(ctx)
        registerWebAgentTools(ctx)
        applyWebConsole(ctx)
        return
      }
    } catch { /* no webServer in safe CLI profile */ }

    registerSafeAgentTools(ctx)

    if (args.length === 0) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        try {
          await runTUI(ctx, void 0);
        } catch (error) {
          console.error(`[safe] TUI unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`);
          await runREPL(ctx, void 0);
        }
      } else {
        await runREPL(ctx, void 0);
      }
      return;
    }

    if (args[0] === "--help" || args[0] === "-h") {
      console.log(helpText());
      finish(0);
      return;
    }

    if (args[0] === "--list") {
      await listSessions(ctx);
      finish(0);
      return;
    }

    if (args[0] === "--check") {
      const report = checkAll();
      const ok = printReport(report);
      finish(ok ? 0 : 1);
      return;
    }

    if (args[0] === "--models") {
      await listModels(ctx);
      finish(0);
      return;
    }

    if (args[0] === "--providers") {
      await listProviders(ctx);
      finish(0);
      return;
    }

    if (args[0] === "--model") {
      const spec = args[1];
      if (spec === void 0 || spec === "") {
        console.error("[safe] --model requires a model id or provider/model");
        finish(1);
        return;
      }
      try {
        await setModel(ctx, spec);
      } catch (error) {
        console.error(`[safe] model switch failed: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
        return;
      }
      process.exit(0);
      return;
    }

    if (args[0] === "--clean" || args[0] === "--clean-empty") {
      await cleanEmptySessions(ctx);
      finish(0);
      return;
    }

    if (args[0] === "--repair" || args[0] === "--repair-only") {
      const report = repairAll();
      const ok = printReport(report);
      finish(ok ? 0 : 1);
      return;
    }

    if (args[0] === "--resume") {
      const id = args[1];
      if (id === void 0 || id === "") {
        console.error("[safe] --resume requires a session id");
        finish(1);
        return;
      }
      if (process.stdin.isTTY && process.stdout.isTTY) {
        try {
          await runTUI(ctx, id);
        } catch (error) {
          console.error(`[safe] TUI unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`);
          await runREPL(ctx, id);
        }
      } else {
        await runREPL(ctx, id);
      }
      return;
    }

    if (args[0] === "--new" || args[0] === "--new-session") {
      const agent = await createNewAgent(ctx);
      console.log(`[safe] created ${agent.id}`);
      finish(0);
      return;
    }

    if (args[0].startsWith("--")) {
      console.error(`[safe] unknown option: ${args[0]}`);
      finish(1);
      return;
    }

    const task = args.join(" ");
    const code = await runOneShot(ctx, task);
    finish(code);
  };

  run().catch((error) => {
    console.error(`[safe] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    finish(1);
  });
}
