import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readBinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";

const resourceScope: RetainedResourceScope = {
  run: (operation) => operation(),
  retain: () => {
    throw new Error("Unexpected retained descriptor");
  },
};
const fixture = async () => {
  const root = await createTestTempDirectory("rea-bn-registration-");
  const path = join(root, "mcp.json");
  const registration = JSON.stringify({ url: "http://127.0.0.1:24642/mcp" });
  await writeFile(path, registration);
  return { root, path, registration };
};
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Binary Ninja registration ownership", () => {
  it.each([
    { "bad name": "secret-header-value" },
    { "": "secret-header-value" },
    { Authorization: "Bearer secret-header-value\r\ninjected: true" },
    { Authorization: "Bearer secret-header-value\u0100" },
  ])(
    "rejects invalid Fetch headers without exposing credentials: %#",
    async (headers) => {
      const { path } = await fixture();
      await writeFile(
        path,
        JSON.stringify({ url: "http://127.0.0.1:24642/mcp", headers }),
      );
      const result = await readBinaryNinjaConfiguration(path, {
        resourceScope,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "ConfigurationError",
          message: expect.stringContaining("headers"),
          settings: [{ setting: "REA_BINARY_NINJA_MCP_CONFIG" }],
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret-header-value");
      if (!result.ok) expect(result.error.cause).toBeUndefined();
    },
  );

  it("normalizes Fetch header names and values before returning a registration", async () => {
    const { path } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:24642/mcp",
        headers: {
          Authorization: "  Bearer test-token \t",
          "X-Analysis": " ordinary text ",
        },
      }),
    );
    const result = await readBinaryNinjaConfiguration(path, { resourceScope });
    expect(result).toMatchObject({
      ok: true,
      value: {
        headers: {
          authorization: "Bearer test-token",
          "x-analysis": "ordinary text",
        },
      },
    });
  });

  it("bounds the descriptor read and rejects non-regular inputs", async () => {
    const { root, path, registration } = await fixture();
    await writeFile(path, registration.padEnd(65_536));
    expect(
      (await readBinaryNinjaConfiguration(path, { resourceScope })).ok,
    ).toBe(true);
    await writeFile(path, registration.padEnd(65_537));
    expect(
      await readBinaryNinjaConfiguration(path, { resourceScope }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("64 KiB") },
    });
    expect(
      await readBinaryNinjaConfiguration(root, { resourceScope }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("regular JSON file") },
    });
  });

  it("preserves cancellation without starting the file read", async () => {
    const { path } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancel Binary Ninja registration");
    controller.abort(reason);
    await expect(
      readBinaryNinjaConfiguration(path, {
        resourceScope,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
  });

  it("retains a denied descriptor close until its exact owner retries", async () => {
    const { path } = await fixture();
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      run: (operation) => operation(),
      retain: (resource) => retained.push(resource),
    };
    const close = OwnedFileHandle.prototype.close;
    let denied = false;
    vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
      this: OwnedFileHandle,
    ) {
      if (!denied) {
        denied = true;
        return Promise.reject(new Error("close denied"));
      }
      return close.call(this);
    });
    const result = await readBinaryNinjaConfiguration(path, {
      resourceScope: owner,
    });
    if (result.ok) throw new Error("Expected close failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(retained).toHaveLength(1);
    await rm(path);
    await retained[0]!.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  });
});
