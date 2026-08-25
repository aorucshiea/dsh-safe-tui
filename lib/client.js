// dsh-safe-tui web console client.
// Registers a "控制台" tab at the far right of the conversation tabs and renders
// a full xterm.js terminal connected to /console/ws.
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-safe-tui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const inject = ["slots"];
    const CONSOLE_WS = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/console/ws";

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
      if (!document.getElementById("dsh-console-hide-composer-style")) {
        const style = document.createElement("style");
        style.id = "dsh-console-hide-composer-style";
        style.textContent = "[data-dsh-console-active] [data-composer-seat]{display:none!important}";
        document.head.appendChild(style);
      }
    }

    function ConsoleView(_props) {
      const terminalRef = React.useRef(null);
      const [status, setStatus] = React.useState("正在连接 Safe TUI…");

      React.useEffect(() => {
        let alive = true;
        let term = null;
        let fit = null;
        let ws = null;
        let resizeObserver = null;
        const scrollBody = terminalRef.current?.closest("[data-conversation-scroll]");
        if (scrollBody) scrollBody.setAttribute("data-dsh-console-active", "true");

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

            ws = new WebSocket(CONSOLE_WS);
            ws.onopen = () => {
              if (!alive) return;
              setStatus("Safe TUI 已连接");
              term.focus();
              ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            };
            ws.onmessage = (event) => {
              term.write(event.data);
            };
            ws.onclose = () => {
              if (alive) setStatus("连接已断开，点击重新打开控制台");
            };
            ws.onerror = () => {
              if (alive) setStatus("控制台连接失败");
            };

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
          } catch (error) {
            if (alive) setStatus("终端组件加载失败: " + (error?.message || String(error)));
          }
        };

        boot();

        return () => {
          alive = false;
          if (scrollBody) scrollBody.removeAttribute("data-dsh-console-active");
          if (resizeObserver) resizeObserver.disconnect();
          if (ws) ws.close();
          if (term) term.dispose();
        };
      }, []);

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
          React.createElement("span", { style: { color: "#888" } }, "safe profile"),
          React.createElement("span", { style: { marginLeft: "auto", color: "var(--dsw-alias-label-tertiary, #777)" } }, status),
        ),
        React.createElement("div", {
          ref: terminalRef,
          style: { flex: 1, minHeight: 0, padding: "8px 12px 12px", background: "#111116" },
        })
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;
      ctx.effect(() => slots.inject("conversation.view", () => slots.register({
        name: "conversation.view",
        id: "console",
        order: 100,
        label: () => "控制台",
      }, ConsoleView)), "dsh-safe-tui: console view tab");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
