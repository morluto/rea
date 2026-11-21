import { describe, expect, it } from "vitest";

import {
  isGhidraInventoryOperation,
  parseGhidraInventoryResult,
} from "../../../../src/ghidra/GhidraInventoryValues.js";
import {
  GHIDRA_SESSION_CAPABILITIES,
  isGhidraShutdownAcknowledgement,
  parseGhidraSessionInfo,
} from "../../../../src/ghidra/GhidraSessionValues.js";
import {
  FAKE_GHIDRA_CAPABILITIES,
  FAKE_GHIDRA_INVENTORY_METHODS,
  FAKE_GHIDRA_SHUTDOWN_ACK,
  fakeGhidraAddressNameReply,
  fakeGhidraFileOffsetReply,
  fakeGhidraInventoryReply,
  fakeGhidraSessionInfo,
} from "../../../fixtures/fakeGhidraReplies.mjs";

// Client, provider and public MCP regressions run against this fake bridge; a
// reply outside the real bridge's contract fails them as an unreadable reply
// or a refused handshake instead of exercising the workflow.

const identity = {
  runId: "00000000-0000-4000-8000-000000000000",
  providerVersion: "12.1.4",
  profileDigest: "a".repeat(64),
  targetSha256: "b".repeat(64),
};

describe("fake Ghidra handshake", () => {
  it("advertises exactly the session capabilities the bridge proves", () => {
    expect([...FAKE_GHIDRA_CAPABILITIES].sort()).toEqual(
      [...GHIDRA_SESSION_CAPABILITIES].sort(),
    );
  });

  it.each([
    ["unix-socket", false, false],
    ["unix-socket", true, false],
    ["authenticated-loopback-tcp", false, true],
  ] as const)(
    "serves a %s session (timed out: %s) the identity admission accepts",
    (transport, timedOut, expectedReadOnly) => {
      const parsed = parseGhidraSessionInfo(
        fakeGhidraSessionInfo({ ...identity, transport, timedOut }),
        { ...identity, expectedReadOnly },
      );
      expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
    },
  );

  it("acknowledges shutdown as the bridge does", () => {
    expect(isGhidraShutdownAcknowledgement(FAKE_GHIDRA_SHUTDOWN_ACK)).toBe(
      true,
    );
  });
});

describe("fake Ghidra inventory replies", () => {
  it.each(FAKE_GHIDRA_INVENTORY_METHODS)(
    "serves a %s reply the inventory contract admits",
    (method) => {
      expect(isGhidraInventoryOperation(method)).toBe(true);
      if (!isGhidraInventoryOperation(method)) return;
      const reply = fakeGhidraInventoryReply(method);
      expect(reply).toBeDefined();
      if (reply === undefined) return;
      const parsed = parseGhidraInventoryResult(method, reply, null);
      expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
    },
  );

  it.each([{ limit: 1 }, { limit: 1, cursor: "fixture-second-page" }])(
    "serves byte-search pages the contract admits for %o",
    (params) => {
      const reply = fakeGhidraInventoryReply("search_bytes", params);
      if (reply === undefined) throw new Error("search_bytes has no reply");
      const parsed = parseGhidraInventoryResult("search_bytes", reply, null);
      expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
    },
  );

  it("serves a mapped file offset the contract admits", () => {
    const reply = fakeGhidraFileOffsetReply("0x1004");
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) return;
    const parsed = parseGhidraInventoryResult(
      "address_to_file_offset",
      reply.result,
      null,
    );
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
  });

  it("serves an applied name edit the naming contract admits", () => {
    const parsed = parseGhidraInventoryResult(
      "set_address_name",
      fakeGhidraAddressNameReply({ address: "0x1000", name: "changed" }),
      { keys: ["0x1000"] },
    );
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
  });
});
