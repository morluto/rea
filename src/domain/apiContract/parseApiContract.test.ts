import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { apiContractSchema, type ApiContractArtifact } from "./apiContract.js";
import { parseApiContractSteps } from "./parseApiContract.js";

const artifact: ApiContractArtifact = {
  path: "/contract.json",
  sha256: "a".repeat(64),
  bytes: 1,
};
const document = (paths: unknown, openapi = "3.0.4") => ({
  openapi,
  info: { title: "Owned API", version: "1" },
  paths,
});
const parse = (value: unknown, source = artifact) => {
  const steps = parseApiContractSteps(value, source);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};
const report = (value: unknown, source = artifact) => {
  const result = parse(value, source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return apiContractSchema.parse(result.value);
};

it("reads a real published Petstore document without embedding its schemas", () => {
  const bytes = readFileSync(
    new URL(
      "../../../tests/fixtures/openapi/petstore.json.txt",
      import.meta.url,
    ),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(sha256).toBe(
    "00441c05add60f28da55eb4563d3fb6bbda364ba8eb7b381e2e2c98613005c82",
  );
  const value = report(JSON.parse(bytes.toString("utf8")), {
    ...artifact,
    sha256,
    bytes: bytes.length,
  });
  expect(value.openapi).toBe("3.0.4");
  expect(value.info).toEqual({
    title: "Swagger Petstore - OpenAPI 3.0",
    version: "1.0.27",
  });
  expect(value.summary).toEqual({
    operation_slots: 19,
    declared: 19,
    unknown: 0,
    unresolved_path_items: 0,
    diagnostics: 0,
  });
  expect(value.source_coverage).toMatchObject({
    status: "complete-within-scope",
    path_entries_examined: 13,
    reference_resolution: "not-attempted",
    schema_validation: "not-performed",
  });
  expect(
    value.operations.find((row) => row.declared_id === "getPetById"),
  ).toMatchObject({
    method: "GET",
    path: "/pet/{petId}",
    source_pointer: "/paths/~1pet~1{petId}/get",
    state: "declared",
  });
  expect(value).not.toHaveProperty("components");
  expect(value).not.toHaveProperty("servers");
});

it.each(["3.0.4", "3.1.2", "3.2.1"])(
  "accepts the explicit %s minor family",
  (version) => {
    expect(
      report(document({ "/x": { get: {} } }, version)).summary.declared,
    ).toBe(1);
  },
);

it.each(["2.0", "3.3.0", "3.2", "3.01.0", "3.0.01", "3.2.0-beta.1"])(
  "refuses an unsupported version %s explicitly",
  (version) => {
    const value = parse(document({}, version));
    expect(value.ok).toBe(false);
    if (!value.ok)
      expect(value.error._tag).toBe("AnalysisUnsupportedTargetError");
  },
);

it.each([null, [], {}, { openapi: 3 }])(
  "rejects a malformed root %#",
  (value) => {
    const parsed = parse(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error._tag).toBe("AnalysisInputError");
  },
);

it("keeps source-scoped identities separate from exact method/path keys and declared IDs", () => {
  const input = document({
    "/a/~b": { get: { operationId: "same" } },
    "/b": { get: { operationId: "same" } },
  });
  const first = report(input);
  const copied = report(input, { ...artifact, path: "/copy.json" });
  const revised = report(input, { ...artifact, sha256: "b".repeat(64) });
  expect(first.operations[0]?.source_pointer).toBe("/paths/~1a~1~0b/get");
  expect(copied.operations).toEqual(first.operations);
  expect(revised.operations.map((row) => row.operation_key)).toEqual(
    first.operations.map((row) => row.operation_key),
  );
  expect(revised.operations[0]?.operation_id).not.toBe(
    first.operations[0]?.operation_id,
  );
  expect(new Set(first.operations.map((row) => row.operation_id)).size).toBe(2);
  expect(first.operations.every((row) => row.declared_id === "same")).toBe(
    true,
  );
});

it("preserves unresolved local, cyclic and remote Path Items without following them", () => {
  const input = document({
    "/inline": { $ref: "#/paths/~1inline", get: { operationId: "inline" } },
    "/local": { $ref: "./sibling.json#/paths/~1other" },
    "/remote": { $ref: "http://127.0.0.1:9/reference.json" },
  });
  const value = report(input);
  expect(value.path_item_references.map((row) => row.reference)).toEqual([
    "#/paths/~1inline",
    "./sibling.json#/paths/~1other",
    "http://127.0.0.1:9/reference.json",
  ]);
  expect(value.operations).toHaveLength(1);
  expect(value.operations[0]).toMatchObject({
    state: "unknown",
    reason: "unresolved-path-item-reference",
  });
  expect(value.source_coverage.status).toBe("partial");
  expect(value.summary).toMatchObject({
    declared: 0,
    unknown: 1,
    unresolved_path_items: 3,
  });
});

it("keeps usable siblings, malformed slots and missing values distinct", () => {
  const input = document({
    "/ok": { get: { operationId: "" }, post: { operationId: 0 } },
    "/broken": { get: null },
    "/bad-ref": { $ref: false, get: {} },
    "/bad-item": 0,
    invalid: { get: {} },
    "x-doc": { get: {} },
  });
  const value = report(input);
  expect(value.summary).toEqual({
    operation_slots: 4,
    declared: 2,
    unknown: 2,
    unresolved_path_items: 1,
    diagnostics: 5,
  });
  expect(value.operations[0]?.declared_id).toBe("");
  expect(value.operations[1]).toMatchObject({
    declared_id: null,
    state: "declared",
  });
  expect(value.operations[2]).toMatchObject({
    state: "unknown",
    reason: "malformed-operation",
  });
  expect(value.path_item_references[0]).toMatchObject({
    state: "malformed",
    reference: null,
  });
  expect(value.source_coverage.status).toBe("partial");
  expect(value.diagnostics.map((row) => row.code)).toEqual([
    "invalid-operation-id",
    "invalid-operation",
    "invalid-path-reference",
    "invalid-path-item",
    "invalid-path-key",
  ]);
});

it("excludes structured transport userinfo while preserving ordinary reference text", () => {
  const value = report(
    document({
      "/absolute": {
        $ref: "https://name:credential@example.test/schema.json?token=caller-text#part",
      },
      "/relative": {
        $ref: "//name:credential@example.test/schema.json?ordinary=kept",
      },
      "/file": { $ref: "./ordinary@name.json#/components/schemas/password" },
    }),
  );
  expect(
    value.path_item_references.map(({ reference, credential_redacted }) => ({
      reference,
      credential_redacted,
    })),
  ).toEqual([
    {
      reference: "https://example.test/schema.json?token=caller-text#part",
      credential_redacted: true,
    },
    {
      reference: "//example.test/schema.json?ordinary=kept",
      credential_redacted: true,
    },
    {
      reference: "./ordinary@name.json#/components/schemas/password",
      credential_redacted: false,
    },
  ]);
  expect(JSON.stringify(value)).not.toContain("name:credential");
});

it("keeps an ambiguous credential spelling unknown without normalizing its reference identity", () => {
  const value = report(
    document({
      "/ambiguous": {
        $ref: "https:\\\\name:credential@example.test/schema.json",
      },
    }),
  );
  expect(value.path_item_references[0]).toMatchObject({
    reference: null,
    credential_redacted: true,
    state: "unresolved",
  });
  expect(value.source_coverage.status).toBe("partial");
});

it("reports absent and malformed paths without calling them a complete empty API", () => {
  const value = document(undefined);
  delete (value as { paths?: unknown }).paths;
  expect(report(value).source_coverage).toMatchObject({
    status: "partial",
    paths_state: "absent",
  });
  expect(
    report({ ...value, openapi: "3.1.2", webhooks: { name: { post: {} } } })
      .source_coverage,
  ).toMatchObject({
    status: "complete-within-scope",
    paths_state: "absent",
    scope: "inline-path-operations",
  });
  expect(report(document(null)).source_coverage).toMatchObject({
    status: "partial",
    paths_state: "malformed",
  });
});

it("handles 3.2 QUERY and case-sensitive additional methods, diagnosing invalid fixed-method duplicates", () => {
  const value = report(
    document(
      {
        "/x": {
          query: {},
          post: {},
          additionalOperations: {
            COPY: {},
            post: {},
            POST: {},
            "bad method": {},
          },
        },
      },
      "3.2.1",
    ),
  );
  expect(value.operations.map((row) => row.method)).toEqual([
    "QUERY",
    "POST",
    "COPY",
    "post",
  ]);
  expect(value.operations[2]?.source_pointer).toBe(
    "/paths/~1x/additionalOperations/COPY",
  );
  expect(value.diagnostics.map((row) => row.code)).toEqual([
    "invalid-additional-method",
    "invalid-additional-method",
  ]);
  expect(value.source_coverage.status).toBe("partial");
  const older = report(
    document(
      { "/x": { query: {}, additionalOperations: { COPY: {} }, GET: {} } },
      "3.1.2",
    ),
  );
  expect(older.operations).toEqual([]);
  expect(older.diagnostics.map((row) => row.code)).toEqual(
    Array(3).fill("unknown-path-item-field"),
  );
});

it("bounds expanded identities and source pointers before building a giant row", () => {
  const result = parse(
    document({ [`/${"a".repeat(1_100_000)}`]: { get: {} } }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
});
