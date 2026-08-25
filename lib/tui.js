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
  const clean = String(line).replace(/\u001b\[[0-9;]*m/g, "");
  if (visibleWidth(clean) <= width) return line;
  if (width <= 1) return "…";
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const cw = charWidth(ch);
    if (used + cw > width - 1) break;
    out += ch;
    used += cw;
  }
  if (line.includes("\x1b")) out += reset();
  return out + "…";
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
  { command: "/sessions", description: "Open sessions history (list + resume + delete)" },
  { command: "/sessions all", description: "Open all saved sessions including untitled" },
  { command: "/list", description: "Alias of /sessions" },
  { command: "/list all", description: "Alias of /sessions all" },
  { command: "/resume <id>", description: "Resume a session by id" },
  { command: "/resume all", description: "Alias of /sessions all" },
  { command: "/new", description: "Start a fresh session" },
  { command: "/preset", description: "Show current preset" },
  { command: "/preset <id>", description: "Switch preset: minimal / standard / code / cordis" },
  { command: "/model", description: "List available models" },
  { command: "/model <id>", description: "Switch default model" },
  { command: "/models", description: "Alias of /model" },
  { command: "/models <id>", description: "Switch default model (alias)" },
  { command: "/add-provider", description: "Add an LLM provider via guided setup" },
  { command: "/providers", description: "List active model providers" },
  { command: "/status", description: "Session / preset / model status" },
  { command: "/repair", description: "Repair broken web client files" },
  { command: "/check", description: "Health check" },
  { command: "/clean", description: "Delete empty sessions with no AI output" },
  { command: "/help", description: "Show help" },
  { command: "/quit", description: "Exit safe mode" },
  { command: "/exit", description: "Alias of /quit" }
];

export class TUI {
  constructor(options = {}) {
    this.onSubmit = options.onSubmit ?? (async () => {});
    this.onCommandSelect = options.onCommandSelect ?? null;
    this.onQuit = options.onQuit ?? (() => {});
    this.onCancel = options.onCancel ?? null;
    this.statusProvider = options.statusProvider ?? (() => "");
    this.placeholder = options.placeholder ?? "Ask anything... (/ for commands)";
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
    this._onData = (chunk) => this._handleData(chunk);
    this._onResize = () => this.render();
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
      if (text) this._pushItem({ kind: "text", text: `${cyan("you")}  ${text}` });
      return;
    }
    if (event.type === "assistant/message") {
      this._clearStreaming();
      for (const block of messageBlocks(event.data?.message)) {
        if (block.kind === "text") {
          this._pushItem({ kind: "text", text: `${green("dsh")}  ${block.text}` });
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
      if (item.kind === "text") {
        for (const line of String(item.text).split("\n")) lines.push(line);
      } else if (item.kind === "reasoning") {
        if (this.expandedBlocks.has(item)) {
          for (const line of String(item.text).split("\n")) {
            lines.push(`  ${dim("💭 " + line)}`);
          }
        } else {
          const summary = summarizeText(item.text, 160);
          lines.push(`  ${dim(`+ Thought: ${summary}`)}  ${dim("(ctrl+o to expand)")}`);
        }
      } else if (item.kind === "tool" || item.kind === "tool-result") {
        if (this.expandedBlocks.has(item)) {
          for (const line of String(item.details ?? item.text ?? "").split("\n")) {
            lines.push(`  ${yellow(line)}`);
          }
        } else {
          const header = summarizeText(item.header ?? item.text ?? "", 160);
          lines.push(`  ${yellow(`⚙ ${header}`)}  ${dim("(ctrl+o to expand)")}`);
        }
      }
    }
    if (this.streamReasoning !== "") {
      lines.push(`  ${dim("💭 " + this.streamReasoning)}`);
    }
    for (const tool of this.streamTools.values()) {
      const shown = summarizeText(`${tool.name}(${tool.args})`, 180);
      lines.push(`  ${yellow("⚙ " + shown)}`);
    }
    if (this.streamText !== "") {
      lines.push(`${green("dsh")}  ${this.streamText}`);
    }
    return lines;
  }

  _visualLines() {
    const cols = Math.max(20, process.stdout.columns || 80);
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
    const cols = Math.max(20, process.stdout.columns || 80);
    const rows = Math.max(8, process.stdout.rows || 24);

    const header = this._header(cols);
    const footer = this._footer();
    const status = String(this.statusProvider() ?? "").split("\n").filter(Boolean);
    const headerLines = [];
    const footerLines = [];
    const statusLines = [];
    for (const line of header) headerLines.push(...wrapAnsi(line, cols));
    for (const line of footer) footerLines.push(...wrapAnsi(line, cols));
    for (const line of status) statusLines.push(...wrapAnsi(line, cols));
    const palette = this.picker
      ? this._pickerLines(cols)
      : this.paletteOpen && this._paletteItems().length > 0
        ? this._paletteLines(this._paletteItems(), cols)
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
    if (overlay) process.stdout.write(clearScreen());
    process.stdout.write(`${ESC}H`);
    process.stdout.write(screenLines.join("\n"));

    const inputRow = headerLines.length + available + palette.length + statusLines.length + 1;
    this._drawPrompt(inputRow, cols);
  }

  _header(cols) {
    return [
      `  ${cyan("◆")} ${bold("DeepSeek Harness")} ${gray("· Safe Mode")}`,
      `  ${gray("─".repeat(Math.max(1, cols - 4)))}`
    ];
  }

  _footer() {
    const lines = [
      `  ${gray("/list")}   ${gray("/resume <id>")}   ${gray("/new")}   ${gray("/preset")}   ${gray("/models")}   ${gray("/status")}   ${gray("/repair")}   ${gray("/check")}   ${gray("/help")}   ${gray("/quit")}`,
      `  ${dim("safe mode · official system presets only · no user plugins · type / for commands · ctrl+o expand/collapse details")}`
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
    const maxInput = Math.max(1, cols - 2 - 1);
    let start = 0;
    if (this.input.length > maxInput) {
      start = Math.max(0, this.cursor > maxInput ? this.cursor - maxInput + 1 : this.input.length - maxInput);
    }
    const shownInput = this.input.slice(start, start + maxInput);
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
    const before = this.input.slice(start, this.cursor);
    const cursorCol = 3 + visibleWidth(before);
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

  _pickerLines(cols) {
    const boxWidth = Math.min(cols - 4, 76);
    const allItems = this._pickerItems();
    const visibleCount = Math.min(allItems.length, 10);
    const total = allItems.length;
    let start = 0;
    if (total > visibleCount) {
      start = Math.max(0, Math.min((this.picker?.index ?? 0) - Math.floor(visibleCount / 2), total - visibleCount));
    }
    const items = allItems.slice(start, start + visibleCount);
    const lines = [];
    const title = this.picker?.title ?? "Select";
    const titleText = ` ${title} `;
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

  _paletteLines(items, cols) {
    const boxWidth = Math.min(cols - 4, 70);
    const visibleCount = Math.min(items.length, 8);
    const total = items.length;
    let start = 0;
    if (total > visibleCount) {
      start = Math.max(0, Math.min(this.paletteIndex - Math.floor(visibleCount / 2), total - visibleCount));
    }
    const visible = items.slice(start, start + visibleCount);
    const maxDesc = Math.max(4, boxWidth - 24);
    const lines = [];
    lines.push(`  ${gray("┌")}${gray("─".repeat(boxWidth - 2))}${gray("┐")}`);
    for (let offset = 0; offset < visible.length; offset += 1) {
      const item = visible[offset];
      const selected = start + offset === this.paletteIndex;
      const command = item.command.padEnd(20);
      let desc = item.description;
      if (desc.length > maxDesc) desc = desc.slice(0, maxDesc - 1) + "…";
      const inner = ` ${command}${desc} `;
      const padded = inner.length < boxWidth - 2 ? inner + " ".repeat(boxWidth - 2 - inner.length) : inner.slice(0, boxWidth - 2);
      if (selected) {
        const styled = `${ESC}48;5;237m${ESC}97m${padded}${reset()}`;
        lines.push(`  ${gray("│")}${styled}${gray("│")}`);
      } else {
        const styled = `${cyan(item.command.split(/\s+/)[0])}${gray(item.command.slice(item.command.indexOf(" ") > 0 ? item.command.indexOf(" ") : item.command.length))} ${gray(desc)}`;
        const inner2 = ` ${styled} `;
        const visibleInner = inner2.replace(/\u001b\[[0-9;]*m/g, "").length;
        const pad = Math.max(0, boxWidth - 2 - visibleInner);
        lines.push(`  ${gray("│")}${inner2}${" ".repeat(pad)}${gray("│")}`);
      }
    }
    lines.push(`  ${gray("└")}${gray("─".repeat(boxWidth - 2))}${gray("┘")}`);
    return lines;
  }

  // ── input handling ───────────────────────────────────────────────

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
          if (this.buffer === "\x1b") this._scheduleEscape();
          return;
        }
        const seq = match[0];
        this.buffer = this.buffer.slice(seq.length);
        this._handleEscape(seq);
      } else {
        const ch = this.buffer[0];
        this.buffer = this.buffer.slice(1);
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
      this._scrollHistory(-10);
    } else if (seq === "\x1b[6~") {
      this._scrollHistory(10);
    } else if (seq === "\x1b") {
      if (this.picker !== null) {
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
    const rows = Math.max(8, process.stdout.rows || 24);
    const cols = Math.max(20, process.stdout.columns || 80);
    const header = this._header(cols);
    const footer = this._footer();
    const status = String(this.statusProvider() ?? "").split("\n").filter(Boolean);
    const palette = this.picker
      ? this._pickerLines(cols)
      : this.paletteOpen && this._paletteItems().length > 0
        ? this._paletteLines(this._paletteItems(), cols)
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
      this._scrollHistory(-1);
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
      this._scrollHistory(1);
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
        if (/^(\x1b\[0m|\x1b\[39m|\x1b\[49m)$/.test(seq)) {
          prefix = "";
        } else {
          prefix += seq;
        }
        i += seq.length;
        continue;
      }
      current += text[i];
      i += 1;
      continue;
    }
    if (text[i] === "\n") {
      pushLine();
      i += 1;
      continue;
    }
    const cw = charWidth(text[i]);
    if (visible > 0 && visible + cw > width) pushLine();
    current += text[i];
    visible += cw;
    i += 1;
    if (visible >= width) {
      pushLine();
    }
  }
  if (current !== "") result.push(current);
  return result;
}
