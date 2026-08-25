// DeepSeek Harness safe-mode recovery TUI.
//
// This plugin runs on top of dsh-base with NO web UI and NO user plugin
// bundles. It intentionally only exposes the shipped system presets
// (`minimal`, `standard`, `code`, `cordis`) and never loads user-authored
// presets, the web client, or user plugins. It can repair the web profile's
// fragile patched files from pristine copies.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { checkAll, repairAll, printReport } from "./repair.js";
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

// Official shipped system presets only. User-authored presets stay hidden.
// code = PTC mode (Standard + run_code TS SDK), cordis = 创造模式 (runtime
// inspection / plugin experimentation / preset authoring).
const ALLOWED_PRESETS = ["minimal", "standard", "code", "cordis"];

const PRESET_META = {
  minimal: {
    name: "极简模式",
    description: "仅持久 bash 与 str_replace_editor 的双工具编码 Agent"
  },
  standard: {
    name: "标准模式",
    description: "完整编码 Agent：文件编辑、Shell、检索、Skills、计划、目标、子代理、工作流"
  },
  code: {
    name: "PTC 模式",
    description: "标准全部能力 + Code Mode SDK，用 TypeScript 程序组合多步操作"
  },
  cordis: {
    name: "创造模式",
    description: "标准全部能力 + 运行时检查、插件实验、preset 创作指导"
  }
};

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
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

function printHistoryTail(agent, count = 8, out = console.log) {
  const events = (agent.session?.events ?? []).filter(
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

function printTuiHistory(agent, tui, count = 20) {
  const types = new Set([
    "user/message",
    "assistant/message",
    "tool/result",
    "turn/start",
    "turn/end"
  ]);
  const events = (agent.session?.events ?? []).filter((event) => types.has(event.type));
  const tail = events.slice(-count);
  if (tail.length === 0) {
    tui.println(gray("[safe] (empty session)"));
    return;
  }
  tui.println(gray(`[safe] showing last ${tail.length} persisted events:`));
  for (const event of tail) tui.addEvent(event);
}

function modelSelection(ctx) {
  return ctx.get("agentDefaultModel").currentSelection();
}

function safeDefaultPreset(ctx) {
  const presets = ctx.get("agentPresets");
  const candidate = presets?.defaultId;
  if (candidate && ALLOWED_PRESETS.includes(candidate)) return candidate;
  return "minimal";
}

function safePresetForSession(presetId) {
  return ALLOWED_PRESETS.includes(presetId) ? presetId : "standard";
}

function agentSetup(selection, presets, presetId) {
  return async (agentCtx) => {
    installModelSelection(agentCtx, {
      current: selection,
      assembled: void 0
    });
    if (presets) await presets.mount(agentCtx, presetId);
  };
}

async function createNewAgent(ctx, out = console.log) {
  const selection = modelSelection(ctx);
  const presets = ctx.get("agentPresets");
  const presetId = safeDefaultPreset(ctx);
  const { agent } = await ctx.get("agents").create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: agentSetup(selection, presets, presetId)
  });
  out(`\n[safe] new session: ${agent.id} (preset: ${presetId})`);
  return agent;
}

async function resumeAgent(ctx, sessionId, out = console.log) {
  const selection = modelSelection(ctx);
  const presets = ctx.get("agentPresets");
  const headers = await ctx.get("sessionPersistence").list();
  const stored = headers.find((header) => header.id === sessionId)?.agentPreset;
  const presetId = safePresetForSession(stored);
  const { agent } = await ctx.get("agents").resume({
    resumeSessionId: sessionId,
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: agentSetup(selection, presets, presetId)
  });
  out(`\n[safe] resumed session: ${agent.id} (safe preset: ${presetId})`);
  return agent;
}

async function sessionTitle(persistence, id) {
  try {
    const view = typeof persistence.inspect === "function"
      ? await persistence.inspect(id)
      : await persistence.readFrom(id, 0);
    const events = view?.events ?? [];
    const last = [...events].reverse().find((event) => event.type === "session/title");
    return last?.data?.title ?? "";
  } catch {
    return "";
  }
}

async function listSessions(ctx, out = console.log, includeAll = false) {
  const persistence = ctx.get("sessionPersistence");
  const headers = await persistence.list();
  const rows = [];
  for (const header of headers) {
    const title = await sessionTitle(persistence, header.id);
    if (!includeAll && title === "") continue;
    rows.push({ header, title });
  }
  rows.sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0));
  out(includeAll ? "\nall saved sessions:" : "\nsaved conversations:");
  if (rows.length === 0) {
    out("  (none)");
    return;
  }
  for (const row of rows) {
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
  for (const event of agent.session.events) {
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

async function sendUserText(ctx, state, text, out = console.log) {
  if (state.agent === void 0) state.agent = await createNewAgent(ctx, out);
  if (state.busy) {
    state.queue.push(text);
    out("[safe] (turn is running; input queued)");
    return;
  }
  state.busy = true;
  const firstSeq = state.agent.session.seq;
  state.agent.followup(
    createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" }
    })
  );
  await state.agent.whenIdle();
  await ctx.get("sessions").flush(state.agent.session);
  state.busy = false;
  while (state.queue.length > 0) {
    const next = state.queue.shift();
    await sendUserText(ctx, state, next, out);
  }
}

async function runREPL(ctx, initialSessionId) {
  const state = {
    agent: void 0,
    busy: false,
    queue: []
  };

  const offEvent = ctx.on("session/event", (session, event) => {
    if (state.agent === void 0 || session.id !== state.agent.session.id) return;
    printEvent(event);
  });

  if (initialSessionId) {
    try {
      state.agent = await resumeAgent(ctx, initialSessionId);
      printHistoryTail(state.agent, 8);
    } catch (error) {
      console.error(`[safe] failed to resume ${initialSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      console.log("[safe] starting a new session instead.");
      state.agent = await createNewAgent(ctx);
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    prompt: "\n[safe]> "
  });

  if (!initialSessionId) {
    console.log("\n[safe] recovery TUI ready. /help for commands, /resume <id> to continue history.");
  }

  rl.prompt();
  const safePrompt = () => {
    if (!rl.closed) rl.prompt();
  };

  rl.on("line", async (line) => {
    const input = line.trim();
    rl.setPrompt("\n[safe]> ");
    if (input === "") {
      safePrompt();
      return;
    }
    if (input === "/quit" || input === "/exit" || input === "/q") {
      rl.close();
      process.exit(0);
      return;
    }
    if (input === "/help") {
      console.log(`\nsafe-mode commands:
  /resume <sessionId>   continue an existing DeepSeek session
  /new                  start a fresh session
  /list                 list titled conversations (use /list all for every session)
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
    if (input === "/list") {
      try {
        await listSessions(ctx, console.log, false);
      } catch (error) {
        console.error(`[safe] list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/list all") {
      try {
        await listSessions(ctx, console.log, true);
      } catch (error) {
        console.error(`[safe] list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input === "/new") {
      try {
        state.agent = await createNewAgent(ctx);
      } catch (error) {
        console.error(`[safe] new failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      safePrompt();
      return;
    }
    if (input.startsWith("/resume ")) {
      const id = input.slice("/resume ".length).trim();
      try {
        state.agent = await resumeAgent(ctx, id);
        printHistoryTail(state.agent, 8);
      } catch (error) {
        console.error(`[safe] resume failed: ${error instanceof Error ? error.message : String(error)}`);
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
        const hasHistory = state.agent.session.events.some((event) => event.type === "turn/start");
        console.log(`current session preset: ${currentPreset ?? "(none)"}`);
        console.log(`current session has history: ${hasHistory ? "yes (switchable with warning)" : "no"}`);
      }
      safePrompt();
      return;
    }
    if (input.startsWith("/preset ")) {
      const id = input.slice("/preset ".length).trim();
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
      const hasHistory = state.agent.session.events.some((event) => event.type === "turn/start");
      if (hasHistory) {
        console.log("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible");
      }
      try {
        const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, id);
        state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
        console.log(`[safe] now using preset: ${id}`);
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
    offEvent?.();
    process.exit(0);
  });
}

async function runTUI(ctx, initialSessionId) {
  const state = {
    agent: void 0,
    busy: false,
    queue: []
  };

  const say = (text) => tui.println(String(text));

  const tui = new TUI({
    statusProvider: () => {
      const presets = ctx.get("agentPresets");
      const selection = modelSelection(ctx);
      const currentPreset = state.agent ? presets.composedPreset(state.agent.ctx) : "none";
      return `  ${gray("safe")} · ${cyan(String(currentPreset ?? "none"))} · ${gray(`${selection.provider}/${selection.model}`)} · ${gray(process.cwd())}`;
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
      if (input === "/list") {
        try {
          await listSessions(ctx, say, false);
        } catch (error) {
          say(`${red("error")} list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/list all") {
        try {
          await listSessions(ctx, say, true);
        } catch (error) {
          say(`${red("error")} list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/new") {
        try {
          state.agent = await createNewAgent(ctx, say);
        } catch (error) {
          say(`${red("error")} new failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/resume") {
        await openSessionPicker(false);
        return;
      }
      if (input === "/resume all") {
        await openSessionPicker(true);
        return;
      }
      if (input.startsWith("/resume ")) {
        const id = input.slice("/resume ".length).trim();
        try {
          state.agent = await resumeAgent(ctx, id, say);
          printTuiHistory(state.agent, tui);
        } catch (error) {
          say(`${red("error")} resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (input === "/preset") {
        await openPresetPicker();
        return;
      }
      if (input.startsWith("/preset ")) {
        const id = input.slice("/preset ".length).trim();
        if (!ALLOWED_PRESETS.includes(id)) {
          say(`${red("error")} not allowed: ${id}; allowed: ${ALLOWED_PRESETS.join(", ")}`);
          return;
        }
        if (!state.agent) {
          say("[safe] no current session; start /new first, then switch preset.");
          return;
        }
        const hasHistory = state.agent.session.events.some((event) => event.type === "turn/start");
        if (hasHistory) {
          say(yellow("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible"));
        }
        try {
          const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, id);
          state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
          say(`[safe] now using preset: ${id}`);
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
      if (input === "/check") {
        const report = checkAll();
        const ok = printReport(report, say);
        say(ok ? "[safe] check complete." : "[safe] health problems found.");
        return;
      }

      say(`${cyan("you")}  ${input}`);

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
      if (base === "/resume") {
        await openSessionPicker(/\ball\b/i.test(command));
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
    onQuit: () => process.exit(0)
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
    const headers = await persistence.list();
    const items = [];
    for (const header of headers) {
      const title = await sessionTitle(persistence, header.id);
      if (!includeAll && title === "") continue;
      const preset = header.agentPreset ? ` · ${header.agentPreset}` : "";
      items.push({
        label: title !== "" ? title : header.id,
        value: header.id,
        detail: `${header.id} · ${header.cwd ?? "?"}${preset}`
      });
    }
    items.sort((a, b) => {
      const ia = headers.find((h) => h.id === a.value);
      const ib = headers.find((h) => h.id === b.value);
      return (Number(ib?.createdAt) || 0) - (Number(ia?.createdAt) || 0);
    });
    if (items.length === 0) {
      say(includeAll ? gray("[safe] no saved sessions") : gray("[safe] no titled conversations; use /resume all to see every saved session"));
      return;
    }
    tui.openPicker({
      title: includeAll ? "Resume session (all)" : "Resume session",
      items,
      onSelect: async (item) => {
        try {
          state.agent = await resumeAgent(ctx, item.value, say);
          printTuiHistory(state.agent, tui);
          say(`[safe] resumed ${item.value}`);
        } catch (error) {
          say(`${red("error")} resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

  const openPresetPicker = async () => {
    const items = ALLOWED_PRESETS.map((id) => ({
      label: id,
      value: id,
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
        const hasHistory = state.agent.session.events.some((event) => event.type === "turn/start");
        if (hasHistory) {
          say(yellow("[safe] warning: this session has existing turns; switching preset may make old tool calls incompatible"));
        }
        try {
          const preset = await ctx.get("agentPresets").recompose(state.agent.ctx, item.value);
          state.agent.session.append("agent-preset/selected", { agentPreset: preset.id });
          say(`[safe] now using preset: ${item.value}`);
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

  const offEvent = ctx.on("session/event", (session, event) => {
    if (state.agent !== void 0 && session.id === state.agent.session.id) tui.addEvent(event);
  });

  tui.start();

  if (initialSessionId) {
    try {
      state.agent = await resumeAgent(ctx, initialSessionId, say);
      printTuiHistory(state.agent, tui);
    } catch (error) {
      say(`${red("error")} failed to resume ${initialSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      try {
        state.agent = await createNewAgent(ctx, say);
      } catch (error2) {
        say(`${red("error")} failed to create a new session: ${error2 instanceof Error ? error2.message : String(error2)}`);
      }
    }
  }

  // Keep a reference so the event listener does not get GC'd; the TUI owns the
  // process lifetime and exits through onQuit.
  void offEvent;
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
  dsh --profile safe --repair           repair broken web client files and exit

TUI commands:
  /list /list all /resume /resume all /resume <id> /new /preset /preset <id>
  /models | /model   /models <id> | /model <id>   /add-provider   /providers
  /status /repair /check /help /quit

Safe mode loads only dsh-base + safe-tui. No user plugins, no web UI,
no user-authored presets. Only official system presets are offered:
minimal / standard / code / cordis.`;
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
