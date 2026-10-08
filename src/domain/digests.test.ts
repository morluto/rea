import { describe, expect, it } from "vitest";

import {
  digestSchema,
  isDigest,
  isPrefixedDigest,
  prefixedDigestSchema,
} from "./digests.js";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

describe("digest shapes", () => {
  it("accepts a lowercase hex sha256", () => {
    expect(digestSchema.parse(DIGEST)).toBe(DIGEST);
    expect(isDigest(DIGEST)).toBe(true);
  });

  it.each([
    ["uppercase", DIGEST.toUpperCase()],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["prefixed", `ev_${DIGEST}`],
  ])("rejects a %s digest", (_label, value) => {
    expect(digestSchema.safeParse(value).success).toBe(false);
    expect(isDigest(value)).toBe(false);
  });

  it("rejects non-string values", () => {
    for (const value of [null, undefined, 42, {}, []])
      expect(isDigest(value)).toBe(false);
  });

  it("keeps identifier families apart", () => {
    expect(prefixedDigestSchema("ev").parse(`ev_${DIGEST}`)).toBe(
      `ev_${DIGEST}`,
    );
    // The point of the prefix: an identifier from one family must not satisfy
    // another, or a mis-pasted id would resolve to the wrong object.
    expect(prefixedDigestSchema("ev").safeParse(`art_${DIGEST}`).success).toBe(
      false,
    );
    expect(prefixedDigestSchema("ev").safeParse(DIGEST).success).toBe(false);
    expect(isPrefixedDigest(`ev_${DIGEST}`, "ev")).toBe(true);
    expect(isPrefixedDigest(`ev_${DIGEST}`, "art")).toBe(false);
  });

  it("distinguishes nested prefixes from their common ancestor", () => {
    // `jag_node_` must not validate as `jag_` even though it starts with it.
    expect(
      prefixedDigestSchema("jag").safeParse(`jag_node_${DIGEST}`).success,
    ).toBe(false);
    expect(prefixedDigestSchema("jag_node").parse(`jag_node_${DIGEST}`)).toBe(
      `jag_node_${DIGEST}`,
    );
    expect(prefixedDigestSchema("jag").parse(`jag_${OTHER_DIGEST}`)).toBe(
      `jag_${OTHER_DIGEST}`,
    );
  });
});
