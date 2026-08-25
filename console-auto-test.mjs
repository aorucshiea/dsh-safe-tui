// Temporary automated shuttle test.
// 1. waits for THIS web turn to finish, then requests Web restart
// 2. connects to the console bridge (survives restart)
// 3. waits for the Safe TUI to resume the target session
// 4. sends /status and a short AI confirmation prompt
import WebSocket from "ws";
import fs from "node:fs";

const statePath = "C:/Users/Administrator/.dsh/safe-tui/console-bridge.json";
const logPath = "C:/Users/Administrator/dsh-safe-tui/console-auto-test.log";
const targetSession = "session-e0eee9ca-5108-44cf-a7fe-8fbe53e3ab92";
const delayBeforeRestart = 20000;

const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(logPath, text); } catch {}
  console.log(text.trim());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.port) return state.port;
    } catch {}
    await sleep(500);
  }
  return null;
}

async function triggerRestart() {
  try {
    log("requesting web restart");
    await fetch("http://127.0.0.1:3080/easy-start/api/restart", { method: "POST" });
    log("restart requested");
  } catch (e) {
    log("restart fetch error: " + e.message);
  }
}

async function driveConsole() {
  const port = await readPort();
  if (!port) { log("no bridge port"); return; }
  log("bridge port " + port);
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  let buffer = "";
  let sentStatus = false;
  let sentPrompt = false;
  let done = false;
  const deadline = Date.now() + 120000;
  const timer = setInterval(() => {
    if (Date.now() > deadline && !done) { log("drive timeout"); cleanup(1); }
  }, 1000);
  function cleanup(code) {
    done = true;
    clearInterval(timer);
    try { ws.close(); } catch {}
    log("done exit " + code);
    process.exit(code);
  }
  ws.on("open", () => log("bridge ws open"));
  ws.on("message", (data) => {
    const text = String(data);
    try {
      const m = JSON.parse(text);
      if (m.type === "output" || m.type === "replay") buffer += String(m.data || "");
      else if (m.type === "status") log("bridge status " + JSON.stringify(m));
      else if (m.type === "exit") log("bridge exit");
    } catch {
      buffer += text;
    }
    const clean = buffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/[\x07\r]/g, "");
    if (!sentStatus && clean.includes("Ask anything")) {
      sentStatus = true;
      log("tui ready, sending /status");
      setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "/status\r" })), 800);
    }
    if (sentStatus && !sentPrompt && clean.includes("safe mode status")) {
      const idx = clean.indexOf("safe mode status");
      const statusText = clean.slice(idx, idx + 300);
      log("status snapshot: " + statusText.replace(/\n/g, " | "));
      if (statusText.includes(targetSession)) {
        sentPrompt = true;
        log("target session resumed, sending AI confirmation prompt");
        setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "请只回答一句话：你已接管此会话，当前会话id是什么？\r" })), 1000);
      } else {
        log("status does not yet contain target session, keep waiting");
        sentStatus = false; // will re-send on next ready
      }
    }
    if (sentPrompt && clean.includes("assistant") && clean.includes("session-")) {
      const idx = Math.max(clean.lastIndexOf("assistant"), 0);
      log("AI reply found: " + clean.slice(idx, idx + 600).replace(/\n/g, " | "));
      cleanup(0);
    }
  });
  ws.on("error", (e) => { log("bridge ws error: " + e.message); cleanup(1); });
}

log("automation started; waiting " + delayBeforeRestart + "ms before restart");
await sleep(delayBeforeRestart);
await triggerRestart();
await sleep(5000); // let the old web die and the wait-retry loop proceed
await driveConsole();
