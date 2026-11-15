import { describe, expect, it } from "vitest";

import {
  createFieldGlossaryCache,
  FIELD_GLOSSARY_CACHE_BUDGET,
  FIELD_GLOSSARY_CACHE_MAX_RECORDS,
  type FieldGlossaryIdentity,
} from "./fieldGlossaryCache.js";
import type { ParsedFieldGlossaryRecord } from "./parseFieldDiscovery.js";

const identity = (overrides: Partial<FieldGlossaryIdentity> = {}) => ({
  path: "/fixture/tshark",
  sha256: "a".repeat(64),
  versionBanner: "tshark (Wireshark) 4.6.9",
  ...overrides,
});

const record = (
  overrides: Partial<ParsedFieldGlossaryRecord> = {},
): ParsedFieldGlossaryRecord => ({
  source_line: 1,
  kind: "protocol",
  name: "frame",
  abbreviation: "frame",
  field_type: null,
  parent_protocol: null,
  display_base: null,
  bitmask: null,
  description: null,
  sourceByteLength: 12,
  ...overrides,
});

describe("field glossary cache", () => {
  it("misses until stored, then hits for the same tool identity", () => {
    const cache = createFieldGlossaryCache();
    expect(cache.lookup(identity())).toBeUndefined();
    expect(cache.store(identity(), [record()])).toBe(true);
    expect(cache.lookup(identity())).toHaveLength(1);
  });

  it("invalidates when any identity fact changes", () => {
    const cache = createFieldGlossaryCache();
    cache.store(identity(), [record()]);
    expect(cache.lookup(identity({ path: "/other/tshark" }))).toBeUndefined();
    expect(cache.lookup(identity({ sha256: "b".repeat(64) }))).toBeUndefined();
    expect(
      cache.lookup(identity({ versionBanner: "tshark (Wireshark) 4.6.8" })),
    ).toBeUndefined();
    expect(cache.lookup(identity())).toHaveLength(1);
  });

  it("replaces the previous identity on store", () => {
    const cache = createFieldGlossaryCache();
    cache.store(identity(), [record()]);
    cache.store(identity({ sha256: "b".repeat(64) }), [record(), record()]);
    expect(cache.lookup(identity())).toBeUndefined();
    expect(cache.lookup(identity({ sha256: "b".repeat(64) }))).toHaveLength(2);
  });

  it("refuses a glossary over the source-bytes budget", () => {
    const cache = createFieldGlossaryCache();
    const oversized = record({
      sourceByteLength: FIELD_GLOSSARY_CACHE_BUDGET + 1,
    });
    expect(cache.store(identity(), [oversized])).toBe(false);
    expect(cache.lookup(identity())).toBeUndefined();
  });

  it("refuses a glossary over the record-count budget", () => {
    const cache = createFieldGlossaryCache();
    const many = new Array<ParsedFieldGlossaryRecord>(
      FIELD_GLOSSARY_CACHE_MAX_RECORDS + 1,
    ).fill(record());
    expect(cache.store(identity(), many)).toBe(false);
    expect(cache.lookup(identity())).toBeUndefined();
  });

  it("drops the entry on clear", () => {
    const cache = createFieldGlossaryCache();
    cache.store(identity(), [record()]);
    cache.clear();
    expect(cache.lookup(identity())).toBeUndefined();
  });
});
