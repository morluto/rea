import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isAbortOf, isAbortWithReason } from "./SignalAbort.js";

it("recognises Node's abort error for this signal's reason", async () => {
  const controller = new AbortController();
  const reason = { caller: "stop" };
  controller.abort(reason);
  const cause = await readFile(fileURLToPath(import.meta.url), {
    signal: controller.signal,
  }).catch((failure: unknown) => failure);
  expect(isAbortOf(cause, controller.signal)).toBe(true);
  expect(isAbortOf(reason, controller.signal)).toBe(true);
});

it("recognises a NaN abort reason, which === never matches", async () => {
  const controller = new AbortController();
  controller.abort(Number.NaN);
  const cause = await readFile(fileURLToPath(import.meta.url), {
    signal: controller.signal,
  }).catch((failure: unknown) => failure);
  expect(isAbortOf(cause, controller.signal)).toBe(true);
  expect(isAbortOf(Number.NaN, controller.signal)).toBe(true);
});

it("does not claim another reason's abort or an unaborted signal", () => {
  const foreign = new DOMException("aborted", "AbortError");
  const envelope = Object.assign(new Error("aborted", { cause: "other" }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
  const controller = new AbortController();
  expect(isAbortOf(envelope, controller.signal)).toBe(false);
  controller.abort("mine");
  expect(isAbortOf(envelope, controller.signal)).toBe(false);
  expect(isAbortOf(foreign, controller.signal)).toBe(false);
  expect(isAbortOf("mine", undefined)).toBe(false);
  expect(isAbortWithReason(envelope, "other")).toBe(true);
});
