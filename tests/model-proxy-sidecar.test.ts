import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  modelChildEnvironment,
  startModelProxySidecar,
  type ModelProxySidecar,
} from "../src/model-proxy-sidecar.js";

const proxies: ModelProxySidecar[] = [];

function fakeProxy(directory: string, firstLine: string): string {
  const executable = path.join(directory, "fake-model-proxy");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const forbidden = ["ANTHROPIC_API_KEY", "BUZZ_PRIVATE_KEY", "BUZZ_TELEMETRY_TOKEN_FILE"];
if (forbidden.some((key) => process.env[key])) process.exit(41);
process.stdout.write(${JSON.stringify(`${firstLine}\n`)});
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return executable;
}

function environment(executable: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    BUZZ_MODEL_PROXY_ENABLED: "1",
    BUZZ_MODEL_PROXY_BIN: executable,
    BUZZ_TELEMETRY_ENABLED: "1",
    BUZZ_TELEMETRY_URL: "http://127.0.0.1:7900/api/v1/events",
    BUZZ_TELEMETRY_TOKEN_FILE: "/private/test/token",
    BUZZ_TELEMETRY_IDENTITY_SALT_FILE: "/private/test/salt",
    BUZZ_TELEMETRY_ENDPOINT_ID: "test-endpoint",
    BUZZ_PRIVATE_KEY: "must-not-reach-proxy",
    ANTHROPIC_API_KEY: "must-not-reach-proxy",
  };
}

afterEach(async () => {
  await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.stop()));
});

describe("ZCode model proxy sidecar", () => {
  it("starts an isolated loopback proxy for an Anthropic base URL", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "zcode-model-proxy-"));
    try {
      const proxy = await startModelProxySidecar({
        upstreamBaseUrl: "https://model.example.test/api/anthropic",
        model: "zcode-test",
        environment: environment(
          fakeProxy(directory, "Buzz OpenAI timing proxy listening on http://127.0.0.1:43125"),
        ),
      });
      proxies.push(proxy);
      expect(proxy.active).toBe(true);
      expect(proxy.modelBaseUrl).toBe("http://127.0.0.1:43125");
      expect(proxy.contextUrl).toBe("http://127.0.0.1:43125/__buzz/context");
    } finally {
      await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.stop()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails open to the direct endpoint when startup output is invalid", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "zcode-model-proxy-fail-"));
    const diagnostics: string[] = [];
    try {
      const proxy = await startModelProxySidecar({
        upstreamBaseUrl: "https://model.example.test/api/anthropic",
        model: "zcode-test",
        environment: environment(fakeProxy(directory, "unexpected output")),
        diagnostic: (message) => diagnostics.push(message),
      });
      expect(proxy.active).toBe(false);
      expect(proxy.modelBaseUrl).toBe("https://model.example.test/api/anthropic");
      expect(diagnostics.join("\n")).toContain("using direct upstream");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps provider credentials but strips telemetry controls from the backend", () => {
    const child = modelChildEnvironment(
      {
        ANTHROPIC_API_KEY: "provider-key",
        BUZZ_PRIVATE_KEY: "seat-key",
        BUZZ_TELEMETRY_TOKEN_FILE: "/private/token",
        BUZZ_MODEL_PROXY_BIN: "/private/proxy",
        ZCODE_BASE_URL: "https://direct.example.test/api/anthropic",
      },
      "http://127.0.0.1:43125",
    );
    expect(child).toEqual({
      ANTHROPIC_API_KEY: "provider-key",
      BUZZ_PRIVATE_KEY: "seat-key",
      ZCODE_BASE_URL: "http://127.0.0.1:43125",
    });
  });
});
