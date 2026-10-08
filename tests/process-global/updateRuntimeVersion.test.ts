import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("cross-spawn", () => ({ default: spawnMock }));

import { PRODUCT_IDENTITY } from "../../src/identity.js";
import { ok } from "../../src/domain/result.js";
import { systemUpdateHost } from "../../src/application/UpdateRuntime.js";

const installation = {
  prefix: "C:\\Users\\test\\AppData\\Roaming\\npm",
  packageRoot:
    "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\rea-agents",
};

const latestVersion = async (stdout: string) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  });

  return systemUpdateHost().latestVersion(installation);
};

describe("npm release lookup response formats", () => {
  beforeEach(() => spawnMock.mockReset());

  it("accepts npm 11's scalar JSON response", async () => {
    await expect(latestVersion('"6.0.0"')).resolves.toEqual(ok("6.0.0"));
  });

  it("accepts npm 12's singleton-array JSON response", async () => {
    await expect(latestVersion('["6.0.0"]')).resolves.toEqual(ok("6.0.0"));
  });

  it.each([
    ["empty array", "[]"],
    ["multiple versions", '["6.0.0", "6.0.1"]'],
    ["number", "6"],
    ["object", '{"version":"6.0.0"}'],
    ["null", "null"],
    ["malformed JSON", '"6.0.0'],
  ])("rejects %s response data", async (_description, stdout) => {
    await expect(latestVersion(stdout)).resolves.toMatchObject({ ok: false });
  });

  it("keeps the existing global registry query and scoped prefix", async () => {
    await latestVersion('["6.0.0"]');

    expect(spawnMock).toHaveBeenCalledWith(
      "npm",
      [
        "view",
        "--global",
        "--prefix",
        installation.prefix,
        PRODUCT_IDENTITY.packageName,
        "dist-tags.latest",
        "--json",
        "--fetch-retries=0",
        "--fetch-timeout=10000",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
