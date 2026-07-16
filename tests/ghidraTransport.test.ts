import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { observeGhidraEndpoint } from "../src/ghidra/GhidraTransport.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Ghidra local transport", () => {
  it("observes Unix readiness without interpreting endpoint content", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-ghidra-transport-"));
    roots.push(root);
    const path = join(root, "bridge.sock");

    await expect(
      observeGhidraEndpoint({ transport: "unix-socket", path }),
    ).resolves.toEqual({ ok: true, value: null });
    await writeFile(path, "fixture");
    await expect(
      observeGhidraEndpoint({ transport: "unix-socket", path }),
    ).resolves.toEqual({ ok: true, value: { path } });
  });

  it("accepts only an exact IPv4 loopback endpoint record", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-ghidra-transport-"));
    roots.push(root);
    const path = join(root, "bridge-endpoint.json");
    await writeFile(
      path,
      `${JSON.stringify({ schema_version: 1, host: "127.0.0.1", port: 49152 })}\n`,
    );

    await expect(
      observeGhidraEndpoint({
        transport: "authenticated-loopback-tcp",
        path,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 49152 },
    });
  });

  it.each([
    { schema_version: 1, host: "0.0.0.0", port: 49152 },
    { schema_version: 1, host: "127.0.0.1", port: 0 },
    { schema_version: 1, host: "127.0.0.1", port: 49152, token: "leak" },
  ])(
    "rejects an invalid or expanded TCP endpoint: $host:$port",
    async (value) => {
      const root = await mkdtemp(join(tmpdir(), "rea-ghidra-transport-"));
      roots.push(root);
      const path = join(root, "bridge-endpoint.json");
      await writeFile(path, JSON.stringify(value));

      await expect(
        observeGhidraEndpoint({
          transport: "authenticated-loopback-tcp",
          path,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: "start", message: "Ghidra TCP endpoint is invalid" },
      });
    },
  );
});
