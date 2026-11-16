import { expect, it } from "vitest";

import {
  HopperCancelledError,
  HopperProcessError,
  HopperProtocolError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
} from "./HopperErrors.js";

it("omits a cause when the caller does not supply one", () => {
  const error = new HopperCancelledError();

  expect(error._tag).toBe("HopperCancelledError");
  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(false);
});

it("retains an explicitly undefined cause separately from omission", () => {
  const error = new HopperCancelledError(undefined, {
    diagnostics: { stage: "queue" },
  });

  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(true);
  expect(error.diagnostics).toEqual({ stage: "queue" });
});

it("retains an opaque caller reason by identity", () => {
  const reason = { source: "caller", opaque: 7 };
  const error = new HopperCancelledError(reason);

  expect(error.cause).toBe(reason);
});

it("reports a stopped or unstartable bridge as a provider-wide failure", () => {
  expect(new HopperProcessError(1).providerWide).toBe(true);
  expect(new HopperStartError().providerWide).toBe(true);
  expect(new HopperRemoteError(2, "bad address").providerWide).toBe(false);
  expect(new HopperTimeoutError(10, "decompile").providerWide).toBe(false);
  expect(new HopperProtocolError("malformed").providerWide).toBe(false);
  expect(new HopperCancelledError().providerWide).toBe(false);
});
