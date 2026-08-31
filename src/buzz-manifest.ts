/**
 * Buzz custom-harness manifest management added by the buzz-zcode-harness fork.
 * This module is not part of the original upstream zcode-acp distribution.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuzzManifestOptions {
  buzzDataDir?: string;
  label?: string;
  model?: string;
  nodeBin?: string;
  zcodeBin?: string;
}

export interface BuzzHarnessManifest {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function defaultBuzzDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Buzz");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Buzz");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Buzz");
}

export function buildBuzzManifest(options: BuzzManifestOptions = {}): BuzzHarnessManifest {
  const bridge = fileURLToPath(new URL("./index.js", import.meta.url));
  const env: Record<string, string> = {};
  if (options.zcodeBin) env.ZCODE_BIN = path.resolve(resolveHome(options.zcodeBin));
  if (options.model) env.ZCODE_MODEL = options.model;
  return {
    id: "zcode",
    label: options.label ?? "ZCode",
    command: path.resolve(resolveHome(options.nodeBin ?? process.execPath)),
    args: [bridge],
    env,
  };
}

export function installBuzzManifest(options: BuzzManifestOptions = {}): {
  destination: string;
  backup: string | null;
  manifest: BuzzHarnessManifest;
} {
  const destination = manifestPath(options.buzzDataDir);
  const manifest = buildBuzzManifest(options);
  mkdirSync(path.dirname(destination), { recursive: true });
  let backup: string | null = null;
  if (existsSync(destination)) {
    backup = `${destination}.backup-${timestamp()}`;
    renameSync(destination, backup);
  }
  try {
    writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    if (backup && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
  return { destination, backup, manifest };
}

export function inspectBuzzManifest(buzzDataDir?: string): {
  destination: string;
  exists: boolean;
  manifest?: BuzzHarnessManifest;
} {
  const destination = manifestPath(buzzDataDir);
  if (!existsSync(destination)) return { destination, exists: false };
  return {
    destination,
    exists: true,
    manifest: JSON.parse(readFileSync(destination, "utf8")) as BuzzHarnessManifest,
  };
}

export function uninstallBuzzManifest(buzzDataDir?: string): {
  destination: string;
  removed: boolean;
  backup?: string;
} {
  const destination = manifestPath(buzzDataDir);
  if (!existsSync(destination)) return { destination, removed: false };
  const backup = `${destination}.removed-${timestamp()}`;
  renameSync(destination, backup);
  return { destination, removed: true, backup };
}

function manifestPath(buzzDataDir?: string): string {
  return path.join(
    path.resolve(resolveHome(buzzDataDir ?? defaultBuzzDataDir())),
    "custom_harnesses",
    "zcode.json",
  );
}

function resolveHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
