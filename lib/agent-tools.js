/**
 * dsh-safe-tui / agent self-service tools.
 *
 * These tools let the AI itself:
 *  - inspect the current session (id, preset, model, cwd),
 *  - switch its own live model / preset,
 *  - hand the conversation off to the Safe TUI console (same session),
 *  - ask to return from the console back to the Web conversation.
 *
 * The same definitions are registered in the Web profile (web console host)
 * and in the Safe TUI profile. The execution branches on the host mode.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { requestHandoff, clearHandoff } from "./web-console.js";

/** Live model-selection refs for Safe TUI agents, keyed by Agent. */
export const agentModelRefs = new WeakMap();

// "code" was renamed "ptc" in newer DSH builds; keep it as an alias.
const ALLOWED_PRESETS = ["minimal", "standard", "ptc", "cordis"];
const PRESET_ALIASES = { code: "ptc" };

function normalizePresetId(id) {
  return PRESET_ALIASES[id] ?? id;
}

/** Every settled event of a live session (`snapshotEvents()` on rc.2+). */
function allEvents(session) {
  try {
    return session?.snapshotEvents?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Official `minimal` preset exposes exactly two tools: the persistent shell
 * (`pwsh` on Windows / `bash` elsewhere) and `str_replace_editor`.
 *
 * Those tools live in the preset layer, but the Web/dev hosts also register many
 * GLOBAL tools (dev_*, console_*, view_image, …) that are visible to every
 * agent regardless of preset. To make `minimal` match the official two-tool
 * description in this deployment we add an agent-scoped `tools.restrict()`
 * allow-mask whenever the agent is joined to the minimal preset.
 */
/**
 * Symbol stored on the live agent so a hot-reloaded copy of this module can
 * find and lift a restriction installed by the previous module generation.
 * `Symbol.for` keeps the key identical across reloads.
 */
const MINIMAL_RESTRICTION = Symbol.for("dsh-safe-tui.minimal-tool-restriction");

function minimalAllowList() {
  return process.platform === "win32"
    ? ["pwsh", "str_replace_editor"]
    : ["bash", "str_replace_editor"];
}

function applyMinimalRestriction(agent) {
  const tools = agent?.ctx?.tools;
  if (!tools || typeof tools.restrict !== "function") return;
  if (agent[MINIMAL_RESTRICTION]) return;
  try {
    const dispose = tools.restrict({ allow: minimalAllowList() });
    agent[MINIMAL_RESTRICTION] = dispose;
  } catch (error) {
    console.warn(`[safe-tui] could not apply minimal tool restriction: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearMinimalRestriction(agent) {
  const dispose = agent[MINIMAL_RESTRICTION];
  if (!dispose) return;
  try { dispose(); } catch { /* best effort */ }
  delete agent[MINIMAL_RESTRICTION];
}

function syncMinimalRestriction(agent, presetId) {
  if (!agent) return;
  if (presetId === "minimal") applyMinimalRestriction(agent);
  else clearMinimalRestriction(agent);
}

/**
 * Keep every live agent's tool mask in sync with its agent preset. This is used
 * by both the Web host and the Safe TUI host so `/preset minimal`,
 * `console_set_preset`, and new sessions that start on minimal all behave like
 * the official two-tool preset instead of inheriting the host's global tools.
 */
export function enforceMinimalPresetTools(ctx) {
  const presets = ctx.get("agentPresets");
  const agents = ctx.get("agents");
  if (!presets || !agents) return;

  // Cover agents that were already live before this plugin (re)loaded.
  for (const agent of agents.list?.() ?? []) {
    try {
      const presetId = presets.composedPreset?.(agent.ctx) ?? "";
      syncMinimalRestriction(agent, presetId);
    } catch { /* ignore */ }
  }

  ctx.on("agent/created", ({ agent }) => {
    try {
      const presetId = presets.composedPreset?.(agent.ctx) ?? "";
      syncMinimalRestriction(agent, presetId);
    } catch { /* ignore */ }
  });

  ctx.on("agent-preset/selected", (sessionId, agentPreset) => {
    try {
      const agent = agents.get?.(sessionId);
      syncMinimalRestriction(agent, agentPreset);
    } catch { /* ignore */ }
  });

  ctx.on("agent/disposed", ({ agent }) => {
    clearMinimalRestriction(agent);
  });
}

const OUTPUT_STATUS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", required: true },
    model: { type: "string", required: true },
    preset: { type: "string", required: true },
    cwd: { type: "string", required: true },
    note: { type: "string" }
  }
};

const OUTPUT_SIMPLE = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
    sessionId: { type: "string" },
    model: { type: "string" },
    preset: { type: "string" }
  }
};


/** Keep the deployment default preset in step with a live session switch. */
async function syncDefaultPreset(ctx, presetId) {
  try {
    const settings = ctx.get("settings");
    if (settings && typeof settings.update === "function") {
      await settings.update("agent-presets", { default: presetId });
    }
  } catch { /* best effort */ }
}

function renderSimple(_args, value) {
  const text = value.message
    ?? value.note
    ?? `session ${value.sessionId ?? "?"} · model ${value.model ?? "?"} · preset ${value.preset ?? "?"}`;
  return [{ type: "text", text }];
}

let rpcSeq = 0;
function rpcRequest(payload) {
  return { rpcId: `safe-tui-${Date.now()}-${++rpcSeq}`, payload };
}

async function resolveModelSpec(ctx, provider, model) {
  const llm = ctx.get("llm");
  let providerId = provider;
  let modelId = model;
  if (!modelId && providerId?.includes("/")) {
    [providerId, modelId] = providerId.split("/", 2);
  }
  if (!providerId || !modelId) throw new Error("need provider and model (provider/model)");
  const providers = llm.listProviders();
  const providerEntry = providers.find((entry) => entry.id === providerId);
  if (!providerEntry) throw new Error(`provider not found: ${providerId}`);
  const models = await llm.listModels(providerId);
  const found = models.find((entry) => entry.id === modelId);
  if (!found) throw new Error(`model not found: ${providerId}/${modelId}`);
  return { provider: providerId, model: modelId };
}

async function webModelStatus(ctx, sessionId) {
  try {
    const api = ctx.get("apiProxy");
    if (api?.sessions?.models) {
      const response = await api.sessions.models(rpcRequest({ sessionId }));
      if (response?.result?.ok && response.result.value?.current) {
        const current = response.result.value.current;
        return `${current.provider}/${current.model}`;
      }
    }
  } catch { /* fall through */ }
  try {
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    return `${selection.provider}/${selection.model}`;
  } catch {
    return "unknown";
  }
}

async function webPresetStatus(ctx, sessionId) {
  try {
    const api = ctx.get("apiProxy");
    if (api?.agentPresets?.list) {
      const response = await api.agentPresets.list(rpcRequest({}));
      if (response?.result?.ok) {
        const defaultEntry = response.result.value.presets.find((entry) => entry.isDefault);
        return defaultEntry?.id ?? "unknown";
      }
    }
  } catch { /* ignore */ }
  return "unknown";
}

export function trackingAgentSetup(selection, presets, presetId) {
  const ref = { current: selection, assembled: void 0 };
  return async (agentCtx, agent) => {
    installModelSelection(agentCtx, ref);
    // rc.2 hands the live agent as the second setup argument; the scoped
    // agentCtx carries no `.agent` back-reference.
    if (agent) agentModelRefs.set(agent, ref);
    if (presets) await presets.mount(agentCtx, presetId);
  };
}

/**
 * Tools active in the Web profile. `exec.agent` is the live Web agent.
 */
export function registerWebAgentTools(ctx) {
  const tools = ctx.get("tools");
  if (!tools) return;

  tools.register(defineTool({
    name: "console_status",
    description: "Show the current conversation identity (session id, model, cwd). Useful before moving work to the Safe TUI console.",
    parameters: {},
    output: { schema: OUTPUT_STATUS, render: renderSimple },
    execute: async (_args, exec) => {
      const sessionId = exec.agent.session.id;
      const model = await webModelStatus(ctx, sessionId);
      return {
        sessionId,
        model,
        preset: await webPresetStatus(ctx, sessionId),
        cwd: process.cwd(),
        note: "Use console_handoff to continue this exact session in the Safe TUI console."
      };
    }
  }));

  tools.register(defineTool({
    name: "console_set_model",
    description: "Switch the model for the CURRENT conversation. Works immediately for this session and is also saved as the default.",
    parameters: {
      model: { type: "string", required: true, description: "Model id, or provider/model (e.g. deepseek/deepseek-chat)." },
      provider: { type: "string", description: "Provider id when model is bare." }
    },
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (args, exec) => {
      const sessionId = exec.agent.session.id;
      const api = ctx.get("apiProxy");
      if (!api?.sessions?.selectModel) throw new Error("session model API unavailable");
      let provider = args.provider;
      let model = args.model;
      if (!provider && model.includes("/")) [provider, model] = model.split("/", 2);
      const response = await api.sessions.selectModel(rpcRequest({ sessionId, provider, model }));
      if (!response?.result?.ok) {
        throw new Error(response?.result?.error?.message ?? "model switch failed");
      }
      const selected = response.result.value.selected;
      return {
        ok: true,
        message: `Model switched to ${selected.provider}/${selected.model}`,
        sessionId,
        model: `${selected.provider}/${selected.model}`
      };
    }
  }));

  tools.register(defineTool({
    name: "console_set_preset",
    description: "Switch the preset for the CURRENT conversation. Works immediately through the live agent preset recompose API; switching a session with existing turns is allowed with a warning.",
    parameters: {
      preset: { type: "string", required: true, description: "Preset id from the enabled roster (e.g. minimal, standard, code, cordis)." }
    },
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (args, exec) => {
      const sessionId = exec.agent.session.id;
      const id = String(args.preset ?? "").trim();
      const presets = ctx.get("agentPresets");
      if (!presets?.recompose) throw new Error("preset recompose API unavailable");
      const hasHistory = allEvents(exec.agent.session).some((event) => event.type === "turn/start");
      const warning = hasHistory ? " (warning: this session has existing turns)" : "";
      const preset = await presets.recompose(exec.agent.ctx, id);
      exec.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
      await syncDefaultPreset(ctx, preset.id);
      return {
        ok: true,
        message: `Preset switched to ${preset.id}${warning}`,
        sessionId,
        preset: preset.id
      };
    }
  }));

  tools.register(defineTool({
    name: "console_handoff",
    description: "Hand this exact Web conversation off to the Safe TUI console (same session) AND restart the Web server so the TUI can take over the live session. Use when you need to test a change that requires a Web restart: the browser switches to the console tab and the Safe TUI waits for the Web side to release, then resumes this same session id.",
    parameters: {
      note: { type: "string", description: "Short reason/handoff note visible to the operator." }
    },
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (args, exec) => {
      const sessionId = exec.agent.session.id;
      try {
        await ctx.get("sessions")?.flush?.(exec.agent.session);
      } catch { /* best effort */ }
      try {
        exec.agent.cancel({ kind: "user" });
      } catch { /* best effort; the turn may already be over */ }
      // Release the live Web session so the Safe TUI can prepare/resume the
      // same id immediately. This is an internal detach; the scheduled Web
      // restart then removes the stale Web agent entirely.
      try {
        const sessions = ctx.get("sessions");
        const live = sessions?.get?.(sessionId);
        if (live && typeof sessions.liveEntryFor === "function") {
          const entry = sessions.liveEntryFor(live);
          if (entry?.detach) entry.detach();
        }
      } catch { /* best effort */ }
      requestHandoff(sessionId, args.note ?? "");
      setTimeout(() => {
        try {
          if (typeof globalThis.fetch === "function") {
            void globalThis.fetch("http://127.0.0.1:3080/easy-start/api/restart", { method: "POST" }).catch(() => {});
          }
        } catch { /* ignore */ }
      }, 1200);
      return {
        ok: true,
        message: `Handoff requested; Web restart scheduled. The Safe TUI console will switch to this session (${sessionId}) after the Web side releases it.`,
        sessionId
      };
    }
  }));

  tools.register(defineTool({
    name: "console_return",
    description: "Ask the Web client to switch back from the Safe TUI console to the regular Web conversation tab.",
    parameters: {},
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (_args, exec) => {
      const sessionId = exec.agent.session.id;
      requestHandoff(sessionId, "", "web");
      return {
        ok: true,
        message: `Return request sent; the Web client will switch back to this conversation (${sessionId}).`,
        sessionId
      };
    }
  }));
}

/**
 * Tools active in the Safe TUI profile. `exec.agent` is the Safe TUI agent
 * (which may be the same session resumed from the Web conversation).
 */
export function registerSafeAgentTools(ctx) {
  const tools = ctx.get("tools");
  if (!tools) return;

  tools.register(defineTool({
    name: "console_status",
    description: "Show the current Safe TUI session identity (session id, preset, model, cwd).",
    parameters: {},
    output: { schema: OUTPUT_STATUS, render: renderSimple },
    execute: async (_args, exec) => {
      const presets = ctx.get("agentPresets");
      const selection = ctx.get("agentDefaultModel")?.currentSelection?.() ?? { provider: "", model: "" };
      let preset = "unknown";
      try {
        preset = presets?.composedPreset(exec.agent.ctx) ?? "unknown";
      } catch { /* ignore */ }
      return {
        sessionId: exec.agent.session.id,
        model: `${selection.provider}/${selection.model}`,
        preset,
        cwd: process.cwd(),
        note: "Use console_set_model / console_set_preset to configure this session; console_return to go back to Web."
      };
    }
  }));

  tools.register(defineTool({
    name: "console_set_model",
    description: "Switch the model for the CURRENT Safe TUI session. Takes effect from the agent's next model step and is saved as the default too.",
    parameters: {
      model: { type: "string", required: true, description: "Model id, or provider/model (e.g. deepseek/deepseek-chat)." },
      provider: { type: "string", description: "Provider id when model is bare." }
    },
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (args, exec) => {
      const selection = await resolveModelSpec(ctx, args.provider, args.model);
      const ref = agentModelRefs.get(exec.agent);
      if (ref) ref.current = selection;
      await ctx.get("agentDefaultModel")?.saveSelection?.(selection);
      return {
        ok: true,
        message: `Model switched to ${selection.provider}/${selection.model}`,
        sessionId: exec.agent.session.id,
        model: `${selection.provider}/${selection.model}`
      };
    }
  }));

  tools.register(defineTool({
    name: "console_set_preset",
    description: "Switch the preset for the CURRENT Safe TUI session. Allowed presets: minimal, standard, code, cordis.",
    parameters: {
      preset: { type: "string", required: true, description: "Preset id: minimal, standard, code, or cordis." }
    },
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (args, exec) => {
      const id = normalizePresetId(String(args.preset ?? "").trim());
      if (!ALLOWED_PRESETS.includes(id)) throw new Error(`not allowed: ${id}; allowed: ${ALLOWED_PRESETS.join(", ")}`);
      const presets = ctx.get("agentPresets");
      const hasHistory = allEvents(exec.agent.session).some((event) => event.type === "turn/start");
      const warning = hasHistory ? " (warning: this session has existing turns)" : "";
      const preset = await presets.recompose(exec.agent.ctx, id);
      exec.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
      await syncDefaultPreset(ctx, preset.id);
      return {
        ok: true,
        message: `Preset switched to ${preset.id}${warning}`,
        sessionId: exec.agent.session.id,
        preset: preset.id
      };
    }
  }));

  tools.register(defineTool({
    name: "console_return",
    description: "Return to the regular Web conversation tab AND close this Safe TUI session so the Web side can safely own the same conversation again. Use this when the Web server is back up.",
    parameters: {},
    output: { schema: OUTPUT_SIMPLE, render: renderSimple },
    execute: async (_args, exec) => {
      const sessionId = exec.agent.session.id;
      clearHandoff();
      requestHandoff(sessionId, "", "web");
      setTimeout(() => {
        try { process.exit(0); } catch { /* ignore */ }
      }, 600);
      return {
        ok: true,
        message: `Return request sent; closing this Safe TUI session so the Web client can resume ${sessionId} safely.`,
        sessionId
      };
    }
  }));
}
