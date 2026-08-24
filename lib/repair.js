// Standalone repair for DeepSeek Harness safe mode.
// This module intentionally has NO dependency on the DSH runtime, so it can
// run even when the main web UI fails to boot.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, copyFileSync, existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");

/** The files whose hand-patched client code has historically been corrupted by
 * over-eager regex patching. Each entry knows how to tell healthy from broken
 * and where its pristine source lives. */
const FRAGILES = [
  {
    name: "agent-preset client",
    packageName: "@deepseek-ai/dsh-client-ui-agent-preset",
    relative: "lib/client.js",
    pristine: join(PROJECT_ROOT, "pristine", "dsh-client-ui-agent-preset", "package", "lib", "client.js"),
    critical: (text) => text.includes("function AgentPresetRow"),
    criticalLabel: "function AgentPresetRow",
    note: "missing AgentPresetRow was the exact cause of 'Failed to load plugins ... AgentPresetRow is not defined'"
  },
  {
    name: "plugin-inventory client",
    packageName: "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
    relative: "lib/client.js",
    pristine: join(PROJECT_ROOT, "pristine", "dsh-client-ui-settings-plugin-inventory", "package", "lib", "client.js"),
    critical: (text) => text.includes("function PluginInventorySettingsTab"),
    criticalLabel: "function PluginInventorySettingsTab",
    note: "restored if the plugin inventory renderer is missing"
  },
  {
    name: "plugin-inventory host",
    packageName: "@deepseek-ai/dsh-host-plugin-inventory",
    relative: "lib/index.js",
    pristine: join(PROJECT_ROOT, "pristine", "dsh-host-plugin-inventory", "package", "lib", "index.js"),
    critical: (text) => text.includes("function pluginEntryId"),
    criticalLabel: "function pluginEntryId",
    note: "restored if the host inventory module is missing its core function"
  }
];

/** Collect every installed copy of one @deepseek-ai package this machine may use. */
function candidateRoots(packageName) {
  const npxCacheRoot = join(LOCALAPPDATA, "npm-cache", "_npx");
  const roots = [
    join(HOME, "node_modules", packageName),
    join(APPDATA, "npm", "node_modules", packageName),
    join(HOME, "node_modules", "@deepseek-ai", "dsh", "node_modules", packageName),
    join(APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", packageName),
    join(HOME, ".dsh", "profiles", "web", "node_modules", packageName),
    join(HOME, ".dsh", "profiles", "node_modules", packageName)
  ];
  try {
    for (const dir of readdirSync(npxCacheRoot)) {
      roots.push(join(npxCacheRoot, dir, "node_modules", packageName));
      roots.push(join(npxCacheRoot, dir, "node_modules", "@deepseek-ai", "dsh", "node_modules", packageName));
    }
  } catch {
    // npx cache may not exist; this is not an error.
  }
  return roots;
}

function existingFiles(relativePath) {
  return candidateRoots(relativePath.packageName)
    .map((root) => join(root, relativePath.relative))
    .filter((file) => existsSync(file));
}

function existingUniqueFiles(fragile) {
  const seen = new Set();
  const files = [];
  for (const file of existingFiles(fragile)) {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      // fall through with the path as-is
    }
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(file);
  }
  return files;
}

function syntaxOk(file) {
  try {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function stateOf(fragile, file) {
  const text = readText(file);
  const criticalOk = fragile.critical ? fragile.critical(text) : true;
  const syntax = syntaxOk(file);
  if (!criticalOk) return { kind: "broken", reason: `missing ${fragile.criticalLabel}` };
  if (!syntax) return { kind: "broken", reason: "syntax error" };
  return { kind: "ok", reason: "healthy" };
}

function isSameFile(a, b) {
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function backupBroken(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.safe-${stamp}.bak`;
  copyFileSync(file, backup);
  return backup;
}

function findPristine(fragile) {
  return fragile.pristine;
}

function checkAll() {
  const results = [];
  for (const fragile of FRAGILES) {
    const files = existingUniqueFiles(fragile);
    if (files.length === 0) {
      results.push({
        name: fragile.name,
        packageName: fragile.packageName,
        file: null,
        status: "missing",
        reason: "no installed copy found under known roots"
      });
      continue;
    }
    for (const file of files) {
      const state = stateOf(fragile, file);
      results.push({
        name: fragile.name,
        packageName: fragile.packageName,
        file,
        status: state.kind,
        reason: state.reason
      });
    }
  }
  return results;
}

function repairAll() {
  const report = [];
  for (const fragile of FRAGILES) {
    const files = existingUniqueFiles(fragile);
    if (files.length === 0) {
      report.push({
        name: fragile.name,
        packageName: fragile.packageName,
        file: null,
        status: "missing",
        reason: "no installed copy found under known roots; cannot repair"
      });
      continue;
    }
    for (const file of files) {
      const state = stateOf(fragile, file);
      if (state.kind === "ok") {
        report.push({
          name: fragile.name,
          packageName: fragile.packageName,
          file,
          status: "ok",
          reason: "healthy"
        });
        continue;
      }
      // Only restore when we can be sure the file is broken, never when it is
      // merely a healthy customized (patched) file.
      if (state.kind !== "broken") {
        report.push({
          name: fragile.name,
          packageName: fragile.packageName,
          file,
          status: "skipped",
          reason: state.reason
        });
        continue;
      }
      const pristine = findPristine(fragile);
      if (!existsSync(pristine)) {
        report.push({
          name: fragile.name,
          packageName: fragile.packageName,
          file,
          status: "error",
          reason: `pristine source missing: ${pristine}`
        });
        continue;
      }
      const backup = backupBroken(file);
      copyFileSync(pristine, file);
      const after = stateOf(fragile, file);
      report.push({
        name: fragile.name,
        packageName: fragile.packageName,
        file,
        status: after.kind === "ok" ? "restored" : "restore-failed",
        reason: after.kind === "ok"
          ? `restored from pristine (backup: ${relative(PROJECT_ROOT, backup)})`
          : `restore from pristine still fails: ${after.reason}`,
        backup
      });
    }
  }
  return report;
}

function printReport(report, out = console.log) {
  let ok = true;
  for (const row of report) {
    const tag = row.status;
    if (tag === "broken" || tag === "restore-failed" || tag === "missing") ok = false;
    out(`[${tag.toUpperCase()}] ${row.name}${row.file ? " -> " + row.file : ""}`);
    if (row.reason) out(`    ${row.reason}`);
    if (row.note) out(`    note: ${row.note}`);
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--repair") ? "repair" : "check";
  const results = mode === "repair" ? repairAll() : checkAll();
  const ok = printReport(results);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && (process.argv[1].endsWith("repair.js") || process.argv[1].endsWith("repair.cjs"))) {
  main();
}

export { FRAGILES, checkAll, repairAll, printReport, syntaxOk };
