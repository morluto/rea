import { holdFirstFileRead } from "../support/holdFirstFileRead.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveSourceToBundleReference } from "../../src/application/javascript/SourceToBundleReference.js";
import { requireAuthenticationHeadroom } from "../../src/application/JsonAuthenticationHeadroom.js";
import * as workflow from "../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { historicalSourceGraphSchema } from "../../src/domain/referenceSourceGraph.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE } from "../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { createServer } from "../../src/server/createServer.js";
import { ToolResultDelivery } from "../../src/server/ToolResultDelivery.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

vi.mock("../../src/application/JsonAuthenticationHeadroom.js", { spy: true });
vi.mock(
  "../../src/application/javascript/JavaScriptApplicationWorkflowService.js",
  { spy: true },
);
afterEach(() => vi.restoreAllMocks());

it("reserves graph validation/hash memory before the owning parser allocates", async () => {
  const root = await createTestTempDirectory("rea-source-headroom-");
  const path = join(root, "graph.json");
  await writeFile(
    path,
    JSON.stringify(SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference),
  );
  const actual = await vi.importActual<
    typeof import("../../src/application/JsonAuthenticationHeadroom.js")
  >("../../src/application/JsonAuthenticationHeadroom.js");
  vi.mocked(requireAuthenticationHeadroom).mockImplementationOnce(
    (value, options) =>
      actual.requireAuthenticationHeadroom(value, {
        ...options,
        availableBytes: 0,
      }),
  );
  const parser = vi.spyOn(historicalSourceGraphSchema, "safeParse");
  const resources = new ArtifactResourceScope();
  try {
    expect(
      await resolveSourceToBundleReference(
        { kind: "file", path },
        undefined,
        resources,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        operation: "compare_source_to_bundle",
        resource: "memory",
      },
    });
    expect(parser).not.toHaveBeenCalled();
  } finally {
    await resources.close();
  }
  expect(resources.hasPending).toBe(false);
});

it("attributes file-I/O cancellation to the comparison and preserves its exact cause", async () => {
  const root = await createTestTempDirectory("rea-reference-io-cancel-");
  const path = join(root, "graph.json");
  await writeFile(
    path,
    JSON.stringify(SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference),
  );
  const held = await holdFirstFileRead(path);
  const controller = new AbortController();
  const cause = new Error("cancel historical graph read");
  const resources = new ArtifactResourceScope();
  try {
    const pending = resolveSourceToBundleReference(
      { kind: "file", path },
      controller.signal,
      resources,
    );
    await held.firstRead;
    controller.abort(cause);
    held.release();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "compare_source_to_bundle",
      },
    });
    if (result.ok) throw new Error("Expected cancelled read");
    expect(result.error.cause).toBe(cause);
  } finally {
    held.release();
    await resources.close();
  }
  expect(resources.hasPending).toBe(false);
});

it.each(["validation", "comparison"] as const)(
  "preserves the right evidence when cancellation arrives during %s",
  async (stage) => {
    const { client, session, path } = await connectedComparison();
    const controller = new AbortController();
    const before = session.exportEvidenceBundle();
    if (stage === "validation") {
      const parse = historicalSourceGraphSchema.safeParse;
      vi.spyOn(historicalSourceGraphSchema, "safeParse").mockImplementationOnce(
        (value) => {
          const parsed = parse(value);
          setImmediate(() =>
            controller.abort(new Error("cancel during graph validation")),
          );
          return parsed;
        },
      );
    } else {
      const actual = await vi.importActual<typeof workflow>(
        "../../src/application/javascript/JavaScriptApplicationWorkflowService.js",
      );
      vi.mocked(
        workflow.executeSourceToBundleComparison,
      ).mockImplementationOnce(async (...args) => {
        const compared = await actual.executeSourceToBundleComparison(...args);
        setImmediate(() =>
          controller.abort(new Error("cancel during graph comparison")),
        );
        return compared;
      });
    }
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const errorDelivery = ToolResultDelivery.prototype.toErrorToolResult;
    vi.spyOn(
      ToolResultDelivery.prototype,
      "toErrorToolResult",
    ).mockImplementation(function (
      this: ToolResultDelivery,
      error,
      targetContent,
    ) {
      const result = errorDelivery.call(this, error, targetContent);
      if (
        error instanceof AnalysisCancelledError &&
        error.operation === "compare_source_to_bundle"
      )
        settle?.();
      return result;
    });
    let partialError: AnalysisCancelledError | undefined;
    const partialDelivery =
      ToolResultDelivery.prototype.toPartialErrorToolResult;
    vi.spyOn(
      ToolResultDelivery.prototype,
      "toPartialErrorToolResult",
    ).mockImplementation(function (this: ToolResultDelivery, ...args) {
      const result = partialDelivery.apply(this, args);
      if (
        args[0] instanceof AnalysisCancelledError &&
        args[0].operation === "compare_source_to_bundle"
      ) {
        partialError = args[0];
        settle?.();
      }
      return result;
    });
    const evidenceDelivery = ToolResultDelivery.prototype.toEvidenceToolResult;
    vi.spyOn(
      ToolResultDelivery.prototype,
      "toEvidenceToolResult",
    ).mockImplementation(function (this: ToolResultDelivery, ...args) {
      const result = evidenceDelivery.apply(this, args);
      if (args[1].name === "compare_source_to_bundle") settle?.();
      return result;
    });
    const pending = client
      .callTool(
        {
          name: "compare_source_to_bundle",
          arguments: {
            ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
            reference: { kind: "file", path },
            view: { kind: "summary" },
          },
        },
        { signal: controller.signal },
      )
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(await pending).toBeInstanceOf(Error);
    await settled;
    const after = session.exportEvidenceBundle();
    if (stage === "validation") expect(after).toEqual(before);
    else {
      expect(partialError).toBeInstanceOf(AnalysisCancelledError);
      expect(after.records).toHaveLength(2);
      const source = after.records.find(
        ({ operation }) => operation === "analyze_javascript_application",
      );
      const comparison = after.records.find(
        ({ operation }) => operation === "compare_source_to_bundle",
      );
      expect(source).toBeDefined();
      expect(comparison?.parameters).toMatchObject({
        application_evidence_id: source?.evidence_id,
      });
      expect(partialError?.partialObservation).toMatchObject({
        evidence_id: comparison?.evidence_id,
      });
    }
    await expect(client.ping()).resolves.toEqual({});
  },
);

const connectedComparison = async () => {
  const root = await createTestTempDirectory("rea-source-commit-cancel-");
  const path = join(root, "graph.json");
  await writeFile(
    path,
    JSON.stringify(SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference),
  );
  const session = createTestBinarySession(() => {
    throw new Error("Comparison must not start a native provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "source-cancel", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, session, path };
};
