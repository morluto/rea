import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  API_CONTRACT_FACT_BYTES,
  apiContractSchema,
} from "../../domain/apiContract/apiContract.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { projectAnalysisView } from "../../domain/analysisView/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectApiContractEvidence } from "./ApiContractService.js";
import * as readOwner from "./ApiContractRead.js";
import * as parser from "../../domain/apiContract/parseApiContract.js";

const fixture = new URL(
  "../../../tests/fixtures/openapi/petstore.json.txt",
  import.meta.url,
);
const inputFile = async (bytes: Uint8Array | string) => {
  const root = await createTestTempDirectory("rea-api-contract-");
  const path = join(root, "contract.json");
  await writeFile(path, bytes);
  return { root, path };
};

it("binds the published source bytes to complete Evidence independently of reply selection", async () => {
  const bytes = await readFile(fixture);
  const { path } = await inputFile(bytes);
  const resources = new ArtifactResourceScope();
  try {
    const results = await Promise.all([
      inspectApiContractEvidence({ path }, resources),
      inspectApiContractEvidence({ path, detail: "complete" }, resources),
      inspectApiContractEvidence(
        {
          path,
          view: {
            kind: "api-contract",
            collection: "operations",
            fields: [],
            limit: 1,
          },
        },
        resources,
      ),
    ]);
    for (const result of results) expect(result.ok).toBe(true);
    const [summary, complete, page] = results;
    if (!summary?.ok || !complete?.ok || !page?.ok)
      throw new Error("Expected verified imports");
    expect(summary.value.evidence_id).toBe(complete.value.evidence_id);
    expect(page.value.evidence_id).toBe(complete.value.evidence_id);
    const value = apiContractSchema.parse(complete.value.normalized_result);
    expect(value.artifact).toEqual({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(value.summary.declared).toBe(19);
    expect(complete.value.operation).toBe("inspect_api_contract");
    expect(complete.value.parameters).not.toHaveProperty("detail");
    expect(complete.value.parameters).not.toHaveProperty("view");
    expect((await readFile(path)).equals(bytes)).toBe(true);
  } finally {
    await resources.close();
  }
});

it.each([
  [Buffer.from([255]), "not valid UTF-8"],
  [Buffer.from("{broken"), "JSON"],
  [Buffer.from("\uFEFF{}"), "byte-order mark"],
])(
  "reports malformed UTF-8/JSON without rewriting source %#",
  async (bytes, reason) => {
    const { path } = await inputFile(bytes);
    const resources = new ArtifactResourceScope();
    try {
      const result = await inspectApiContractEvidence({ path }, resources);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisInputError");
        expect(JSON.stringify(result.error)).toContain(reason);
        expect(result.error.partialObservation).toEqual({
          kind: "file-snapshot-hash",
          path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally {
      await resources.close();
    }
  },
);

it("rejects the selected physical byte budget before parsing", async () => {
  const { path } = await inputFile("{bad json}");
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectApiContractEvidence(
      { path, max_file_bytes: 4 },
      resources,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
      if (result.error instanceof AnalysisResourceConstraintError)
        expect(result.error.operation).toBe("inspect_api_contract");
    }
  } finally {
    await resources.close();
  }
});

it("bounds nesting even in schema regions omitted from the inventory", async () => {
  let nested: unknown = {};
  for (let depth = 0; depth < 1001; depth++) nested = { child: nested };
  const { path } = await inputFile(
    JSON.stringify({
      openapi: "3.1.2",
      info: { title: "Nested", version: "1" },
      paths: {},
      components: nested,
    }),
  );
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectApiContractEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisInputError");
      expect(JSON.stringify(result.error)).toContain("maximum nesting depth");
      expect(result.error.partialObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path,
      });
    }
  } finally {
    await resources.close();
  }
});

it("rejects relative, missing and non-regular selections at the input owner", async () => {
  const { root } = await inputFile("{}");
  const directory = join(root, "directory");
  await mkdir(directory);
  const resources = new ArtifactResourceScope();
  try {
    for (const path of [
      "relative.json",
      join(root, "missing.json"),
      directory,
    ]) {
      const result = await inspectApiContractEvidence({ path }, resources);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
    }
  } finally {
    await resources.close();
  }
});

it.skipIf(process.platform === "win32")(
  "preserves an actionable regular-file retry for a selected symlink",
  async () => {
    const { root, path } = await inputFile("{}");
    const link = join(root, "linked.json");
    await symlink(path, link);
    const resources = new ArtifactResourceScope();
    try {
      const result = await inspectApiContractEvidence(
        { path: link },
        resources,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisInputError");
        expect(JSON.stringify(result.error)).toContain(path);
      }
    } finally {
      await resources.close();
    }
  },
);

it("honors pre-cancellation with an opaque caller reason", async () => {
  const controller = new AbortController();
  const reason = { _tag: "ArtifactReaderFailure", reason: "integrity" };
  controller.abort(reason);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectApiContractEvidence(
      { path: "/unused.json" },
      resources,
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe(reason);
      expect(result.error.partialObservation).toBeUndefined();
    }
  } finally {
    await resources.close();
  }
});

it("keeps native JSON source excerpts internal while preserving the failure cause", async () => {
  const bytes = '{"$ref":"https://u:p@h","":NaN}';
  const { path } = await inputFile(bytes);
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectApiContractEvidence({ path }, resources);
    if (result.ok) throw new Error("Expected a syntax refusal");
    expect(result.error.cause).toBeInstanceOf(SyntaxError);
    expect(JSON.stringify(result.error)).not.toContain("u:p@h");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await resources.close();
  }
});

it.each([
  [{ openapi: "2.0" }, "AnalysisUnsupportedTargetError"],
  [
    {
      openapi: "3.1.2",
      info: { title: "a".repeat(3 * 1024 * 1024), version: "1" },
    },
    "AnalysisResourceConstraintError",
  ],
])(
  "keeps a completed parser failure ahead of queued cancellation %#",
  async (document, tag) => {
    const bytes = JSON.stringify(document);
    const { path } = await inputFile(bytes);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const realParse = parser.parseApiContractSteps;
    const scheduled = vi
      .spyOn(parser, "parseApiContractSteps")
      .mockImplementationOnce(function* (...args) {
        const result = yield* realParse(...args);
        expect(result.ok).toBe(false);
        setImmediate(() => controller.abort("after-parser-failure"));
        return result;
      });
    try {
      const result = await inspectApiContractEvidence({ path }, resources, {
        signal: controller.signal,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(controller.signal.aborted).toBe(true);
      if (result.ok) throw new Error("Expected the parser failure");
      expect(result.error._tag).toBe(tag);
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        bytes: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      scheduled.mockRestore();
      await resources.close();
    }
  },
);

it("cancels a cooperative document traversal after the actual verified file read", async () => {
  const paths = Object.fromEntries(
    Array.from({ length: 3000 }, (_, index) => [
      `/items/${index}`,
      { get: { operationId: String(index) } },
    ]),
  );
  const bytes = JSON.stringify({
    openapi: "3.1.2",
    info: { title: "Cancellation", version: "1" },
    paths,
  });
  const { path } = await inputFile(bytes);
  const controller = new AbortController();
  const reason = { stage: "after-source-read" };
  const realRead = readOwner.readApiContract;
  const scheduled = vi
    .spyOn(readOwner, "readApiContract")
    .mockImplementationOnce(async (...args) => {
      const loaded = await realRead(...args);
      expect(loaded.ok).toBe(true);
      setImmediate(() => controller.abort(reason));
      return loaded;
    });
  const resources = new ArtifactResourceScope();
  try {
    const result = await inspectApiContractEvidence({ path }, resources, {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe(reason);
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        bytes: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    scheduled.mockRestore();
    await resources.close();
  }
});

it.each(["between-paths", "after-projection"] as const)(
  "preserves authenticated OpenAPI facts on cancellation %s",
  async (stage) => {
    const bytes = JSON.stringify({
      openapi: "3.1.2",
      info: { title: "Cancellation", version: "1" },
      paths: { "/first": { get: {} }, "/second": { post: {} } },
    });
    const { path } = await inputFile(bytes);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const realParse = parser.parseApiContractSteps;
    try {
      const baseline = await inspectApiContractEvidence({ path }, resources);
      if (!baseline.ok) throw baseline.error;
      const complete = apiContractSchema.parse(
        baseline.value.normalized_result,
      );
      const scheduled = vi
        .spyOn(parser, "parseApiContractSteps")
        .mockImplementationOnce(function* (...args) {
          const steps = realParse(...args);
          if (stage === "between-paths") {
            expect(steps.next().done).toBe(false);
            expect(steps.next().done).toBe(false);
            setImmediate(() => controller.abort(stage));
            return yield* steps;
          }
          const result = yield* steps;
          setImmediate(() => controller.abort(stage));
          return result;
        });
      try {
        const result = await inspectApiContractEvidence({ path }, resources, {
          signal: controller.signal,
        });
        if (result.ok) throw new Error("Expected cancellation");
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cause).toBe(stage);
        const evidence = parseEvidence(result.error.partialObservation);
        const retained = apiContractSchema.parse(evidence.normalized_result);
        expect(evidence.subject).toEqual(baseline.value.subject);
        expect(evidence.parameters).toEqual(baseline.value.parameters);
        expect(retained.artifact).toEqual(complete.artifact);
        expect(retained.contract_id).toBe(complete.contract_id);
        if (stage === "between-paths") {
          expect(retained.operations).toEqual(complete.operations.slice(0, 1));
          expect(retained.source_coverage.status).toBe("partial");
          expect(evidence.evidence_id).not.toBe(baseline.value.evidence_id);
          const page = projectAnalysisView(
            {
              evidenceId: evidence.evidence_id,
              operation: evidence.operation,
              predicateType: evidence.predicate_type,
              normalizedResult: evidence.normalized_result,
              limitations: evidence.limitations,
            },
            {
              kind: "api-contract",
              collection: "operations",
              offset: 0,
              limit: 1,
            },
          );
          expect(page).toMatchObject({
            ok: true,
            value: {
              parent_evidence_id: evidence.evidence_id,
              items: [{ path: "/first", state: "declared" }],
              coverage: { exhausted: true },
              source_coverage: { status: "partial" },
            },
          });
        } else {
          expect(retained).toEqual(complete);
          expect(evidence.evidence_id).toBe(baseline.value.evidence_id);
        }
      } finally {
        scheduled.mockRestore();
      }
    } finally {
      await resources.close();
    }
  },
);

it.each(["path-admission", "invalid-paths"] as const)(
  "retains authenticated partial facts when %s exhausts the facts allowance",
  async (stage) => {
    const { path } = await inputFile("{}");
    // Leave enough allowance for invalid-info, but not a second diagnostic.
    const titleLength = Math.floor(
      (API_CONTRACT_FACT_BYTES -
        "3.0.4".length * 12 -
        4096 -
        path.length * 12 -
        (1024 + "/info".length * 12) -
        500) /
        12,
    );
    const document =
      stage === "invalid-paths"
        ? {
            openapi: "3.0.4",
            info: { title: "a".repeat(titleLength) },
            paths: null,
          }
        : {
            openapi: "3.0.4",
            info: { title: "Capacity", version: "1" },
            paths: {
              "/retained": { get: {} },
              [`/${"a".repeat(Math.ceil(API_CONTRACT_FACT_BYTES / 16))}`]: {},
            },
          };
    const bytes = JSON.stringify(document);
    await writeFile(path, bytes);
    const resources = new ArtifactResourceScope();
    try {
      const result = await inspectApiContractEvidence({ path }, resources);
      if (result.ok) throw new Error("Expected a retained-facts refusal");
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
      const evidence = parseEvidence(result.error.partialObservation);
      const retained = apiContractSchema.parse(evidence.normalized_result);
      expect(retained.artifact).toEqual({
        path,
        bytes: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(retained.source_coverage).toMatchObject({
        status: "partial",
        paths_state: stage === "invalid-paths" ? "malformed" : "object",
        path_entries_examined: stage === "invalid-paths" ? 0 : 1,
      });
      if (stage === "invalid-paths") {
        expect(retained.info).toEqual({
          title: document.info.title,
          version: null,
        });
        expect(retained.diagnostics.map((row) => row.code)).toEqual([
          "invalid-info",
        ]);
        expect(retained.operations).toEqual([]);
      } else {
        expect(retained.operations.map((row) => row.path)).toEqual([
          "/retained",
        ]);
        expect(retained.diagnostics).toEqual([]);
      }
      expect(await readFile(path, "utf8")).toBe(bytes);
    } finally {
      await resources.close();
    }
  },
);
