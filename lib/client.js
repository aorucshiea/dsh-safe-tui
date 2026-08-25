// dsh-safe-tui web console client.
// Renders the Safe TUI as a right-side sliding panel (not a conversation tab):
// the chat stays in the center, the console slides in from the right and
// scrolls like the left sidebar. It attaches to the SAME Web session (?session=),
// survives Web server restarts through the detached console bridge, and can be
// opened automatically by the AI via the console_handoff tool.
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-safe-tui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var runtimeClient = require("@deepseek-ai/dsh-client-runtime/client");

    const inject = ["slots"];
    const CONSOLE_WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/console/ws";
    const HOST_BASE = location.origin;

    const consolePanelStore = runtimeClient.createSnapshotStore({ open: false });

    function useConsolePanelOpen() {
      return React.useSyncExternalStore(
        consolePanelStore.subscribe,
        consolePanelStore.getSnapshot
      ).open;
    }

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const id = "dsh-web-console-script-" + src.replace(/[^a-z0-9]/gi, "-");
        if (document.getElementById(id)) return resolve();
        const script = document.createElement("script");
        script.id = id;
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error("failed to load " + src));
        document.head.appendChild(script);
      });
    }

    function loadCss() {
      if (document.querySelector("link[data-web-console-css]")) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/console/xterm.css";
      link.dataset.webConsoleCss = "true";
      document.head.appendChild(link);
    }

    function consoleWsUrl(sessionId) {
      if (!sessionId) return CONSOLE_WS_BASE;
      return CONSOLE_WS_BASE + "?session=" + encodeURIComponent(sessionId);
    }

    function findTab(label) {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      if (label) return tabs.find((button) => (button.textContent || "").trim() === label);
      return tabs.find((button) => (button.textContent || "").trim() !== "控制台");
    }

    function clickTab(label) {
      const tab = findTab(label);
      if (tab) tab.click();
      return Boolean(tab);
    }

    async function ackHandoff() {
      try {
        await fetch(HOST_BASE + "/console/api/handoff/ack", { method: "POST" });
      } catch { /* ignore */ }
    }

    function ConsoleView(props) {
      const terminalRef = React.useRef(null);
      const [status, setStatus] = React.useState("正在连接 Safe TUI…");
      const sessionId = props && props.sessionId;
      const onClose = props && props.onClose;

      React.useEffect(() => {
        let alive = true;
        let term = null;
        let fit = null;
        let ws = null;
        let reconnectTimer = null;
        let resizeObserver = null;
        let disposed = false;
        const wsUrl = consoleWsUrl(sessionId);
        const scrollBody = terminalRef.current?.closest("[data-conversation-scroll]");
        if (scrollBody) scrollBody.setAttribute("data-dsh-console-active", "true");

        const connect = () => {
          if (!alive || disposed) return;
          try {
            ws = new WebSocket(wsUrl);
          } catch (error) {
            if (alive) setStatus("控制台连接失败: " + (error?.message || String(error)));
            reconnectSoon();
            return;
          }
          ws.onopen = () => {
            if (!alive) return;
            setStatus(sessionId ? "Safe TUI 已连接 · 同会话 " + sessionId : "Safe TUI 已连接");
            term?.focus();
            ws.send(JSON.stringify({ type: "resize", cols: term?.cols || 80, rows: term?.rows || 24 }));
          };
          ws.onmessage = (event) => {
            let raw = event.data;
            try {
              const message = JSON.parse(raw);
              if (message && typeof message.type === "string") {
                if (message.type === "replay" || message.type === "output") {
                  if (term) term.write(message.data || "");
                } else if (message.type === "status") {
                  setStatus(message.sessionId ? "Safe TUI 已连接 · 同会话 " + message.sessionId : "Safe TUI 已连接");
                } else if (message.type === "exit") {
                  setStatus("Safe TUI 已退出");
                }
                return;
              }
            } catch { /* legacy raw terminal data */ }
            if (term) term.write(raw);
          };
          ws.onclose = () => {
            if (!alive) return;
            setStatus("连接已断开，正在自动重连…");
            reconnectSoon();
          };
          ws.onerror = () => {
            if (alive) setStatus("控制台连接失败，正在重试…");
          };
        };

        const reconnectSoon = () => {
          if (!alive || disposed || reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1500);
        };

        const boot = async () => {
          try {
            await loadScript("/console/xterm.js");
            await loadScript("/console/addon-fit.js");
            if (!alive) return;
            loadCss();

            const TerminalCtor = window.DSHSafeTerminal || window.Terminal || globalThis.Terminal;
            if (typeof TerminalCtor !== "function") throw new Error("window.DSHSafeTerminal is not a constructor");
            term = new TerminalCtor({
              cursorBlink: true,
              fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
              fontSize: 13,
              lineHeight: 1.2,
              allowProposedApi: true,
              theme: {
                background: "#111116",
                foreground: "#d8d8dc",
                cursor: "#4ea1ff",
                selectionBackground: "#334",
                black: "#0c0c0f",
                red: "#e06c75",
                green: "#98c379",
                yellow: "#e5c07b",
                blue: "#61afef",
                magenta: "#c678dd",
                cyan: "#56b6c2",
                white: "#d8d8dc",
                brightBlack: "#5c6370",
                brightRed: "#e06c75",
                brightGreen: "#98c379",
                brightYellow: "#e5c07b",
                brightBlue: "#61afef",
                brightMagenta: "#c678dd",
                brightCyan: "#56b6c2",
                brightWhite: "#ffffff",
              },
            });

            const FitCtor = window.DSHSafeFitAddon || window.FitAddon?.FitAddon || window.FitAddon;
            if (typeof FitCtor !== "function") throw new Error("window.DSHSafeFitAddon is not a constructor");
            fit = new FitCtor();
            term.loadAddon(fit);
            term.open(terminalRef.current);
            fit.fit();

            term.onData((data) => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "input", data }));
              }
            });

            const resize = () => {
              if (!fit || !term || !ws) return;
              fit.fit();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
              }
            };
            resizeObserver = new ResizeObserver(resize);
            resizeObserver.observe(terminalRef.current);
            window.addEventListener("resize", resize);

            connect();
          } catch (error) {
            if (alive) setStatus("终端组件加载失败: " + (error?.message || String(error)));
          }
        };

        boot();

        return () => {
          disposed = true;
          alive = false;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (scrollBody) scrollBody.removeAttribute("data-dsh-console-active");
          if (resizeObserver) resizeObserver.disconnect();
          if (ws) ws.close();
          if (term) term.dispose();
        };
      }, [sessionId]);

      return React.createElement(
        "div",
        { style: { height: "100%", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-base, #101014)", minHeight: 0 } },
        React.createElement("div", {
          style: {
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            borderBottom: "1px solid var(--dsw-alias-border-l2, #2a2a30)",
            color: "var(--dsw-alias-label-secondary, #aaa)",
            fontSize: 12,
          },
        },
          React.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #ddd)" } }, "DSH Safe Console"),
          React.createElement("span", { style: { color: "#888" } }, sessionId ? "同会话" : "safe profile"),
          React.createElement("button", {
            type: "button",
            onClick: () => (typeof onClose === "function" ? onClose() : undefined),
            style: {
              marginLeft: "auto",
              border: "1px solid var(--dsw-alias-border-l2, #2a2a30)",
              background: "transparent",
              color: "var(--dsw-alias-label-primary, #ddd)",
              borderRadius: 14,
              padding: "2px 10px",
              cursor: "pointer",
              fontSize: 12,
            },
          }, "关闭"),
          React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary, #777)" } }, status),
        ),
        React.createElement("div", {
          ref: terminalRef,
          style: { flex: 1, minHeight: 0, padding: "8px 12px 12px", background: "#111116" },
        })
      );
    }

    function ConsolePanelButton(props) {
      const open = useConsolePanelOpen();
      return React.createElement("button", {
        type: "button",
        onClick: () => consolePanelStore.update((d) => { d.open = !d.open; }),
        style: {
          border: "1px solid var(--dsw-alias-border-l2, #2a2a30)",
          background: open ? "var(--dsw-alias-interactive-bg-hover, #2a2a30)" : "transparent",
          color: "var(--dsw-alias-label-primary, #ddd)",
          borderRadius: 18,
          padding: "5px 12px",
          cursor: "pointer",
          fontSize: 13,
        },
      }, open ? "关闭控制台" : "控制台");
    }

    function ConsoleTabLauncher(props) {
      React.useEffect(() => {
        consolePanelStore.update((d) => { d.open = true; });
      }, []);
      return React.createElement("div", {
        style: {
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          color: "var(--dsw-alias-label-secondary, #aaa)",
          fontSize: 14,
          background: "var(--dsw-alias-bg-base, #101014)",
        },
      },
        React.createElement("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #ddd)" } }, "Safe TUI 控制台已在右侧打开"),
        React.createElement("button", {
          type: "button",
          onClick: () => {
            consolePanelStore.update((d) => { d.open = false; });
            clickTab(null);
          },
          style: {
            border: "1px solid var(--dsw-alias-border-l2, #2a2a30)",
            background: "transparent",
            color: "var(--dsw-alias-label-primary, #ddd)",
            borderRadius: 18,
            padding: "6px 14px",
            cursor: "pointer",
            fontSize: 13,
          },
        }, "回到对话")
      );
    }

    function ConsoleOverlay(props) {
      const open = useConsolePanelOpen();
      const useSessions = props && props.useSessions;
      const sessionId = useSessions ? useSessions((s) => s.current) : undefined;

      if (!open) {
        return React.createElement("div", {
          style: { position: "absolute", inset: 0, pointerEvents: "none" },
        });
      }

      return React.createElement("div", {
        style: {
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(520px, 92vw)",
          pointerEvents: "auto",
          display: "flex",
          flexDirection: "column",
          background: "var(--dsw-alias-bg-base, #101014)",
          borderLeft: "1px solid var(--dsw-alias-border-l2, #2a2a30)",
          boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.35)",
          zIndex: 30,
          minHeight: 0,
        },
      }, React.createElement("div", {
        style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
      }, React.createElement(ConsoleView, {
        sessionId: sessionId || undefined,
        onClose: () => consolePanelStore.update((d) => { d.open = false; }),
      })));
    }

    function HandoffWatcher(props) {
      const sessionId = props && props.sessionId;
      React.useEffect(() => {
        if (!sessionId) return;
        let alive = true;
        let handled = false;
        const tick = async () => {
          try {
            const response = await fetch(HOST_BASE + "/console/api/handoff", { cache: "no-store" });
            const data = await response.json();
            if (!alive) return;
            if (!data || !data.pending || data.sessionId !== sessionId) return;
            if (handled) return;
            handled = true;
            if (data.direction === "web") {
              consolePanelStore.update((d) => { d.open = false; });
            } else {
              consolePanelStore.update((d) => { d.open = true; });
            }
            setTimeout(() => { if (alive) ackHandoff(); }, 250);
          } catch { /* ignore */ }
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      return null;
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;

      ctx.effect(() => slots.inject("conversation.view", () => slots.register({
        name: "conversation.view",
        id: "console",
        order: 100,
        label: () => "控制台",
      }, ConsoleTabLauncher)), "dsh-safe-tui: console tab");

      ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register({
        name: "conversation.session.header.actions",
        id: "safe-console-toggle",
        order: 50,
      }, ConsolePanelButton)), "dsh-safe-tui: console panel toggle");

      ctx.effect(() => slots.inject("shell.overlay", () => slots.register({
        name: "shell.overlay",
        id: "safe-console-panel",
        order: 50,
      }, ConsoleOverlay)), "dsh-safe-tui: console panel overlay");

      ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register({
        name: "conversation.session.header.utilities",
        id: "console-handoff-watcher",
        order: 50,
      }, HandoffWatcher)), "dsh-safe-tui: console handoff watcher");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
