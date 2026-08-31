import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { warn } from "./utils.js";

const SAFE_PROXY_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface ModelProxySidecar {
  active: boolean;
  modelBaseUrl: string | undefined;
  contextUrl: string | null;
  child: ChildProcess | null;
  stop(): Promise<void>;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function directResult(upstreamBaseUrl: string | undefined): ModelProxySidecar {
  return {
    active: false,
    modelBaseUrl: upstreamBaseUrl,
    contextUrl: null,
    child: null,
    async stop() {},
  };
}

function proxyEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PROXY_ENV_KEYS) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}

function validLoopbackListener(value: string | null): URL | null {
  try {
    if (!value) return null;
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" || !parsed.port) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function modelChildEnvironment(
  source: NodeJS.ProcessEnv,
  modelBaseUrl: string | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source };
  if (modelBaseUrl) result.ZCODE_BASE_URL = modelBaseUrl;
  for (const key of Object.keys(result)) {
    if (key.startsWith("BUZZ_TELEMETRY_") || key.startsWith("BUZZ_MODEL_PROXY_")) {
      delete result[key];
    }
  }
  return result;
}

export async function startModelProxySidecar({
  upstreamBaseUrl,
  model,
  environment = process.env,
  diagnostic = warn,
}: {
  upstreamBaseUrl: string | undefined;
  model: string | undefined;
  environment?: NodeJS.ProcessEnv;
  diagnostic?: (message: string) => void;
}): Promise<ModelProxySidecar> {
  const direct = directResult(upstreamBaseUrl);
  if (!enabled(environment.BUZZ_MODEL_PROXY_ENABLED)) return direct;
  if (!enabled(environment.BUZZ_TELEMETRY_ENABLED)) {
    diagnostic("model proxy disabled because telemetry is not enabled");
    return direct;
  }
  if (!upstreamBaseUrl) {
    diagnostic("model proxy unavailable (ZCode upstream is missing); using direct upstream");
    return direct;
  }

  const executable = environment.BUZZ_MODEL_PROXY_BIN;
  if (!executable || !path.isAbsolute(executable)) {
    diagnostic("model proxy unavailable (absolute executable required); using direct upstream");
    return direct;
  }

  const required = [
    environment.BUZZ_TELEMETRY_URL,
    environment.BUZZ_TELEMETRY_TOKEN_FILE,
    environment.BUZZ_TELEMETRY_IDENTITY_SALT_FILE,
    environment.BUZZ_TELEMETRY_ENDPOINT_ID,
  ];
  if (required.some((value) => !value)) {
    diagnostic(
      "model proxy unavailable (telemetry configuration incomplete); using direct upstream",
    );
    return direct;
  }

  const child = spawn(
    executable,
    [
      "--upstream",
      upstreamBaseUrl,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--collector-url",
      environment.BUZZ_TELEMETRY_URL!,
      "--token-file",
      environment.BUZZ_TELEMETRY_TOKEN_FILE!,
      "--identity-salt-file",
      environment.BUZZ_TELEMETRY_IDENTITY_SALT_FILE!,
      "--harness",
      "zcode",
      "--model",
      model ?? "unknown",
      "--endpoint-id",
      environment.BUZZ_TELEMETRY_ENDPOINT_ID!,
    ],
    {
      env: proxyEnvironment(environment),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const timeoutMs = boundedNumber(
    environment.BUZZ_MODEL_PROXY_STARTUP_TIMEOUT_MS,
    3_000,
    100,
    30_000,
  );

  const listeningUrl = await new Promise<string | null>((resolve) => {
    let settled = false;
    let output = "";
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > 4_096) return finish(null);
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const match = /^Buzz OpenAI timing proxy listening on (http:\/\/\S+)$/.exec(
        output.slice(0, newline).trim(),
      );
      finish(match?.[1] ?? null);
    };
    const onError = () => finish(null);
    const onExit = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  const listener = validLoopbackListener(listeningUrl);
  if (!listener) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    diagnostic("model proxy unavailable (startup failed); using direct upstream");
    return direct;
  }
  child.stdout?.resume();

  let stopping = false;
  return {
    active: true,
    modelBaseUrl: new URL("/", listener).toString().replace(/\/$/, ""),
    contextUrl: new URL("/__buzz/context", listener).toString(),
    child,
    async stop() {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const completed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (!completed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}
