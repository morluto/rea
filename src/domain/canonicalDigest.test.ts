import { createHash } from "node:crypto";

import { fc, it } from "@fast-check/vitest";
import canonicalize from "canonicalize";
import { describe, expect } from "vitest";

import {
  CanonicalDigestError,
  digestCanonicalValue,
  serializeCanonicalValue,
} from "./canonicalDigest.js";

const strictDigest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("Unserializable fixture");
  return createHash("sha256").update(encoded).digest("hex");
};

describe("incremental canonical digest", () => {
  it.prop([fc.jsonValue()])(
    "preserves canonicalize digests for JSON values",
    (value) => {
      expect(digestCanonicalValue(value)).toBe(strictDigest(value));
      expect(serializeCanonicalValue(value)).toBe(canonicalize(value));
    },
  );

  it("preserves Unicode ordering, escaping, numeric forms and non-JSON normalization", () => {
    const shared = { key: "value" };
    const sparse: unknown[] = [undefined, Symbol("omit"), () => undefined];
    sparse.length = 6;
    // Frozen canonicalize 3 output for data outside the strict JSON profile.
    const fixtures: [unknown, string][] = [
      [
        { "\uE000": "BMP", "\u{10000}": "supplementary" },
        '{"𐀀":"supplementary","":"BMP"}',
      ],
      [{ "\ud800": "\udc00" }, '{"\\ud800":"\\udc00"}'],
      [
        {
          "€": "\ud800",
          "😀": "\udc00",
          "\r": '\n\t"\\',
          number: -0,
          exponent: 1e30,
        },
        '{"\\r":"\\n\\t\\"\\\\","exponent":1e+30,"number":0,"€":"\\ud800","😀":"\\udc00"}',
      ],
      [
        { omitted: undefined, symbol: Symbol("omit"), fn: () => undefined },
        '{"fn":undefined}',
      ],
      [sparse, "[null,null,,,,]"],
      [[shared, shared], '[{"key":"value"},{"key":"value"}]'],
      [new Date("2026-10-06T00:00:00Z"), '"2026-10-06T00:00:00.000Z"'],
      [{ toJSON: () => ({ b: 2, a: [1, null] }) }, '{"a":[1,null],"b":2}'],
      [{ nested: { toJSON: () => undefined } }, '{"nested":undefined}'],
    ];
    for (const [value, expected] of fixtures) {
      expect(serializeCanonicalValue(value)).toBe(expected);
      expect(digestCanonicalValue(value)).toBe(
        createHash("sha256").update(expected).digest("hex"),
      );
    }
  });

  it("rejects unsupported roots, non-finite numbers, BigInt and ancestor cycles", () => {
    for (const value of [undefined, Symbol("root"), () => undefined])
      expect(() => digestCanonicalValue(value, "Fixture")).toThrow(
        "Fixture could not canonicalize data",
      );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const recursiveJson = { toJSON: (): unknown => recursiveJson };
    for (const [value, code] of [
      [Number.NaN, "nan"],
      [Number.POSITIVE_INFINITY, "infinity"],
      [Number.NEGATIVE_INFINITY, "infinity"],
      [cyclic, "circular"],
      [recursiveJson, "circular"],
    ] as const) {
      let failure: unknown;
      try {
        digestCanonicalValue(value);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(CanonicalDigestError);
      expect(failure).toMatchObject({ _tag: "CanonicalDigestError", code });
    }
    expect(() => digestCanonicalValue(1n)).toThrow();
  });

  it("preserves canonical bytes across large keys, repeated leaves and buffer flushes", () => {
    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i += 1) manyKeys[`k${i}`] = i;
    const value = {
      keys: manyKeys,
      payload: Array.from({ length: 64 }, () => "x".repeat(16_384)),
      tail: ["€", "😀", "x".repeat(9000)],
    };
    expect(digestCanonicalValue(value)).toBe(strictDigest(value));
  });

  it("preserves canonicalize property access and toJSON cycle behavior", () => {
    const createAccessor = () => {
      let reads = 0;
      return {
        get value() {
          reads += 1;
          return reads;
        },
      };
    };
    expect(digestCanonicalValue(createAccessor())).toBe(
      createHash("sha256").update('{"value":3}').digest("hex"),
    );
    const shared = { toJSON: () => ({ answer: 42 }) };
    expect(digestCanonicalValue([shared, shared])).toBe(
      strictDigest([shared, shared]),
    );
  });
});
