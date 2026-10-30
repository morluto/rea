import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import { HopperClient } from "../../../src/hopper/HopperClient.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import {
  GhidraFixtureLauncher,
  ghidraFixturePath,
} from "./ghidra/ghidraClient.fixture.js";
import { HopperFixtureLauncher } from "./hopper/hopperClient.fixture.js";

const providers = [
  {
    name: "Ghidra",
    cancelled: { kind: "cancelled" },
    create() {
      const fixture = new GhidraFixtureLauncher();
      const client = new GhidraClient({
        launcher: fixture,
        targetPath: ghidraFixturePath,
        targetSha256: createHash("sha256")
          .update(readFileSync(ghidraFixturePath))
          .digest("hex"),
        providerVersion: "12.1.4",
        profileDigest: "a".repeat(64),
        startupTimeoutMs: 10_000,
      });
      return {
        client,
        roots: fixture.runtimeRoots,
        children: fixture.processes,
      };
    },
  },
  {
    name: "Hopper",
    cancelled: { _tag: "HopperCancelledError" },
    create() {
      const fixture = new HopperFixtureLauncher();
      const client = new HopperClient({
        launcher: fixture,
        startupTimeoutMs: 10_000,
      });
      return {
        client,
        roots: fixture.directories,
        children: fixture.processes,
      };
    },
  },
];

it.each(providers)(
  "cancels a $name restart wait without taking ownership of pending close",
  async ({ create, cancelled }) => {
    const { client, roots, children } = create();
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    const originalClose = PrivateRuntimeRoot.prototype.close;
    const close = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(async function (this: PrivateRuntimeRoot) {
        if (this.path === roots[0]) {
          entered.resolve();
          await gate.promise;
        }
        await originalClose.call(this);
      });
    let closing: ReturnType<typeof client.close> | undefined;
    try {
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      closing = client.close();
      await entered.promise;
      const controller = new AbortController();
      const retry = client.start(controller.signal);
      let settled: Awaited<typeof retry> | undefined;
      void retry.then((result) => {
        settled = result;
      });
      controller.abort();
      await vi.waitFor(() =>
        expect(settled).toMatchObject({ ok: false, error: cancelled }),
      );
      await expect(access(roots[0] ?? "")).resolves.toBeUndefined();
      expect(children).toHaveLength(1);
      gate.resolve();
      await expect(closing).resolves.toMatchObject({ ok: true });
      await retry;
      await expect(access(roots[0] ?? "")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      expect(children).toHaveLength(2);
    } finally {
      gate.resolve();
      await closing;
      await client.close();
      close.mockRestore();
    }
  },
);
