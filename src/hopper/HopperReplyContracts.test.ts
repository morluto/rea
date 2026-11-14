import { expect, it } from "vitest";

import { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";
import {
  HOPPER_OPERATIONS_WITHOUT_REPLY_CONTRACT,
  hopperReplySchemas,
  parseHopperReply,
} from "./HopperReplyContracts.js";

it("assigns every Hopper operation either a reply contract or the shrinking pending list", () => {
  const contracted = Object.keys(hopperReplySchemas);
  const pending: readonly string[] = HOPPER_OPERATIONS_WITHOUT_REPLY_CONTRACT;

  expect(
    [...contracted, ...pending].sort(),
    "each operation is listed exactly once",
  ).toEqual([...HOPPER_OPERATIONS].sort());
  expect(
    pending.length,
    "the pending list only shrinks; add a reply contract instead of an entry",
  ).toBeLessThanOrEqual(9);
});

it("returns the validated source reply without dropping unlisted fields", () => {
  const reply = [
    {
      address: "0x10",
      value: "text",
      provider_value: "text",
      provider_metadata: { section: "__cstring" },
    },
  ];

  const parsed = parseHopperReply("list_strings", reply);

  expect(parsed).toEqual({ ok: true, value: reply });
  expect(parsed.ok && parsed.value).toBe(reply);
});

it("names the requesting operation and the bridge method in a contract failure", () => {
  const parsed = parseHopperReply(
    "list_procedures",
    [{ address: "0x10" }],
    "search_procedures",
  );

  expect(parsed.ok ? undefined : parsed.error).toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "search_procedures",
    message: expect.stringContaining("list_procedures contract"),
  });
});
