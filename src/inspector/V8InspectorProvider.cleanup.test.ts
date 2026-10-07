import { expect, it } from "vitest";

import {
  closeInspectorConnection,
  inspectorCleanupError,
} from "./V8InspectorProvider.js";

it("returns promptly on cancellation while a V8 socket close is hung", async () => {
  const controller = new AbortController();
  let closeStarted = false;
  const closing = closeInspectorConnection(
    {
      close: () => {
        closeStarted = true;
        return new Promise<void>(() => undefined);
      },
    },
    controller.signal,
  );

  controller.abort();
  expect(closeStarted).toBe(true);
  await expect(closing).resolves.toBeUndefined();
});

it("maps a rejected close to incomplete cleanup and preserves the primary failure", () => {
  const primary = new Error("observation failed");
  const cleanup = new Error("socket close failed");
  const error = inspectorCleanupError(primary, cleanup, true);

  expect(error.reason).toBe("cleanup_failed");
  expect(error.cleanupIncomplete).toBe(true);
  expect(error.cleanupResources).toEqual(["browser_transport"]);
  expect(error.cause).toBeInstanceOf(AggregateError);
  if (!(error.cause instanceof AggregateError)) return;
  expect(error.cause.errors).toEqual([primary, cleanup]);
});
