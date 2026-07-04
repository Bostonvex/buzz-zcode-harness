/**
 * Resolve the argv to launch the ZCode app-server subprocess.
 *
 * The ZCode CLI is a Node `.cjs` that relies on a `#!/usr/bin/env node` shebang.
 * Processes launched by GUI launchd (no shell profile) have no `node` on PATH,
 * so the shebang fails. We sidestep it by constructing `[node, zcode.cjs,
 * "app-server", "--stdio"]` with an explicit, sqlite-capable Node binary.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execSync, execFileSync } from "node:child_process";

import { log } from "../utils.js";

/** `which bin` — resolve a binary on PATH without external deps. */
function whichSync(bin: string): string | null {
  try {
    const out = execSync(`which ${bin}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Glob the Zed-bundled node directories, newest version first. */
function zedBundledNodes(): string[] {
  const base = path.join(os.homedir(), "Library/Application Support/Zed/node");
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.startsWith("node-v"))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, "bin", "node"));
}

/**
 * Candidate Node binaries in priority order. Deduped, order-preserving.
 * Falls back to the Zed-bundled Node glob as a last resort.
 */
function candidateNodeBinaries(): string[] {
  const cands: string[] = [];
  const envNode = process.env.ZCODE_NODE;
  if (envNode) cands.push(envNode);
  cands.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  const whichNode = whichSync("node");
  if (whichNode) cands.push(whichNode);
  cands.push(...zedBundledNodes());
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (!c || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Verify a Node binary can load `node:sqlite` (ZCode depends on it; Node < 22
 * lacks the module and would crash). Uses `new DatabaseSync(...)` because a
 * bare reference would mis-detect support.
 */
function nodeSupportsSqlite(nodeBin: string): boolean {
  if (!nodeBin || !existsSync(nodeBin)) return false;
  try {
    execFileSync(nodeBin, ["-e", "new (require('node:sqlite').DatabaseSync)(':memory:')"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the full argv to launch `zcode app-server --stdio`. */
export function resolveZcodeCommand(): string[] {
  const zcodeBin = process.env.ZCODE_BIN ?? "zcode";
  // Non-JS bin (e.g. a `zcode` command or wrapper) → use as-is, rely on its own shebang.
  if (!/\.(cjs|mjs|js)$/.test(zcodeBin)) {
    return [zcodeBin, "app-server", "--stdio"];
  }
  // JS file → launch with an explicit sqlite-capable Node to bypass the shebang.
  for (const nodeBin of candidateNodeBinaries()) {
    if (nodeSupportsSqlite(nodeBin)) {
      let ver = "?";
      try {
        ver = execSync(`${nodeBin} --version`, { encoding: "utf8" }).trim();
      } catch {
        // keep "?"
      }
      log(`resolve: launching zcode with node ${nodeBin} (${ver})`);
      return [nodeBin, zcodeBin, "app-server", "--stdio"];
    }
  }
  log(
    "resolve: no sqlite-capable node found; falling back to PATH-resolved zcode shebang " +
      "(may fail under GUI launch)",
  );
  return [zcodeBin, "app-server", "--stdio"];
}
