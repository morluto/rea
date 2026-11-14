import * as operationParser from "../../domain/apiContract/GraphqlOperationFacts.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { parseEvidence } from "../../domain/evidence.js";
import { graphqlContractSchema } from "../../domain/apiContract/graphqlContract.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectApiContractEvidence } from "./ApiContractService.js";
import * as parser from "../../domain/apiContract/parseGraphqlContract.js";
import * as reader from "./ApiContractRead.js";

const files = async (
  schema: string | Uint8Array,
  operations?: string | Uint8Array,
) => {
  const root = await createTestTempDirectory("rea-graphql-contract-");
  const path = join(root, "SDL 雪.graphql"),
    operations_path = join(root, "operations.graphql");
  await writeFile(path, schema);
  if (operations !== undefined) await writeFile(operations_path, operations);
  return {
    path,
    format: "graphql-sdl" as const,
    ...(operations === undefined ? {} : { operations_path }),
  };
};
const withScope = async <Value>(
  run: (resources: ArtifactResourceScope) => Promise<Value>,
) => {
  const resources = new ArtifactResourceScope();
  try {
    return await run(resources);
  } finally {
    await resources.close();
  }
};
const reportOf = (value: unknown) =>
  graphqlContractSchema.parse(parseEvidence(value).normalized_result);

it("binds both independently verified byte snapshots and preserves optional-BOM positions", async () => {
  const schema = "\uFEFFtype Query { greeting: String }",
    operations = "query Q { renamed: greeting }";
  const input = await files(schema, operations);
  await withScope(async (resources) => {
    const result = await inspectApiContractEvidence(input, resources);
    if (!result.ok) throw result.error;
    const report = reportOf(result.value);
    expect(result.value.parameters).toEqual({
      ...input,
      max_file_bytes: 33554432,
    });
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(schema).digest("hex"),
    );
    expect(report.operations_artifact?.sha256).toBe(
      createHash("sha256").update(operations).digest("hex"),
    );
    expect(
      schema.slice(
        report.fields[0]!.source.start_utf16,
        report.fields[0]!.source.end_utf16,
      ),
    ).toBe("greeting: String");
    expect(report.references[0]).toMatchObject({
      response_key: "renamed",
      schema_field_id: report.fields[0]!.field_id,
      state: "resolved",
    });
    expect(await readFile(input.path, "utf8")).toBe(schema);
  });
});

it.each(["path", "operations_path"] as const)(
  "preserves known source identities on invalid UTF-8 in %s",
  async (parameter) => {
    const input = await files(
      parameter === "path"
        ? Buffer.from([255])
        : "type Query { greeting: String }",
      parameter === "operations_path" ? Buffer.from([255]) : "{ greeting }",
    );
    await withScope(async (resources) => {
      const result = await inspectApiContractEvidence(input, resources);
      if (result.ok) throw new Error("Expected invalid UTF-8");
      expect(result.error._tag).toBe("AnalysisInputError");
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: { issues: [{ path: [parameter] }] },
      });
      const partial = reportOf(result.error.partialObservation);
      expect(partial.artifact.path).toBe(input.path);
      expect(partial.source_coverage).toMatchObject({
        status: "partial",
        schema_declarations: "unavailable",
      });
      expect(partial.operations_artifact !== null).toBe(
        parameter === "operations_path",
      );
    });
  },
);

it("retains SDL facts when the operation syntax is malformed", async () => {
  const input = await files(
    "type Query { greeting: String }",
    "query Q { greeting(",
  );
  await withScope(async (resources) => {
    const result = await inspectApiContractEvidence(input, resources);
    if (!result.ok) throw result.error;
    const report = reportOf(result.value);
    expect(report.fields).toHaveLength(1);
    expect(report.source_coverage).toMatchObject({
      status: "partial",
      schema_declarations: "complete",
      operations: "unavailable",
    });
    expect(report.diagnostics[0]).toMatchObject({
      code: "operations-parse-refused",
      source: { role: "operations" },
    });
  });
});

it("rejects primary SDL syntax with queryable partial Evidence and neutral diagnostics", async () => {
  const input = await files(
    'type Query { field: "https://user:credential@host/path" }',
  );
  await withScope(async (resources) => {
    const result = await inspectApiContractEvidence(input, resources);
    if (result.ok) throw new Error("Expected a syntax refusal");
    const report = reportOf(result.error.partialObservation);
    expect(report.source_coverage.schema_declarations).toBe("unavailable");
    expect(report.diagnostics[0]?.source?.role).toBe("schema");
    expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
      "user:credential",
    );
  });
});

it("attributes auxiliary file admission failures to operations_path and retains the primary identity", async () => {
  const input = await files("type Query { field: String }");
  await withScope(async (resources) => {
    const missing = await inspectApiContractEvidence(
      { ...input, operations_path: join(input.path, "missing") },
      resources,
    );
    if (missing.ok) throw new Error("Expected missing operation file");
    expect(projectAnalysisError(missing.error)).toMatchObject({
      details: { issues: [{ path: ["operations_path"] }] },
    });
    expect(reportOf(missing.error.partialObservation).artifact.path).toBe(
      input.path,
    );
    const relative = await inspectApiContractEvidence(
      { ...input, operations_path: "relative.graphql" },
      resources,
    );
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error.partialObservation).toBeUndefined();
    const wrongFormat = await inspectApiContractEvidence(
      { path: input.path, operations_path: input.path },
      resources,
    );
    expect(wrongFormat.ok).toBe(false);
  });
});

it("keeps real SDL facts on cooperative cancellation rather than dropping them with provisional AST state", async () => {
  const input = await files(
    "type Query { " +
      Array.from({ length: 1000 }, (_, i) => `f${i}: String`).join(" ") +
      " }",
  );
  const controller = new AbortController();
  const real = reader.readApiContract;
  const scheduled = vi
    .spyOn(reader, "readApiContract")
    .mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      setImmediate(() => controller.abort("after-read"));
      return result;
    });
  try {
    await withScope(async (resources) => {
      const result = await inspectApiContractEvidence(input, resources, {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe("after-read");
      const report = reportOf(result.error.partialObservation);
      expect(report.fields.length).toBeGreaterThan(0);
      expect(report.fields.length).toBeLessThan(1000);
      expect(report.source_coverage).toMatchObject({
        status: "partial",
        schema_declarations: "partial",
      });
    });
  } finally {
    scheduled.mockRestore();
  }
});

it("retains completed facts on cancellation queued after the last projection", async () => {
  const input = await files("type Query { field: String }", "{ field }");
  const controller = new AbortController();
  const real = parser.parseGraphqlContractSteps;
  const scheduled = vi
    .spyOn(parser, "parseGraphqlContractSteps")
    .mockImplementationOnce(function* (...args) {
      const result = yield* real(...args);
      setImmediate(() => controller.abort("after-projection"));
      return result;
    });
  try {
    await withScope(async (resources) => {
      const result = await inspectApiContractEvidence(input, resources, {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Expected late cancellation");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(
        reportOf(result.error.partialObservation).source_coverage.status,
      ).toBe("complete-within-scope");
    });
  } finally {
    scheduled.mockRestore();
  }
});

it("applies the selected file allowance to the auxiliary document and retains its known read coverage", async () => {
  const input = await files("type Query { f: String }", "#".repeat(128));
  await withScope(async (resources) => {
    const result = await inspectApiContractEvidence(
      { ...input, max_file_bytes: 32 },
      resources,
    );
    if (result.ok) throw new Error("Expected auxiliary file capacity refusal");
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    const partial = reportOf(result.error.partialObservation);
    expect(partial.artifact.path).toBe(input.path);
    expect(partial.operations_artifact).toBeNull();
    expect(partial.source_coverage.operations).toBe("unavailable");
  });
});

it.each(["query Q", "fragment Q on Query"])(
  "cancels within one wide definition after a bounded field-binding chunk: %s",
  async (definition) => {
    const count = 4096;
    const input = await files(
      "type Query { value: String }",
      definition +
        " { " +
        Array.from({ length: count }, (_, index) => `a${index}: value`).join(
          " ",
        ) +
        " }",
    );
    const controller = new AbortController();
    const real = operationParser.collectGraphqlOperationFacts;
    const observed = vi
      .spyOn(operationParser, "collectGraphqlOperationFacts")
      .mockImplementationOnce(function* (...args) {
        const steps = real(...args);
        let scheduled = false;
        try {
          for (;;) {
            const next = steps.next();
            if (next.done) return next.value;
            if (!scheduled && args[2].references.length > 0) {
              scheduled = true;
              setImmediate(() => controller.abort("within-wide-operation"));
            }
            yield;
          }
        } finally {
          steps.return(undefined);
        }
      });
    try {
      await withScope(async (resources) => {
        const result = await inspectApiContractEvidence(input, resources, {
          signal: controller.signal,
        });
        if (result.ok)
          throw new Error("Expected cancellation within selections");
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cause).toBe("within-wide-operation");
        const report = reportOf(result.error.partialObservation);
        expect(report.references.length).toBeGreaterThan(0);
        expect(report.references.length).toBeLessThan(count);
        expect(report.source_coverage.operations).toBe("partial");
      });
    } finally {
      observed.mockRestore();
    }
  },
);
