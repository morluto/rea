import { expect, it } from "vitest";

import {
  parseHopperReply,
  hasHopperReplyContract,
} from "../../../../src/hopper/HopperReplyContracts.js";
import {
  FAKE_HOPPER_REPLY_METHODS,
  fakeHopperReply,
} from "../../../fixtures/fakeHopperReplies.mjs";

// The packaged CLI baseline and provider fixtures run against this fake
// bridge; a reply outside the real bridge's contract fails them as unreadable
// output instead of exercising the workflow.
it.each(FAKE_HOPPER_REPLY_METHODS)(
  "serves a %s reply the Hopper reply contract admits",
  (method) => {
    expect(hasHopperReplyContract(method)).toBe(true);
    if (!hasHopperReplyContract(method)) return;
    const reply = fakeHopperReply(method);
    expect(reply).toBeDefined();
    if (reply === undefined) return;
    const parsed = parseHopperReply(method, reply);
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
  },
);

it.each([
  ["resolve_containing_procedure", { address: "0x1004" }],
  ["procedure_references", { direction: "incoming" }],
] as const)("answers %s from the request's params", (method, params) => {
  const reply = fakeHopperReply(method, params);
  expect(reply).toMatchObject(
    method === "procedure_references"
      ? { direction: "incoming" }
      : { query_address: "0x1004" },
  );
  if (reply === undefined) return;
  const parsed = parseHopperReply(method, reply);
  expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
});
