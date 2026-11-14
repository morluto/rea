import { expect, it } from "vitest";

import { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";
import {
  hasHopperReplyContract,
  hopperBridgeMethod,
  parseHopperReply,
} from "./HopperReplyContracts.js";

it("gives every Hopper operation's bridge method a reply contract", () => {
  const missing = HOPPER_OPERATIONS.map(hopperBridgeMethod).filter(
    (method) => !hasHopperReplyContract(method),
  );

  expect(missing, "no Hopper reply reaches Evidence unvalidated").toEqual([]);
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
