#!/usr/bin/env node
// deepseek - launch the dsh-safe-console TUI.
// This binary is installed by npm (or copied to PATH manually).
import { spawnSync } from "node:child_process";

const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
const command = process.platform === "win32" ? "dsh" : "dsh";
const args = ["--profile", "safe", ...process.argv.slice(2)];
const result = spawnSync(command, args, {
  cwd,
  stdio: "inherit",
  shell: process.platform === "win32"
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
