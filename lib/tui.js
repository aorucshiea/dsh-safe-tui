// Minimal full-screen TUI renderer for the safe-mode console.
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

function truncateLine(line, width) {
  if (line.length <= width) return line;
  if (width <= 1) return line.slice(0, width);
  return line.slice(0, width - 1) + "…";
}

function padLine(line, width) {
  const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
  const visible = clean.length;
  if (visible >= width) return truncateLine(line, width);
  return line + " ".repeat(width - visible);
}

const COMMANDS = [
  { command: "/list", description: "List saved sessions" },
  { command: "/resume <id>", description: "Resume a session (inherits history)" },
  { command: "/new", description: "Start a fresh session" },
  { command: "/preset", description: "Show current preset" },
  { command: "/preset <id>", description: "Switch preset: minimal / standard" },
  { command: "/model", description: "List available models" },
  { command: "/model <id>", description: "Switch default model" },
  { command: "/models", description: "Alias of /model" },
  { command: "/models <id>", description: "Switch default model (alias)" },
  { command: "/add-provider", description: "Add an LLM provider via guided setup" },
  { command: "/providers", description: "List active model providers" },
  { command: "/status", description: "Session / preset / model status" },
  { command: "/repair", description: "Repair broken web client files" },
  { command: "/check", description: "Health check" },
  { command: "/help", description: "Show help" },
  { command: "/quit", description: "Exit safe mode" },
  { command: "/exit", description: "Alias of /quit" }
];

export class TUI {
  constructor(options = {}) {
    this.onSubmit = options.onSubmit ?? (async () => {});
    this.onCommandSelect = options.onCommandSelect ?? null;
    this.onQuit = options.onQuit ?? (() => {});
    this.statusProvider = options.statusProvider ?? (() => "");
    this.placeholder = options.placeholder ?? "Ask anything... (/ for commands)";
    this.lines = [];
    this.input = "";
    this.cursor = 0;
    this.commandHistory = [];
    this.historyIndex = -1;
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
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding?.("utf8");
    process.stdin.on("data", this._onData);
    process.stdout.on("resize", this._onResize);
    this.render();
  }

  stop() {
    this._clearEscapeTimer();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdin.removeListener("data", this._onData);
    process.stdout.removeListener("resize", this._onResize);
    process.stdout.write(clearScreen() + reset() + showCursor() + "\x1b[?1049l");
  }

  quit() {
    if (this.quitRequested) return;
    this.quitRequested = true;
    this.stop();
    this.onQuit();
  }

  println(text = "") {
    for (const line of String(text).split("\n")) {
      this.lines.push(line);
    }
    if (this.lines.length > 800) this.lines = this.lines.slice(-800);
    if (!this.quitRequested) this.render();
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    if (!this.quitRequested) this.render();
  }

  addEvent(event) {
    let line = "";
    if (event.type === "user/message") {
      const text = textOf(event.data?.message);
      if (text) line = `${cyan("you")}  ${text}`;
    } else if (event.type === "assistant/message") {
      const text = textOf(event.data?.message);
      if (text) line = `${green("dsh")}  ${text}`;
    } else if (event.type === "turn/start") {
      line = `${dim("· turn started")}`;
    } else if (event.type === "turn/end") {
      const reason = event.data?.reason?.kind ?? "unknown";
      line = `${dim(`· turn ended: ${reason}`)}`;
    } else {
      return;
    }
    if (line) this.println(line);
  }

  addHistoryLine(line) {
    this.println(line);
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
    const palette = this.picker
      ? this._pickerLines(cols)
      : this.paletteOpen && this._paletteItems().length > 0
        ? this._paletteLines(this._paletteItems(), cols)
        : [];
    const popupHeight = palette.length;
    const available = Math.max(1, rows - header.length - footer.length - status.length - 3 - popupHeight);
    const shown = this.lines.slice(-available);

    const lines = [];
    lines.push(...header);
    for (const line of shown) lines.push(line);
    while (lines.length < header.length + available) lines.push("");
    if (palette.length > 0) lines.push(...palette);
    lines.push(...status);
    lines.push("");
    lines.push(...footer);

    const screenLines = lines.slice(0, rows).map((line) => padLine(line, cols));
    process.stdout.write(clearScreen());
    process.stdout.write(screenLines.join("\n"));

    const inputRow = header.length + available + palette.length + status.length + 1;
    this._drawPrompt(inputRow, cols);
  }

  _header(cols) {
    return [
      `  ${cyan("◆")} ${bold("DeepSeek Harness")} ${gray("· Safe Mode")}`,
      `  ${gray("─".repeat(Math.max(1, cols - 4)))}`
    ];
  }

  _footer() {
    return [
      `  ${gray("/list")}   ${gray("/resume <id>")}   ${gray("/new")}   ${gray("/preset")}   ${gray("/models")}   ${gray("/status")}   ${gray("/repair")}   ${gray("/check")}   ${gray("/help")}   ${gray("/quit")}`,
      `  ${dim("safe mode · only minimal / standard presets · no user plugins · type / for commands")}`
    ];
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
    // Prompt visible width is exactly 2 (glyph + space).
    const cursorCol = 2 + (this.cursor - start) + 1;
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

  openPicker({ title, items, onSelect } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    const normalized = items.map((item) => typeof item === "string" ? { label: item, value: item } : item);
    this.picker = {
      title: title ?? "Select",
      items: normalized,
      index: 0,
      onSelect
    };
    this.paletteOpen = false;
    this.render();
  }

  closePicker() {
    this.picker = null;
    this.render();
  }

  _pickerItems() {
    return this.picker?.items ?? [];
  }

  _pickerPrev() {
    const items = this._pickerItems();
    if (this.picker === null || items.length === 0) return;
    this.picker.index = this.picker.index <= 0 ? items.length - 1 : this.picker.index - 1;
    this.render();
  }

  _pickerNext() {
    const items = this._pickerItems();
    if (this.picker === null || items.length === 0) return;
    this.picker.index = this.picker.index >= items.length - 1 ? 0 : this.picker.index + 1;
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
    const maxLabel = Math.max(4, boxWidth - 6);
    const lines = [];
    const title = this.picker?.title ?? "Select";
    const titleText = ` ${title} `;
    const horizontal = "─".repeat(Math.max(1, boxWidth - titleText.length - 2));
    lines.push(`  ${gray("┌")}${gray(titleText)}${gray(horizontal)}${gray("┐")}`);
    for (let offset = 0; offset < items.length; offset += 1) {
      const item = items[offset];
      let label = String(item.label ?? item.value ?? "");
      if (label.length > maxLabel - 2) label = label.slice(0, maxLabel - 3) + "…";
      const selected = start + offset === this.picker?.index;
      const inner = ` ${label} `;
      const pad = Math.max(0, boxWidth - 2 - inner.length);
      if (selected) {
        const styled = `${ESC}48;5;237m${ESC}97m${label}${" ".repeat(pad)}${reset()}`;
        lines.push(`  ${gray("│")}${styled}${gray("│")}`);
      } else {
        lines.push(`  ${gray("│")}${label}${" ".repeat(pad)}${gray("│")}`);
      }
    }
    lines.push(`  ${gray("└")}${gray("─".repeat(boxWidth - 2))}${gray("┘")}`);
    lines.push(`  ${gray("↑/↓ select · enter choose · esc cancel")}`);
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
    } else if (seq === "\x1b") {
      if (this.picker !== null) {
        this.closePicker();
      } else if (this.paletteOpen) {
        this._closePalette();
        this.render();
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
      this.quit();
      return;
    }
    if (ch === "\x04") {
      if (this.input === "") this.quit();
      return;
    }
    if (ch === "\x7f" || ch === "\b") {
      if (this.picker !== null) {
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

  _historyPrev() {
    if (this.commandHistory.length === 0) return;
    if (this.historyIndex < 0) this.historyIndex = this.commandHistory.length - 1;
    else if (this.historyIndex > 0) this.historyIndex -= 1;
    this.input = this.commandHistory[this.historyIndex] ?? "";
    this.cursor = this.input.length;
    this.render();
  }

  _historyNext() {
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
