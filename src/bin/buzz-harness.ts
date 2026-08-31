#!/usr/bin/env node

/** Buzz manifest CLI added by the buzz-zcode-harness fork. */

import { accessSync, constants } from "node:fs";
import process from "node:process";

import {
  inspectBuzzManifest,
  installBuzzManifest,
  uninstallBuzzManifest,
} from "../buzz-manifest.js";

interface CliOptions {
  [key: string]: string | boolean | undefined;
}

const { command, options } = parseArguments(process.argv.slice(2));

try {
  if (command === "install") install(options);
  else if (command === "doctor") doctor(options);
  else if (command === "uninstall") uninstall(options);
  else usage(command ? `Unknown command: ${command}` : undefined);
} catch (error) {
  process.stderr.write(
    `buzz-zcode-harness: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function install(options: CliOptions): void {
  const result = installBuzzManifest({
    buzzDataDir: stringOption(options, "buzz-data-dir"),
    label: stringOption(options, "label"),
    model: stringOption(options, "model"),
    nodeBin: stringOption(options, "node-bin"),
    zcodeBin: stringOption(options, "zcode-bin"),
  });
  process.stdout.write(`Installed Buzz harness manifest: ${result.destination}\n`);
  if (result.backup) process.stdout.write(`Previous manifest backup: ${result.backup}\n`);
  process.stdout.write("Credentials stored in manifest: no\n");
}

function doctor(options: CliOptions): void {
  const inspection = inspectBuzzManifest(stringOption(options, "buzz-data-dir"));
  if (!inspection.exists || !inspection.manifest) {
    process.stdout.write(`Buzz manifest: not installed (${inspection.destination})\n`);
    process.exitCode = 2;
    return;
  }
  const { manifest } = inspection;
  process.stdout.write(`Buzz manifest: ${inspection.destination}\n`);
  process.stdout.write(
    `Node executable: ${manifest.command} (${isExecutable(manifest.command) ? "ok" : "missing"})\n`,
  );
  const bridge = manifest.args[0];
  process.stdout.write(
    `ACP bridge: ${bridge ?? "not configured"} (${bridge && isReadable(bridge) ? "ok" : "missing"})\n`,
  );
  if (manifest.env.ZCODE_BIN) {
    process.stdout.write(
      `ZCode executable: ${manifest.env.ZCODE_BIN} (${isReadable(manifest.env.ZCODE_BIN) ? "ok" : "missing"})\n`,
    );
  } else {
    process.stdout.write("ZCode executable: auto-discovery\n");
  }
  process.stdout.write(`Model override: ${manifest.env.ZCODE_MODEL ?? "ZCode configuration"}\n`);
  process.stdout.write("Credentials stored in manifest: no\n");
}

function uninstall(options: CliOptions): void {
  const result = uninstallBuzzManifest(stringOption(options, "buzz-data-dir"));
  if (!result.removed) process.stdout.write(`No manifest found at ${result.destination}.\n`);
  else
    process.stdout.write(`Removed manifest from active use. Recoverable copy: ${result.backup}\n`);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArguments(args: string[]): { command: string | undefined; options: CliOptions } {
  const [command, ...rest] = args;
  const options: CliOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function usage(error?: string): void {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write(`Usage:
  buzz-zcode-harness install [--zcode-bin PATH] [--node-bin PATH] [--model ID] [--label TEXT] [--buzz-data-dir PATH]
  buzz-zcode-harness doctor [--buzz-data-dir PATH]
  buzz-zcode-harness uninstall [--buzz-data-dir PATH]
`);
  process.exitCode = error ? 1 : 0;
}
