import { expect, it } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import {
  OwnedMcpStdioTransport,
  type OwnedMcpLauncher,
} from "./OwnedMcpStdioTransport.js";

const transport = (launcher: OwnedMcpLauncher) =>
  new OwnedMcpStdioTransport(
    { command: "/fixture/server", arguments: [] },
    { provider: "fixture", label: "Fixture MCP", maxFrameBytes: 1024 },
    launcher,
  );

it("keeps a failed launch's transferred preparation cleanup until a close releases it", async () => {
  let closeFails = true;
  let closes = 0;
  const preparation = new DarwinProcessOwnershipInspectionError(
    "ownership-helper preparation was cancelled",
    {
      cleanupOwner: {
        close: async () => {
          closes += 1;
          if (closeFails) throw new Error("helper directory still in use");
        },
      },
    },
  );
  const owned = transport(async () => {
    throw preparation;
  });
  await expect(owned.start()).rejects.toBe(preparation);

  const first = await owned.close().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(first).toBeInstanceOf(ProviderCleanupError);
  const failure = first as ProviderCleanupError;
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.cleanupResources).toEqual(["process ownership inspection"]);
  expect(failure.diagnostics).toMatchObject({
    reason: "helper directory still in use",
  });

  closeFails = false;
  await expect(owned.close()).resolves.toBeUndefined();
  expect(failure.cleanupIncomplete).toBe(false);
  // A released owner is not closed again.
  await expect(owned.close()).resolves.toBeUndefined();
  expect(closes).toBe(2);
});

it("reports a failed launch's preparation cleanup failure that names no owner", async () => {
  const owned = transport(async () => {
    throw new DarwinProcessOwnershipInspectionError(
      "ownership-helper preparation failed",
      {
        cleanupFailure: new ProviderCleanupError("fixture", ["helper root"], {
          reason: "unremovable",
        }),
      },
    );
  });
  await expect(owned.start()).rejects.toBeInstanceOf(
    DarwinProcessOwnershipInspectionError,
  );
  const failure = await owned.close().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect((failure as ProviderCleanupError).cleanupIncomplete).toBe(true);
});

it("closes cleanly after a launch failure that transferred no cleanup", async () => {
  const owned = transport(async () => {
    throw new Error("command not found");
  });
  await expect(owned.start()).rejects.toThrow("command not found");
  await expect(owned.close()).resolves.toBeUndefined();
});
