import { expect, it } from "vitest";
import { z } from "zod";
import {
  freezeOwnedJsonTreeSnapshot,
  isImmutableJsonSnapshot,
} from "../immutableJson.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";

const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_python_pyc",
  normalizedResult,
  sealedResult: true,
  limitations: [],
});

it("does not trust a caller's sealed flag or shallow freeze for mutable facts", () => {
  const item = { value: "valid" };
  const source = Object.freeze({ items: [item] });
  const read = createAnalysisViewResultReader(
    z.strictObject({
      items: z.array(z.strictObject({ value: z.literal("valid") })),
    }),
  );
  expect(read(parent(source)).ok).toBe(true);
  item.value = "changed";
  expect(read(parent(source)).ok).toBe(false);
});

it("keeps schema-specific normalized facts separate without mutating sealed source", () => {
  const source = freezeOwnedJsonTreeSnapshot({});
  const first = createAnalysisViewResultReader(
    z.strictObject({
      value: z.string().default("first"),
    }),
  );
  const second = createAnalysisViewResultReader(
    z.strictObject({
      value: z.string().default("second"),
    }),
  );
  const a = first(parent(source));
  const b = second(parent(source));
  expect(a).toEqual({ ok: true, value: { value: "first" } });
  expect(b).toEqual({ ok: true, value: { value: "second" } });
  expect(source).toEqual({});
  if (a.ok && b.ok) {
    expect(isImmutableJsonSnapshot(a.value)).toBe(true);
    expect(isImmutableJsonSnapshot(b.value)).toBe(true);
  }
});

it("borrows a sealed JSON source with an omitted optional field", () => {
  const source = freezeOwnedJsonTreeSnapshot({});
  const schema = z.strictObject({ optional: z.string().optional() });
  const read = createAnalysisViewResultReader(schema);
  const result = read(parent(source));
  if (!result.ok) throw result.error;
  expect(result.value).toBe(source);
  expect(Object.hasOwn(result.value, "optional")).toBe(false);
});

it("reuses normalized facts only when the parent carries the owning seal", () => {
  const source = freezeOwnedJsonTreeSnapshot({});
  const sealed = parent(source);
  const unsealed = { ...sealed, sealedResult: false };
  let revision = "initial";
  const read = createAnalysisViewResultReader(
    z.strictObject({}).transform(() => ({ revision })),
  );

  expect(read(unsealed)).toEqual({ ok: true, value: { revision: "initial" } });
  revision = "sealed";
  expect(read(sealed)).toEqual({ ok: true, value: { revision: "sealed" } });
  revision = "latest";
  expect(read(sealed)).toEqual({ ok: true, value: { revision: "sealed" } });
  expect(read(unsealed)).toEqual({ ok: true, value: { revision: "latest" } });
});

it("preserves explicit undefined normalization without freezing or caching non-JSON facts", () => {
  const source = freezeOwnedJsonTreeSnapshot({});
  const produced: { optional: undefined }[] = [];
  const schema = z.strictObject({}).transform(() => {
    const facts = { optional: undefined };
    produced.push(facts);
    return facts;
  });
  const read = createAnalysisViewResultReader(schema);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = read(parent(source));
    if (!result.ok) throw result.error;
    expect(result.value).toBe(produced[attempt]);
    expect(Object.hasOwn(result.value, "optional")).toBe(true);
    expect(result.value.optional).toBeUndefined();
    expect(Object.isFrozen(result.value)).toBe(false);
    expect(isImmutableJsonSnapshot(result.value)).toBe(false);
  }
  expect(produced).toHaveLength(2);
  expect(produced[0]).not.toBe(produced[1]);
  expect(source).toEqual({});
  expect(Object.hasOwn(source, "optional")).toBe(false);
});
