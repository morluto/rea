import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";

const ORIGINAL_39_SHA256 =
  "43ffddd91b775a3e00fb736c6b1a644210e5917a1e1f02745d0283ac6ab99db4";

describe("original tool contract snapshot", () => {
  it("preserves every original name, description, kind, and complete JSON schema", () => {
    const projection = [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
    ].map((contract) => ({
      name: contract.name,
      description: contract.description,
      kind: contract.kind,
      inputSchema: z.toJSONSchema(contract.inputSchema, {
        target: "draft-07",
        unrepresentable: "any",
      }),
    }));
    expect(projection).toHaveLength(39);
    expect(
      createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    ).toBe(ORIGINAL_39_SHA256);
  });

  it("keeps exactly three additive session contracts", () => {
    expect(
      SESSION_TOOL_CONTRACTS.map(({ name, kind }) => ({ name, kind })),
    ).toEqual([
      { name: "open_binary", kind: "session" },
      { name: "close_binary", kind: "session" },
      { name: "binary_session", kind: "session" },
    ]);
  });
});
