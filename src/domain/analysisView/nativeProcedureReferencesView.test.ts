import { expect, it } from "vitest";

import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  procedureReferenceViewRequests,
  projectNativeProcedureReferencesView,
} from "./nativeProcedureReferencesView.js";

const PAGE_BYTES = 1024 * 1024;
const selected = {
  address: "0x1000",
  name: "selected",
  classification: null,
  body: { available: false as const, reason: "not reported" },
};
const parentFor = (
  references: readonly Record<string, unknown>[],
): AnalysisViewParent => ({
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "procedure_references",
  predicateType: "rea.analysis",
  limitations: [],
  parameters: {},
  normalizedResult: {
    procedure: selected,
    direction: "outgoing",
    reference_kinds_available: false,
    unresolved_calls: [],
    references,
  },
});
const edge = (
  sourceAddress: string,
  target: Record<string, unknown> | null,
) => ({
  source_address: sourceAddress,
  target_address: "0x2000",
  source_procedure: selected,
  target_procedure: target,
  kind: { available: false as const, reason: "not reported" },
});
const viewFor = (limit: number) =>
  procedureReferenceViewRequests.references.parse({
    kind: "native-procedure-references",
    collection: "references",
    offset: 0,
    limit,
  });
const pageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

it("omits an endpoint that no accepted row uses", () => {
  const projected = projectNativeProcedureReferencesView(
    parentFor([
      edge("0x1001", null),
      edge("0x1002", {
        ...selected,
        address: "0x3000",
        name: "x".repeat(1_048_000),
      }),
    ]),
    viewFor(8),
  );
  if (!projected.ok) throw projected.error;
  if (projected.value.kind !== "native-procedure-references")
    throw new Error("Expected a procedure-reference page");
  if (projected.value.items.collection !== "references")
    throw new Error("Expected reference rows");
  expect(projected.value.byte_limited).toBe(true);
  expect(projected.value.items.rows).toHaveLength(1);
  expect(projected.value.items.endpoints).toEqual([]);
  expect(pageBytes(projected.value)).toBeLessThanOrEqual(PAGE_BYTES);
});

it("recognizes a multibyte selected procedure after the page is partly full", () => {
  const multibyte = {
    ...selected,
    name: "雪".repeat(100_000),
  };
  const projected = projectNativeProcedureReferencesView(
    {
      ...parentFor([
        edge("0x1001", {
          ...selected,
          address: "0x3000",
          name: "y".repeat(500_000),
        }),
        edge("0x1002", multibyte),
      ]),
      normalizedResult: {
        procedure: multibyte,
        direction: "outgoing",
        reference_kinds_available: false,
        unresolved_calls: [],
        references: [
          {
            ...edge("0x1001", {
              ...selected,
              address: "0x3000",
              name: "y".repeat(500_000),
            }),
            source_procedure: null,
          },
          {
            ...edge("0x1002", multibyte),
            source_procedure: null,
          },
        ],
      },
    },
    viewFor(8),
  );
  if (!projected.ok) throw projected.error;
  if (projected.value.kind !== "native-procedure-references")
    throw new Error("Expected a procedure-reference page");
  if (projected.value.items.collection !== "references")
    throw new Error("Expected reference rows");
  expect(projected.value.items.rows).toHaveLength(2);
  expect(projected.value.items.rows[1]?.target_procedure).toEqual({
    kind: "selected-procedure",
  });
  expect(projected.value.items.endpoints).toHaveLength(1);
});

it("counts distinct shared endpoints inside the page allowance", () => {
  const projected = projectNativeProcedureReferencesView(
    parentFor(
      Array.from({ length: 40 }, (_, index) =>
        edge(`0x${(0x2000 + index).toString(16)}`, {
          ...selected,
          address: `0x${(0x8000 + index).toString(16)}`,
          name: "endpoint".repeat(4_000),
        }),
      ),
    ),
    viewFor(40),
  );
  if (!projected.ok) throw projected.error;
  if (projected.value.kind !== "native-procedure-references")
    throw new Error("Expected a procedure-reference page");
  if (projected.value.items.collection !== "references")
    throw new Error("Expected reference rows");
  expect(projected.value.byte_limited).toBe(true);
  expect(projected.value.items.endpoints).toHaveLength(
    projected.value.items.rows.length,
  );
  expect(pageBytes(projected.value)).toBeLessThanOrEqual(PAGE_BYTES);
});
