import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";

import { expect, it, onTestFinished, vi } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type { BridgeSession } from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { failedInspectionDescriptor } from "../../../fixtures/processInspectionCleanup.js";
import {
  HopperFixtureLauncher,
  transportReplyContracts,
} from "./hopperClient.fixture.js";

/** Each identity read rejects with this cause while it is set. */
const rejections = vi.hoisted(() => ({
  startIdentity: undefined as unknown,
  exitIdentity: undefined as unknown,
}));

vi.mock(
  "../../../../src/process/ProcessOwnershipObservation.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../src/process/ProcessOwnershipObservation.js")
      >();
    return {
      ...original,
      observeProcessStartIdentity: async (
        ...arguments_: Parameters<typeof original.observeProcessStartIdentity>
      ) => {
        if (rejections.startIdentity !== undefined)
          throw rejections.startIdentity;
        return original.observeProcessStartIdentity(...arguments_);
      },
      observeProcessStartIdentityExit: async (
        ...arguments_: Parameters<
          typeof original.observeProcessStartIdentityExit
        >
      ) => {
        if (rejections.exitIdentity !== undefined)
          throw rejections.exitIdentity;
        return original.observeProcessStartIdentityExit(...arguments_);
      },
    };
  },
);

const stopFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};

/** A client whose fixture bridge runs as an authenticated external Hopper. */
const externalClient = () => {
  const fixture = new HopperFixtureLauncher();
  const client = new HopperClient({
    replyContracts: transportReplyContracts,
    startupTimeoutMs: 2_000,
    launcher: {
      async launch(session: BridgeSession) {
        const launched = await fixture.launch(session);
        if (!launched.ok) return launched;
        return ok({
          process: launched.value.process,
          ownsProcessLifetime: false as const,
          providerLifetime: "external-application" as const,
          shutdownMode: "bridge-request" as const,
        });
      },
    },
  });
  onTestFinished(async () => {
    rejections.startIdentity = undefined;
    rejections.exitIdentity = undefined;
    await client.close();
    for (const child of fixture.processes) await stopFixture(child);
    await Promise.all(
      fixture.directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });
  return client;
};

/** Close reports the descriptor until it closes, then the retry releases it. */
const expectRetainedUntilReleased = async (
  client: ReturnType<typeof externalClient>,
  descriptor: Awaited<ReturnType<typeof failedInspectionDescriptor>>,
): Promise<void> => {
  const refused = await client.close();
  if (refused.ok) throw new Error("Expected the retained descriptor");
  expect(
    refused.error.cleanupResources,
    "close names the descriptor it could not release",
  ).toContain(descriptor.path);
  const closesBefore = descriptor.closes();

  descriptor.allow();
  const released = await client.close();
  expect(
    descriptor.closes(),
    "the retry closes the same descriptor",
  ).toBeGreaterThan(closesBefore);
  expect(released.ok ? [] : released.error.cleanupResources).not.toContain(
    descriptor.path,
  );
};

it.skipIf(process.platform === "win32")(
  "retains the descriptor a failed bridge start-identity read left open until close releases it",
  async () => {
    const client = externalClient();
    const descriptor = await failedInspectionDescriptor();
    onTestFinished(() => descriptor.allow());

    rejections.startIdentity = descriptor.failure;
    const started = await client.start();
    rejections.startIdentity = undefined;
    if (!started.ok) throw started.error;

    await expectRetainedUntilReleased(client, descriptor);
  },
);

it.skipIf(process.platform === "win32")(
  "retains the descriptor a failed bridge exit-identity check left open during close",
  async () => {
    const client = externalClient();
    const descriptor = await failedInspectionDescriptor();
    onTestFinished(() => descriptor.allow());
    const started = await client.start();
    if (!started.ok) throw started.error;

    rejections.exitIdentity = descriptor.failure;
    const refused = client.close();
    await expect(
      refused,
      "close reports instead of rejecting",
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    rejections.exitIdentity = undefined;

    await expectRetainedUntilReleased(client, descriptor);
  },
);
