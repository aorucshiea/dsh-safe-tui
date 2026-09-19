#!/usr/bin/env node
// deepseek - launch the dsh-safe-tui TUI.
// This binary is installed by npm (or copied to PATH manually).
import { spawnSync } from "node:child_process";

const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
const args = ["--profile", "safe", ...process.argv.slice(2)];
// On Windows, `dsh` resolves to dsh.cmd: run it without a shell via its full
// cmd wrapper so task text containing & | ^ % is never interpreted by cmd.exe.
const result = spawnSync("dsh.cmd", args, {
  cwd,
  stdio: "inherit",
  shell: false
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("deepseek: dsh not found on PATH. Install DeepSeek Harness first ('dsh web').");
  } else {
    console.error(String(result.error));
  }
  process.exit(1);
}
process.exit(result.status ?? 1);
