import assert from "node:assert/strict";
import test from "node:test";
import { withCommands } from "./command-scope.mjs";
import { DarwinProcessOwnershipInspectionError } from "../dist/process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../dist/process/OwnedCommand.js";

await test("retains cancellation and the native preparation owner through cleanup retry", async () => {
  let denied = true,
    closes = 0,
    preparation,
    signal;
  const closeFailure = new Error("native helper close denied");
  const owner = {
    close: async () => {
      closes++;
      if (denied) throw closeFailure;
    },
  };
  const result = await withCommands(
    async (run, selected) => {
      signal = selected;
      await run(process.execPath, []);
    },
    {
      prepareOwnership: async (selected) => {
        process.emit("SIGINT");
        preparation = new DarwinProcessOwnershipInspectionError(
          "cancelled compiler with retained helper",
          { cleanupOwner: owner, cancellation: { reason: selected.reason } },
        );
        throw preparation;
      },
      runCommand: async () => {
        throw new Error("Target must not launch");
      },
    },
  ).then(
    () => {
      throw new Error("Expected failure");
    },
    (error) => error,
  );
  assert(result instanceof AggregateError);
  assert.equal(result.cause, preparation);
  assert(result.errors.includes(preparation));
  assert(
    result.errors.some(
      (error) =>
        error instanceof OwnedCommandFailure &&
        error.cancellation.reason === signal.reason,
    ),
  );
  assert.equal(preparation.cleanupOwner, owner);
  assert.equal(result.cleanupOwners.size, 1);
  assert.equal(closes, 1);
  denied = false;
  await result.retryCleanup();
  await result.retryCleanup();
  assert.equal(closes, 2);
  assert.equal(result.cleanupOwners.size, 0);
});
