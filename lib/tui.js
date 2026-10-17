// Minimal full-screen TUI renderer for the safe-mode TUI.
// No external dependencies: raw ANSI + Node stdin key handling.
// Clean dark full-screen terminal with status line, footer shortcuts,
// single-line prompt, and a slash-command palette.

const ESC = "\x1b[";
export function reset() { return `${ESC}0m`; }
export function bold(text) { return `${ESC}1m${text}${reset()}`; }
export function dim(text) { return `${ESC}2m${text}${reset()}`; }
export function gray(text) { return `${ESC}38;5;245m${text}${reset()}`; }
export function cyan(text) { return `${ESC}38;5;75m${text}${reset()}`; }
export function green(text) { return `${ESC}38;5;114m${text}${reset()}`; }
export function yellow(text) { return `${ESC}38;5;221m${text}${reset()}`; }
export function red(text) { return `${ESC}38;5;203m${text}${reset()}`; }
export function blue(text) { return `${ESC}38;5;111m${text}${reset()}`; }

function clearScreen() { return `${ESC}2J${ESC}H`; }
function moveTo(row, col) { return `${ESC}${row};${col}H`; }
function eraseLine() { return `${ESC}2K`; }
function showCursor() { return `${ESC}?25h`; }

function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x1100 && code <= 0x115f) return 2; // Hangul Jamo
  if (code >= 0x2e80 && code <= 0xa4cf) return 2; // CJK / Yi
  if (code >= 0xac00 && code <= 0xd7a3) return 2; // Hangul
  if (code >= 0xf900 && code <= 0xfaff) return 2; // CJK Compatibility Ideographs
  if (code >= 0xfe30 && code <= 0xfe4f) return 2; // CJK Compatibility Forms
  if (code >= 0xff00 && code <= 0xff60) return 2; // Fullwidth Forms
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  if (code >= 0x1f300 && code <= 0x1faff) return 2; // Emoji (wide in most terminals)
  if (code >= 0x20000 && code <= 0x2fffd) return 2;
  return 1;
}

function visibleWidth(text) {
  const clean = String(text).replace(/\u001b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of clean) width += charWidth(ch);
  return width;
}

function truncateLine(line, width) {
  if (visibleWidth(line) <= width) return line;
  if (width <= 1) return "…";
  // 按可见格数截断，但逐段保留 ANSI 转义序列——否则超宽行会被剥成
  // 无色白字（命令面板曾因此出现"有的行白有的行蓝、选中高亮消失"）。
  const text = String(line);
  const tokens = [];
  for (const m of text.matchAll(/\u001b\[[0-9;]*m|\P{M}/gu)) tokens.push(m[0]);
  let out = "";
  let used = 0;
  for (const tok of tokens) {
    if (tok.startsWith("\x1b")) { out += tok; continue; }
    const cw = charWidth(String.fromCodePoint(tok.codePointAt(0)));
    if (used + cw > width - 1) { out += "…" + reset(); return out; }
    out += tok;
    used += cw;
  }
  return out + "…" + reset();
}

function padLine(line, width) {
  const visible = visibleWidth(line);
  if (visible > width) return truncateLine(line, width);
  return line + " ".repeat(Math.max(0, width - visible));
}

function truncateToWidth(text, max) {
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch);
    if (used + cw > max) break;
    out += ch;
    used += cw;
  }
  return out;
}

const COMMANDS = [
  // 2026-09-23: 收敛成 opencode 式"一个概念一条"。会话只留 /sessions（进去再选/
  // 恢复/删除），preset 与 model 的带参形式由各自的 picker 承担。
  // 兼容输入仍可用：/resume <id>、/list [all]、/sessions all、/preset <id>、/model <id>。
  { command: "/sessions", description: "切换会话：浏览 / 恢复 / 删除" },
  { command: "/new", description: "新建会话（发首条消息才落盘）" },
  { command: "/preset", description: "切换 preset（minimal / standard / code / cordis）" },
  { command: "/model", description: "切换模型" },
  { command: "/providers", description: "查看模型提供方" },
  { command: "/add-provider", description: "引导式添加模型提供方" },
  { command: "/status", description: "当前会话 / preset / 模型" },
  { command: "/check", description: "健康检查" },
  { command: "/clean-empty", description: "清理没有 AI 输出的空会话" },
  { command: "/help", description: "帮助与快捷键" },
  { command: "/quit", description: "退出 safe 模式" }
];

export class TUI {
  constructor(options = {}) {
    this.onSubmit = options.onSubmit ?? (async () => {});
    this.onCommandSelect = options.onCommandSelect ?? null;
    this.onQuit = options.onQuit ?? (() => {});
    this.onCancel = options.onCancel ?? null;
    this.statusProvider = options.statusProvider ?? (() => "");
    this.placeholder = options.placeholder ?? "输入消息，或 / 打开命令面板";
    this.items = [];
    this.expandedBlocks = new Set();
    this.input = "";
    this.cursor = 0;
    this.commandHistory = [];
    this.historyIndex = -1;
    this.scrollOffset = 0;
    this.scrollAccum = 0;
    this.scrollTimer = void 0;
    this.streamText = "";
    this.streamReasoning = "";
    this.streamTools = new Map();
    this.streamRenderTimer = void 0;
    this.busy = false;
    this.quitRequested = false;
    this.buffer = "";
    this.paletteOpen = false;
    this.paletteFilter = "";
    this.paletteIndex = 0;
    this.picker = null;
    this.wizardResolver = null;
    this.escapeTimer = void 0;
    this._forceClear = false;
    this._onData = (chunk) => this._handleData(chunk);
    this._onResize = () => {
      this._forceClear = true;
      this.render();
    };
  }

  get tty() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  start() {
    if (!this.tty) throw new Error("TUI requires a TTY");
    process.stdout.write(clearScreen() + "\x1b[?1049h");
    // Enable SGR mouse tracking so wheel events can scroll the history.
    process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding?.("utf8");
    process.stdin.on("data", this._onData);
    process.stdout.on("resize", this._onResize);
    this.render();
  }

  stop() {
    this._clearEscapeTimer();
    if (this.scrollTimer !== void 0) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = void 0;
    }
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdin.removeListener("data", this._onData);
    process.stdout.removeListener("resize", this._onResize);
    process.stdout.write(clearScreen() + reset() + showCursor() + "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
  }

  quit() {
    if (this.quitRequested) return;
    this.quitRequested = true;
    this.stop();
    this.onQuit();
  }

  println(text = "") {
    this.items.push({ kind: "text", text: String(text) });
    if (this.items.length > 500) this.items = this.items.slice(-500);
    if (!this.quitRequested) this.render();
  }

  _pushItem(item) {
    this.items.push(item);
    if (this.items.length > 500) this.items = this.items.slice(-500);
    if (!this.quitRequested) this.render();
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    if (!this.quitRequested) this.render();
  }

  addEvent(event) {
    if (event.type === "assistant/chunk") {
      this._handleChunk(event.data?.chunk);
      return;
    }
    if (event.type === "user/message") {
      const text = textOf(event.data?.message);
      if (text) this._pushItem({ kind: "text", role: "user", text });
      return;
    }
    if (event.type === "assistant/message") {
      this._clearStreaming();
      for (const block of messageBlocks(event.data?.message)) {
        if (block.kind === "text") {
          this._pushItem({ kind: "text", role: "assistant", text: block.text });
        } else if (block.kind === "reasoning") {
          this._pushItem({ kind: "reasoning", text: block.text });
        } else if (block.kind === "tool") {
          this._pushItem({ kind: "tool", header: block.text, details: block.text });
        } else if (block.kind === "tool-result") {
          this._pushItem({ kind: "tool-result", header: block.text, details: block.text });
        }
      }
      return;
    }
    if (event.type === "tool/result") {
      for (const block of messageBlocks(event.data?.message)) {
        if (block.kind === "tool-result") {
          this._pushItem({ kind: "tool-result", header: block.text, details: block.text });
        }
      }
      return;
    }
    if (event.type === "turn/start") this._pushItem({ kind: "text", text: `${dim("· turn started")}` });
    else if (event.type === "turn/end") {
      this._clearStreaming();
      this._pushItem({ kind: "text", text: `${dim(`· turn ended: ${event.data?.reason?.kind ?? "unknown"}`)}` });
    }
  }

  addHistoryLine(line) {
    this.println(line);
  }

  _allLines() {
    const lines = [];
    for (const item of this.items) {
      if (item.kind === "welcome") {
        for (const line of String(item.text).split("\n")) lines.push(line);
      } else if (item.kind === "text") {
        // claude/opencode 式：❯ 用户、● 助手，首行带字形、续行缩进，
        // 用户发言前空一行让轮次边界一目了然。
        if (item.role === "user" && lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        const body = String(item.text).split("\n");
        const glyph = item.role === "user" ? cyan("❯") : green("●");
        for (let i = 0; i < body.length; i += 1) {
          lines.push(i === 0 ? `${glyph} ${body[i]}` : `  ${body[i]}`);
        }
      } else if (item.kind === "reasoning") {
        if (this.expandedBlocks.has(item)) {
          for (const line of String(item.text).split("\n")) {
            lines.push(`  ${dim("✻ " + line)}`);
          }
        } else {
          const summary = summarizeText(item.text, 160);
          lines.push(`  ${dim(`✻ ${summary}`)}`);
        }
      } else if (item.kind === "tool" || item.kind === "tool-result") {
        if (this.expandedBlocks.has(item)) {
          for (const line of String(item.details ?? item.text ?? "").split("\n")) {
            lines.push(`  ${dim("⎿")} ${yellow(line)}`);
          }
        } else {
          const header = summarizeText(item.header ?? item.text ?? "", 160);
          lines.push(`  ${dim("⎿")} ${yellow(header)}`);
        }
      }
    }
    if (this.streamReasoning !== "") {
      lines.push(`  ${dim("✻ " + this.streamReasoning)}`);
    }
    for (const tool of this.streamTools.values()) {
      const shown = summarizeText(`${tool.name}(${tool.args})`, 180);
      lines.push(`  ${dim("⎿")} ${yellow(shown)}`);
    }
    if (this.streamText !== "") {
      lines.push(`${green("●")} ${this.streamText}`);
    }
    return lines;
  }

  _visualLines() {
    const cols = this._termSize().cols;
    const out = [];
    for (const line of this._allLines()) {
      for (const wrapped of wrapAnsi(line, cols)) {
        out.push(wrapped);
      }
    }
    return out;
  }

  _toggleExpand() {
    const collapsible = this.items.filter((item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "tool-result");
    if (collapsible.length === 0) return;
    const allExpanded = collapsible.every((item) => this.expandedBlocks.has(item));
    if (allExpanded) {
      for (const item of collapsible) this.expandedBlocks.delete(item);
    } else {
      for (const item of collapsible) this.expandedBlocks.add(item);
    }
    this.render();
  }

  _clearStreaming() {
    this.streamText = "";
    this.streamReasoning = "";
    this.streamTools = new Map();
    if (this.streamRenderTimer !== void 0) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = void 0;
    }
  }

  _scheduleStreamRender() {
    if (this.streamRenderTimer !== void 0) return;
    this.streamRenderTimer = setTimeout(() => {
      this.streamRenderTimer = void 0;
      if (!this.quitRequested) this.render();
    }, 30);
  }

  _handleChunk(chunk) {
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.type === "text-delta") {
      this.streamText += chunk.text ?? "";
    } else if (chunk.type === "reasoning-delta") {
      this.streamReasoning += chunk.text ?? "";
    } else if (chunk.type === "tool-call-delta") {
      let entry = this.streamTools.get(chunk.index);
      if (entry === void 0) {
        entry = { name: "", args: "" };
        this.streamTools.set(chunk.index, entry);
      }
      if (chunk.name !== void 0) entry.name = chunk.name;
      entry.args += chunk.argumentsDelta ?? "";
    } else {
      return;
    }
    this._scheduleStreamRender();
  }

  ask(question) {
    this.println(`  ${cyan("→")} ${question}`);
    return new Promise((resolve) => {
      this.wizardResolver = (answer) => {
        if (answer !== null && answer !== "") this.println(`  ${gray("·")} ${answer}`);
        resolve(answer);
      };
    });
  }

  cancelWizard() {
    if (this.wizardResolver !== null) {
      const resolve = this.wizardResolver;
      this.wizardResolver = null;
      resolve(null);
    }
  }

  render() {
    if (this.quitRequested) return;
    const cols = this._termSize().cols;
    const rows = this._termSize().rows;

    const header = this._header(cols);
    const footer = this._footer();
    const status = String(this.statusProvider() ?? "").split("\n").filter(Boolean);
    const headerLines = [];
    const footerLines = [];
    const statusLines = [];
    for (const line of header) headerLines.push(...wrapAnsi(line, cols));
    for (const line of footer) footerLines.push(...wrapAnsi(line, cols));
    for (const line of status) statusLines.push(...wrapAnsi(line, cols));
    // Palette height budget: never let the popup push the status/footer off.
    const paletteRows = Math.max(3, Math.min(9, rows - headerLines.length - statusLines.length - footerLines.length - 4));
    const palette = this.picker
      ? this._pickerLines(cols, paletteRows)
      : this.paletteOpen && this._paletteItems().length > 0
        ? this._paletteLines(this._paletteItems(), cols, paletteRows)
        : [];
    const overlay = this.picker !== null || this.paletteOpen;
    const popupHeight = palette.length;
    const available = Math.max(1, rows - headerLines.length - footerLines.length - statusLines.length - 3 - popupHeight);
    const allLines = this._visualLines();
    const maxScroll = Math.max(0, allLines.length - available);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    const end = allLines.length - this.scrollOffset;
    const start = Math.max(0, end - available);
    const shown = overlay ? [] : allLines.slice(start, end);

    const lines = [];
    lines.push(...headerLines);
    if (overlay) {
      // Clean overlay: no history behind it, but keep the panel near the
      // bottom (above status/footer) like the original layout.
      while (lines.length < headerLines.length + available) lines.push("");
      if (palette.length > 0) lines.push(...palette);
    } else {
      for (const line of shown) lines.push(line);
      while (lines.length < headerLines.length + available) lines.push("");
      if (palette.length > 0) lines.push(...palette);
    }
    lines.push(...statusLines);
    lines.push("");
    lines.push(...footerLines);

    const screenLines = lines.slice(0, rows).map((line) => padLine(line, cols));
    while (screenLines.length < rows) screenLines.push(" ".repeat(cols));
    const wantsClear = this._forceClear || overlay;
    if (wantsClear) {
      process.stdout.write(clearScreen());
      this._forceClear = false;
    }
    process.stdout.write(`${ESC}H`);
    process.stdout.write(screenLines.join("\n"));

    const inputRow = headerLines.length + available + palette.length + statusLines.length + 1;
    this._drawPrompt(inputRow, cols);
  }

  _header(cols) {
    // claude/opencode 式：单行品牌头，不画通栏横线（那会让界面显得又空又土）。
    return [`  ${blue("✻")} ${bold("DeepSeek Harness")} ${dim("· safe mode")}`];
  }

  /** claude 式欢迎卡片，开屏时打印进历史区（随后自然滚走）。 */
  printWelcome({ model = "", cwd = "", preset = "" } = {}) {
    const cols = this._termSize().cols;
    const W = Math.min(58, Math.max(38, cols - 6));
    const inner = W - 2;
    const row = (label, value) => `${gray("│")}${padLine(`  ${dim(label)}  ${value}`, inner)}${gray("│")}`;
    const blank = `${gray("│")}${" ".repeat(inner)}${gray("│")}`;
    const lines = [
      gray("╭" + "─".repeat(inner) + "╮"),
      `${gray("│")}${padLine(`  ${cyan("◆")} ${bold("DeepSeek Harness")} ${dim("· Safe Mode")}`, inner)}${gray("│")}`,
      blank,
      row("模型", model),
      row("目录", cwd),
      row("预设", preset),
      blank,
      row("提示", `${dim("/")} 命令面板  ${dim("·")}  ${dim("/resume")} 恢复会话  ${dim("·")}  ${dim("/help")} 帮助`),
      gray("╰" + "─".repeat(inner) + "╯")
    ];
    this._pushItem({ kind: "welcome", text: lines.join("\n") });
  }

  _footer() {
    // opencode 式极简页脚：不枚举命令，只给入口提示。
    const lines = [
      `  ${gray("/new")}   ${gray("/sessions")}   ${gray("/preset")}   ${gray("/models")}   ${gray("/status")}   ${gray("/repair")}   ${gray("/check")}   ${gray("/help")}   ${gray("/quit")}`,
      `  ${dim("safe mode · official system presets only · no user plugins · type / for commands · ctrl+o expand/collapse details")}`,
    ];
    if (this.scrollOffset > 0) {
      lines.push(`  ${dim(`· scrolled up ${this.scrollOffset} lines · ↑/↓ or PgUp/PgDn to browse`)}`);
    }
    if (this.busy) {
      lines.push(`  ${dim("· ctrl+c or esc to cancel current generation")}`);
    }
    return lines;
  }

  _drawPrompt(row, cols) {
    const prompt = `${blue("❯")} `;
    // The window over the input is measured in VISIBLE columns so wide
    // (CJK/emoji) input can never overflow the prompt row.
    const maxVisible = Math.max(1, cols - 3);
    let left = this.cursor;
    let right = this.cursor;
    let leftUsed = 0;
    let rightUsed = 0;
    const widthAt = (index) => charWidth(this.input[index] ?? " ");
    while (right < this.input.length && leftUsed + rightUsed + widthAt(right) <= maxVisible) {
      rightUsed += widthAt(right);
      right += 1;
    }
    while (left > 0 && leftUsed + widthAt(left - 1) + rightUsed <= maxVisible) {
      leftUsed += widthAt(left - 1);
      left -= 1;
    }
    const shownInput = this.input.slice(left, right);
    let promptText;
    if (this.input === "" && this.busy) {
      promptText = `${prompt}${gray("running…")}`;
    } else if (this.input === "") {
      promptText = `${prompt}${gray(this.placeholder)}`;
    } else {
      promptText = `${prompt}${shownInput}`;
    }
    process.stdout.write(moveTo(row, 1) + eraseLine() + promptText);
    // Prompt visible width is exactly 2 (glyph + space); CJK chars count 2.
    const cursorCol = 3 + leftUsed;
    process.stdout.write(moveTo(row, Math.max(1, cursorCol)) + showCursor());
  }

  // ── command palette ──────────────────────────────────────────────

  _paletteItems() {
    const filter = this.paletteFilter.toLowerCase();
    return COMMANDS.filter((entry) => {
      const first = entry.command.split(/\s+/)[0].toLowerCase();
      return first.startsWith("/" + filter);
    });
  }

  _openPalette() {
    this.paletteOpen = true;
    this.paletteFilter = "";
    this.paletteIndex = 0;
  }

  _closePalette() {
    this.paletteOpen = false;
    this.paletteFilter = "";
    this.paletteIndex = 0;
  }

  _updatePalette() {
    if (!this.paletteOpen) return;
    this.paletteFilter = this.input.startsWith("/") ? this.input.slice(1) : "";
    const items = this._paletteItems();
    if (this.paletteIndex >= items.length) this.paletteIndex = Math.max(0, items.length - 1);
  }

  _palettePrev() {
    const items = this._paletteItems();
    if (items.length === 0) return;
    this.paletteIndex = this.paletteIndex <= 0 ? items.length - 1 : this.paletteIndex - 1;
    this.render();
  }

  _paletteNext() {
    const items = this._paletteItems();
    if (items.length === 0) return;
    this.paletteIndex = this.paletteIndex >= items.length - 1 ? 0 : this.paletteIndex + 1;
    this.render();
  }

  _selectPalette() {
    const items = this._paletteItems();
    if (items.length === 0) {
      this._closePalette();
      this.render();
      return;
    }
    const item = items[Math.min(this.paletteIndex, items.length - 1)];
    // Args-taking commands (e.g. "/resume <id>") fill the prompt with a space so
    // the id can be typed, like opencode's arg flow.
    if (item.args) {
      this.input = item.command.replace(/\s*<[^>]*>/g, "") + " ";
      this.cursor = this.input.length;
      this._closePalette();
      this.render();
      return;
    }
    this.input = "";
    this.cursor = 0;
    this._closePalette();
    this.render();
    const handler = this.onCommandSelect ?? this.onSubmit;
    Promise.resolve(handler(item.command)).catch((error) => {
      this.println(`${red("error")}  ${String(error?.stack ?? error)}`);
    });
  }

  // ── item picker (second-stage selection) ─────────────────────────

  openPicker({ title, items, onSelect, onDelete, filterable = false } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    const normalized = items.map((item) => typeof item === "string" ? { label: item, value: item } : item);
    this.picker = {
      title: title ?? "Select",
      items: normalized,
      index: 0,
      onSelect,
      onDelete,
      showDetails: false,
      filterable: Boolean(filterable),
      filter: ""
    };
    this.paletteOpen = false;
    this.render();
  }

  closePicker() {
    this.picker = null;
    this.render();
  }

  _pickerItems() {
    if (!this.picker) return [];
    if (!this.picker.filterable || this.picker.filter.trim() === "") return this.picker.items;
    const q = this.picker.filter.trim().toLowerCase();
    return this.picker.items.filter((item) => !item.group && String(item.label ?? item.value ?? "").toLowerCase().includes(q));
  }

  _pickerPrev() {
    const items = this._pickerItems();
    if (this.picker === null || items.length === 0) return;
    let next = this.picker.index;
    for (let i = 0; i < items.length; i += 1) {
      next = (next - 1 + items.length) % items.length;
      if (!items[next].group) {
        this.picker.index = next;
        break;
      }
    }
    this.render();
  }

  _pickerNext() {
    const items = this._pickerItems();
    if (this.picker === null || items.length === 0) return;
    let next = this.picker.index;
    for (let i = 0; i < items.length; i += 1) {
      next = (next + 1) % items.length;
      if (!items[next].group) {
        this.picker.index = next;
        break;
      }
    }
    this.render();
  }

  _selectPicker() {
    if (this.picker === null) return;
    const items = this._pickerItems();
    if (items.length === 0) {
      this.closePicker();
      return;
    }
    const item = items[Math.min(this.picker.index, items.length - 1)];
    if (item.group) {
      // Group headers are display-only; pressing Enter keeps the picker open.
      this.render();
      return;
    }
    const onSelect = this.picker.onSelect;
    this.picker = null;
    this.render();
    Promise.resolve(onSelect?.(item)).catch((error) => {
      this.println(`${red("error")}  ${String(error?.stack ?? error)}`);
    });
  }

  _pickerLines(cols, maxRows = 16) {
    const boxWidth = Math.min(cols - 4, 76);
    const allItems = this._pickerItems();
    // 行数预算：标题 + 过滤行 + 分类头 + 详情行 + 提示行 + 盒子上下边都要占行，
    // 否则矮终端里 picker 会把状态行/页脚顶出屏幕。
    const extras = 2 + (this.picker?.filterable ? 1 : 0) + (this.picker?.showDetails ? 1 : 0);
    let catCount = 0;
    let lastCatScan;
    for (const it of allItems) {
      if (it.category && it.category !== lastCatScan) { catCount += 1; lastCatScan = it.category; }
    }
    const budget = Math.max(3, maxRows - extras - catCount);
    const visibleCount = Math.min(allItems.length, 10, budget);
    const total = allItems.length;
    let start = 0;
    if (total > visibleCount) {
      start = Math.max(0, Math.min((this.picker?.index ?? 0) - Math.floor(visibleCount / 2), total - visibleCount));
    }
    const items = allItems.slice(start, start + visibleCount);
    const lines = [];
    const title = this.picker?.title ?? "Select";
    const range = total > visibleCount ? ` ${start + 1}-${start + visibleCount}/${total}` : ` ${total}/${total}`;
    const titleText = ` ${title}${gray(range)} `;
    const horizontal = "─".repeat(Math.max(1, boxWidth - visibleWidth(titleText) - 2));
    lines.push(`  ${gray("┌")}${gray(titleText)}${gray(horizontal)}${gray("┐")}`);

    if (this.picker?.filterable) {
      const filterText = this.picker.filter === "" ? `  ${gray("type to filter")}` : `  ${cyan(this.picker.filter)}`;
      const visibleFilter = visibleWidth(filterText);
      const pad = Math.max(0, boxWidth - 2 - visibleFilter);
      lines.push(`  ${gray("│")}${filterText}${" ".repeat(pad)}${gray("│")}`);
    }

    let lastCategory;
    for (let offset = 0; offset < items.length; offset += 1) {
      const item = items[offset];
      const selected = start + offset === this.picker?.index;
      if (item.category && item.category !== lastCategory) {
        const cat = `  ${dim(item.category)}  `;
        const visibleCat = visibleWidth(cat);
        const padCat = Math.max(0, boxWidth - 2 - visibleCat);
        lines.push(`  ${gray("│")}${cat}${" ".repeat(padCat)}${gray("│")}`);
        lastCategory = item.category;
      }
      let label = (item.current ? "● " : "") + String(item.label ?? item.value ?? "");
      const innerWidth = boxWidth - 2;
      const footer = item.footer ? String(item.footer) : "";
      const footerMax = Math.max(6, Math.floor(innerWidth / 3));
      let footerText = footer;
      if (visibleWidth(footerText) > footerMax) {
        footerText = truncateToWidth(footerText, footerMax) + "…";
      }
      const footerW = visibleWidth(footerText);
      const leftMax = Math.max(4, innerWidth - footerW - 1);
      if (visibleWidth(label) > leftMax) label = truncateToWidth(label, leftMax) + "…";
      const leftW = visibleWidth(label);
      const spaces = " ".repeat(Math.max(1, innerWidth - leftW - footerW));
      const inner = label + spaces + footerText;
      if (selected) {
        const styled = `${ESC}48;5;237m${ESC}97m${inner}${reset()}`;
        lines.push(`  ${gray("│")}${styled}${gray("│")}`);
      } else {
        lines.push(`  ${gray("│")}${inner}${gray("│")}`);
      }
    }
    lines.push(`  ${gray("└")}${gray("─".repeat(boxWidth - 2))}${gray("┘")}`);
    if (this.picker?.showDetails) {
      const current = allItems[this.picker?.index ?? 0];
      const detail = current?.detail ? String(current.detail) : "(no detail)";
      const maxDetail = Math.max(4, boxWidth - 8);
      const shown = visibleWidth(detail) > maxDetail - 1 ? truncateToWidth(detail, maxDetail - 1) + "…" : detail;
      lines.push(`  ${cyan("ℹ")} ${gray(shown)}`);
    }
    const hint = this.picker?.filterable
      ? `type to filter · ↑/↓ select · enter choose · ${this.picker.onDelete ? "ctrl+x delete · " : ""}esc cancel`
      : "↑/↓ select · enter choose · i/? details · esc cancel";
    lines.push(`  ${gray(hint)}`);
    return lines;
  }

  /**
   * 2026-09-23: opencode 风格面板——无重边框、整行高亮条、按屏高裁剪、
   * 右上角计数与上下指示。旧的"大边框盒子"在矮终端里会压住页脚。
   */
  _paletteLines(items, cols, maxRows = 8) {
    const total = items.length;
    const width = Math.min(Math.max(24, cols - 4), 78);
    const visibleCount = Math.max(3, Math.min(maxRows, total));
    let start = 0;
    if (total > visibleCount) {
      start = Math.max(0, Math.min(this.paletteIndex - Math.floor(visibleCount / 2), total - visibleCount));
    }
    const visible = items.slice(start, start + visibleCount);
    const cmdWidth = Math.min(20, Math.max(...items.map((entry) => entry.command.length)) + 2);
    const lines = [];
    const right = `${this.paletteIndex + 1}/${total}${start > 0 ? " ↑" : " "}${start + visibleCount < total ? "↓" : " "}`;
    const titlePad = " ".repeat(Math.max(1, width - "commands".length - right.length - 2));
    lines.push(` ${gray("commands")}${titlePad}${gray(right)} `);

    for (let offset = 0; offset < visible.length; offset += 1) {
      const item = visible[offset];
      const selected = start + offset === this.paletteIndex;
      const spaceAt = item.command.indexOf(" ");
      const head = spaceAt > 0 ? item.command.slice(0, spaceAt) : item.command;
      const tail = spaceAt > 0 ? item.command.slice(spaceAt) : "";
      const cmdCells = visibleWidth(item.command);
      // 描述可用宽度按渲染格数算（CJK 占 2），否则行超宽换行、整帧错位。
      const descRoom = Math.max(6, width - cmdWidth - 4);
      const descText = visibleWidth(item.description) > descRoom
        ? truncateToWidth(item.description, descRoom - 1) + "…"
        : item.description;
      const cmdPad = " ".repeat(Math.max(0, cmdWidth - cmdCells));
      // 行结构 = 1 格前导 + cmdWidth 对齐列 + 描述 + 补齐，全部按渲染格数算。
      const pad = " ".repeat(Math.max(0, width - 1 - cmdWidth - visibleWidth(descText)));
      if (selected) {
        lines.push(`${ESC}48;5;236m${ESC}1m${ESC}97m ${head}${ESC}22m${ESC}38;5;252m${tail}${cmdPad}${descText}${pad}${reset()}`);
      } else {
        lines.push(` ${cyan(head)}${gray(tail)}${cmdPad}${gray(descText)}${pad}`);
      }
    }
    return lines;
  }

  // ── input handling ───────────────────────────────────────────────

  _applyExternalResize(cols, rows) {
    this._overrideCols = Math.max(20, cols);
    this._overrideRows = Math.max(8, rows);
    this._forceClear = true;
    this.scrollOffset = 0;
    this.render();
  }

  _termSize() {
    return {
      cols: this._overrideCols ?? Math.max(20, process.stdout.columns || 80),
      rows: this._overrideRows ?? Math.max(8, process.stdout.rows || 24)
    };
  }

  _clearEscapeTimer() {
    if (this.escapeTimer !== void 0) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = void 0;
    }
  }

  _scheduleEscape() {
    this._clearEscapeTimer();
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = void 0;
      this.buffer = this.buffer.replace(/^\x1b/, "");
      this._handleEscape("\x1b");
    }, 80);
  }

  _handleData(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (this.buffer === "\x1b") {
      this._scheduleEscape();
      return;
    }
    this._clearEscapeTimer();
    while (this.buffer.length > 0) {
      // bridge 在 Windows conpty 下无法让子进程 stdout 触发 resize 事件，
      // 改用带内转义序列通报新尺寸（见 console-bridge.js 的 resize 处理）。
      const customResize = this.buffer.match(/^\x1b\|(\d+);(\d+)\|R/);
      if (customResize) {
        this.buffer = this.buffer.slice(customResize[0].length);
        this._applyExternalResize(Number(customResize[1]), Number(customResize[2]));
        continue;
      }
      if (this.buffer[0] === "\x1b") {
        const mouse = this.buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (mouse) {
          this.buffer = this.buffer.slice(mouse[0].length);
          this._handleMouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4]);
          continue;
        }
        let match = this.buffer.match(/^\x1b\[([0-9;?]*)([A-Za-z~])/);
        if (!match) match = this.buffer.match(/^\x1bO([A-Z])/);
        if (!match) {
          if (this.buffer === "\x1b") {
            // Bare ESC: wait a moment for a possible multi-byte sequence.
            this._scheduleEscape();
          } else {
            // Unknown or unterminated sequence: drop the ESC and keep
            // processing what follows, so input can never wedge permanently.
            this.buffer = this.buffer.slice(1);
            this._handleEscape("\x1b");
          }
          return;
        }
        const seq = match[0];
        this.buffer = this.buffer.slice(seq.length);
        this._handleEscape(seq);
      } else {
        // Consume a full code point so surrogate pairs (emoji) survive.
        const size = this.buffer.codePointAt(0) > 0xffff ? 2 : 1;
        const ch = this.buffer.slice(0, size);
        this.buffer = this.buffer.slice(size);
        this._handleChar(ch);
      }
    }
  }

  _handleMouse(button, x, y, kind) {
    // SGR mouse: 64 = wheel up, 65 = wheel down.
    // Up wheel scrolls to older content (positive offset), down wheel to newer.
    if (button === 64) {
      this._queueScroll(3);
    } else if (button === 65) {
      this._queueScroll(-3);
    }
    return;
  }

  _queueScroll(delta) {
    this.scrollAccum += delta;
    if (this.scrollTimer !== void 0) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = void 0;
      const amount = this.scrollAccum;
      this.scrollAccum = 0;
      this._scrollHistory(amount);
    }, 16);
  }

  _handleEscape(seq) {
    if (seq === "\x1b[A" || seq === "\x1bOA") {
      if (this.picker !== null) this._pickerPrev();
      else if (this.paletteOpen) this._palettePrev();
      else this._historyPrev();
    } else if (seq === "\x1b[B" || seq === "\x1bOB") {
      if (this.picker !== null) this._pickerNext();
      else if (this.paletteOpen) this._paletteNext();
      else this._historyNext();
    } else if (seq === "\x1b[D" || seq === "\x1bOD") {
      if (this.picker === null && this.cursor > 0) this.cursor -= 1;
      this.render();
    } else if (seq === "\x1b[C" || seq === "\x1bOC") {
      if (this.picker === null && this.cursor < this.input.length) this.cursor += 1;
      this.render();
    } else if (seq === "\x1b[H" || seq === "\x1b[1~") {
      if (this.picker === null) this.cursor = 0;
      this.render();
    } else if (seq === "\x1b[F" || seq === "\x1b[4~") {
      if (this.picker === null) this.cursor = this.input.length;
      this.render();
    } else if (seq === "\x1b[3~") {
      if (this.picker === null && this.cursor < this.input.length) {
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
      }
      if (this.paletteOpen) this._updatePalette();
      this.render();
    } else if (seq === "\x1b[5~") {
      // PgUp scrolls to older content (larger offset), PgDn to newer.
      this._scrollHistory(10);
    } else if (seq === "\x1b[6~") {
      this._scrollHistory(-10);
    } else if (seq === "\x1b") {
      if (this.wizardResolver !== null) {
        this.cancelWizard();
        this.render();
      } else if (this.picker !== null) {
        this.closePicker();
      } else if (this.paletteOpen) {
        this._closePalette();
        this.render();
      } else if (this.busy && this.onCancel) {
        this.onCancel();
      }
    }
  }

  _handleChar(ch) {
    if (ch === "\r" || ch === "\n") {
      if (this.wizardResolver !== null) {
        const answer = this.input;
        this.input = "";
        this.cursor = 0;
        const resolve = this.wizardResolver;
        this.wizardResolver = null;
        this.render();
        resolve(answer);
        return;
      }
      if (this.picker !== null) {
        this._selectPicker();
        return;
      }
      if (this.paletteOpen) {
        this._selectPalette();
        return;
      }
      const line = this.input;
      this.input = "";
      this.cursor = 0;
      if (line.trim() !== "") {
        if (this.commandHistory[this.commandHistory.length - 1] !== line) {
          this.commandHistory.push(line);
        }
        this.historyIndex = -1;
        this.render();
        Promise.resolve(this.onSubmit(line)).catch((error) => {
          this.println(`${red("error")}  ${String(error?.stack ?? error)}`);
        });
        return;
      }
      this.render();
      return;
    }
    if (ch === "\x03") {
      if (this.busy && this.onCancel) {
        this.onCancel();
      } else {
        this.quit();
      }
      return;
    }
    if (ch === "\x0f") {
      this._toggleExpand();
      return;
    }
    if (ch === "\x18") {
      if (this.picker !== null && this.picker.filterable && this.picker.onDelete) {
        const items = this._pickerItems();
        const item = items[Math.min(this.picker.index, items.length - 1)];
        if (item && !item.group) {
          Promise.resolve(this.picker.onDelete(item)).catch((error) => {
            this.println(`${red("error")}  ${String(error?.stack ?? error)}`);
          });
        }
      }
      return;
    }
    if (ch === "\x04") {
      if (this.input === "") this.quit();
      return;
    }
    if (ch === "\x7f" || ch === "\b") {
      if (this.picker !== null) {
        if (this.picker.filterable) {
          this.picker.filter = this.picker.filter.slice(0, -1);
          this.picker.index = 0;
        }
        this.render();
        return;
      }
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor -= 1;
      }
      if (this.paletteOpen) {
        if (this.input === "" || this.input[0] !== "/") this._closePalette();
        else this._updatePalette();
      }
      this.render();
      return;
    }
    if (ch === "\t") {
      if (this.picker !== null) this._selectPicker();
      else if (this.paletteOpen) this._selectPalette();
      return;
    }
    if (ch === "\x1b") {
      if (this.wizardResolver !== null) {
        this.cancelWizard();
        return;
      }
      if (this.picker !== null) {
        this.closePicker();
      } else if (this.paletteOpen) {
        this._closePalette();
        this.render();
      }
      return;
    }
    if (ch >= " " && ch !== "\x7f") {
      if (this.picker !== null) {
        if (this.picker.filterable) {
          this.picker.filter += ch;
          this.picker.index = 0;
        } else {
          const lower = ch.toLowerCase();
          if (lower === "i" || lower === "?" || lower === "d") {
            this.picker.showDetails = !this.picker.showDetails;
          }
        }
        this.render();
        return;
      }
      this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
      this.cursor += 1;
      if (this.wizardResolver === null && this.input === "/" && this.cursor === 1) {
        this._openPalette();
      } else if (this.wizardResolver === null && this.paletteOpen) {
        this._updatePalette();
      }
      this.render();
    }
  }

  _scrollHistory(delta) {
    const rows = this._termSize().rows;
    const cols = this._termSize().cols;
    const header = this._header(cols);
    const footer = this._footer();
    const status = String(this.statusProvider() ?? "").split("\n").filter(Boolean);
    const paletteRows = Math.max(3, Math.min(9, rows - 8));
    const palette = this.picker
      ? this._pickerLines(cols, paletteRows)
      : this.paletteOpen && this._paletteItems().length > 0
        ? this._paletteLines(this._paletteItems(), cols, paletteRows)
        : [];
    let headerLen = 0;
    let footerLen = 0;
    let statusLen = 0;
    for (const line of header) headerLen += wrapAnsi(line, cols).length;
    for (const line of footer) footerLen += wrapAnsi(line, cols).length;
    for (const line of status) statusLen += wrapAnsi(line, cols).length;
    const available = Math.max(1, rows - headerLen - footerLen - statusLen - 3 - palette.length);
    const maxScroll = Math.max(0, this._visualLines().length - available);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + delta));
    this.render();
  }

  _historyPrev() {
    if (this.input === "") {
      // ↑ with empty input scrolls to older content, matching the wheel.
      this._scrollHistory(1);
      return;
    }
    if (this.commandHistory.length === 0) return;
    if (this.historyIndex < 0) this.historyIndex = this.commandHistory.length - 1;
    else if (this.historyIndex > 0) this.historyIndex -= 1;
    this.input = this.commandHistory[this.historyIndex] ?? "";
    this.cursor = this.input.length;
    this.render();
  }

  _historyNext() {
    if (this.input === "") {
      this._scrollHistory(-1);
      return;
    }
    if (this.historyIndex < 0) return;
    this.historyIndex += 1;
    if (this.historyIndex >= this.commandHistory.length) {
      this.historyIndex = -1;
      this.input = "";
    } else {
      this.input = this.commandHistory[this.historyIndex] ?? "";
    }
    this.cursor = this.input.length;
    this.render();
  }
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function messageBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const out = [];
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      out.push({ kind: "text", text: block.text });
    } else if (block?.type === "reasoning" && block.text) {
      out.push({ kind: "reasoning", text: block.text });
    } else if (block?.type === "tool-call") {
      const args = String(block.arguments ?? "").trim();
      const shown = args.length > 180 ? args.slice(0, 177) + "…" : args;
      out.push({ kind: "tool", text: `${block.name}(${shown})` });
    } else if (block?.type === "tool-result") {
      const result = contentText(block.content ?? []);
      const shown = result.length > 300 ? result.slice(0, 297) + "…" : result;
      out.push({ kind: "tool-result", text: shown || "(empty)" });
    }
  }
  return out;
}

function contentText(content) {
  let text = "";
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === "text") text += block.text;
    else if (block?.type === "tool-result") text += contentText(block.content ?? []);
  }
  return text;
}

function summarizeText(text, max = 160) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let cut = clean.lastIndexOf(" ", max);
  if (cut < Math.floor(max * 0.6)) cut = max;
  return clean.slice(0, cut).trimEnd() + "…";
}

function wrapAnsi(text, width) {
  const result = [];
  let current = "";
  let visible = 0;
  let prefix = "";
  let i = 0;
  const pushLine = () => {
    result.push(current);
    current = prefix;
    visible = 0;
  };
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (match) {
        const seq = match[0];
        current += seq;
        if (/^(\x1b\[0m|\x1b\[39m|\x1b\[49m)$/.test(seq)) prefix = "";
        else prefix += seq;
        i += seq.length;
        continue;
      }
      current += text[i];
      i += 1;
      continue;
    }
    const code = text.codePointAt(i);
    const ch = String.fromCodePoint(code);
    const step = ch.length;
    if (ch === "\n") {
      pushLine();
      i += step;
      continue;
    }
    const cw = charWidth(ch);
    if (visible > 0 && visible + cw > width) pushLine();
    current += ch;
    visible += cw;
    i += step;
    if (visible >= width) pushLine();
  }
  if (current !== "") result.push(current);
  return result;
}
