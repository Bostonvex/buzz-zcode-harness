/** Tests added by the buzz-zcode-harness fork. */

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildBuzzManifest,
  installBuzzManifest,
  uninstallBuzzManifest,
} from "../src/buzz-manifest.js";

describe("Buzz custom-harness manifest", () => {
  it("builds a secret-free absolute launch configuration", () => {
    const manifest = buildBuzzManifest({
      model: "example-model",
      nodeBin: "/opt/node/bin/node",
      zcodeBin: "/opt/zcode/zcode.cjs",
    });
    expect(manifest.command).toBe("/opt/node/bin/node");
    expect(manifest.args[0]).toMatch(/\/index\.js$/);
    expect(manifest.env).toEqual({
      ZCODE_BIN: "/opt/zcode/zcode.cjs",
      ZCODE_MODEL: "example-model",
    });
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain("api_key");
  });

  it("backs up replacement and removal instead of deleting manifests", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "buzz-zcode-manifest-"));
    const first = installBuzzManifest({ buzzDataDir: dataDir, model: "first-model" });
    expect(JSON.parse(readFileSync(first.destination, "utf8"))).toMatchObject({ id: "zcode" });
    const second = installBuzzManifest({ buzzDataDir: dataDir, model: "second-model" });
    expect(second.backup).toBeTruthy();
    const removed = uninstallBuzzManifest(dataDir);
    expect(removed.removed).toBe(true);
    expect(removed.backup).toBeTruthy();
  });
});
