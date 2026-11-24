import { expect, it } from "vitest";

import { SIZE_AWARE_INLINE_EVIDENCE_BYTES } from "../contracts/analysisDetail.js";
import type { Evidence } from "../domain/evidence.js";
import { deliversRetainedSummary } from "./retainedSummaryDelivery.js";

/** A record whose UTF-8 JSON is exactly `bytes` long, with escaped and multibyte text. */
const recordOfBytes = (bytes: number): Evidence => {
  const text = 'é"\n\u{1F600}';
  const base = { normalized_result: { text, padding: "" } };
  const used = Buffer.byteLength(JSON.stringify(base));
  const record = {
    normalized_result: { text, padding: "x".repeat(bytes - used) },
  };
  expect(Buffer.byteLength(JSON.stringify(record))).toBe(bytes);
  return record as unknown as Evidence;
};

const sized = { sizeAware: true, retained: true, pageable: true } as const;

it("inlines omitted size-aware detail through exactly 32 KiB and summarizes one byte more", () => {
  expect(
    deliversRetainedSummary(
      undefined,
      recordOfBytes(SIZE_AWARE_INLINE_EVIDENCE_BYTES),
      sized,
    ),
  ).toBe(false);
  expect(
    deliversRetainedSummary(
      undefined,
      recordOfBytes(SIZE_AWARE_INLINE_EVIDENCE_BYTES + 1),
      sized,
    ),
  ).toBe(true);
});

it("summarizes large Evidence only when it is retained, pageable and size-aware", () => {
  const large = recordOfBytes(SIZE_AWARE_INLINE_EVIDENCE_BYTES + 1);
  for (const missing of ["sizeAware", "retained", "pageable"] as const)
    expect(
      deliversRetainedSummary(undefined, large, { ...sized, [missing]: false }),
    ).toBe(false);
  expect(deliversRetainedSummary("complete", large, sized)).toBe(false);
  const small = recordOfBytes(64);
  expect(
    deliversRetainedSummary("summary", small, {
      sizeAware: false,
      retained: false,
      pageable: false,
    }),
  ).toBe(true);
});
