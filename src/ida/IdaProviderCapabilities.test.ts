import { expect, it } from "vitest";

import { IDA_OPERATIONS, idaCapabilities } from "./IdaProviderCapabilities.js";

it("preserves live read-only capabilities when callers attempt to alter declarations", () => {
  const original = idaCapabilities("headless", true);
  Reflect.set(IDA_OPERATIONS, 0, "set_comment");
  Reflect.set(IDA_OPERATIONS, IDA_OPERATIONS.length, "set_address_name");

  expect(idaCapabilities("headless", true)).toEqual(original);
  expect(original.every(({ cachePolicy }) => cachePolicy === "live")).toBe(
    true,
  );
  expect(original.every(({ effects }) => !effects.mutatesArtifact)).toBe(true);
  expect(
    original.find(({ operation }) => operation === "procedure_callers"),
  ).toMatchObject({ available: false });
});
