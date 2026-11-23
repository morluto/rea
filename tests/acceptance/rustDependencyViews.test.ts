import { fileSubjectArchitecture } from "../fixtures/evidenceSubject.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  parseEvidence,
  createEvidence,
  evidenceSubjectInput,
  type Evidence,
} from "../../src/domain/evidence.js";
import { metadataReportSubjectFormat } from "../../src/domain/apple/machoTargetSelection.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { rustBinarySchema } from "../../src/domain/rust/rustBinary.js";
import { analysisViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import {
  createRustImage,
  createRustHashOverflowImage,
  createRustWasmModule,
  rustDependencyPayload,
} from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../support/cli/cliFixture.js";

/** One synthetic cargo-auditable artifact for each supported container. */
const rustArtifact = (
  format: "elf" | "pe" | "macho" | "wasm",
  payload: Buffer,
): Buffer =>
  format === "wasm"
    ? createRustWasmModule({ payload })
    : createRustImage({ format, payload });

cliTest(
  "keeps compiler-prefix coverage in CLI summaries until the selected budget admits every hash",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-compiler-summary-");
    const path = join(root, "compiler-paths.elf");
    await writeFile(path, createRustHashOverflowImage());
    for (const maxHashes of [64, 65]) {
      const output = join(root, `source-${String(maxHashes)}.json`);
      const delivered = await cli.run({
        arguments: [
          "inspect-rust-binary",
          path,
          "--detail",
          "summary",
          "--evidence_output",
          output,
          "--max-rustc-hashes",
          String(maxHashes),
          "--full-output",
          "--json",
        ],
      });
      expect(delivered.exitCode, delivered.stderr).toBe(0);
      const envelope = delivered.json as {
        data: { summary: { normalized_result: unknown } };
        meta: { cli_controls?: unknown };
      };
      // The summary wraps the view; the CLI still names the option for the
      // control the complete Evidence records.
      expect(envelope.meta.cli_controls).toEqual(
        maxHashes === 64
          ? { max_rustc_hashes: "--max-rustc-hashes" }
          : undefined,
      );
      const summary = analysisViewResultSchema.parse(
        envelope.data.summary.normalized_result,
      );
      if (
        summary.kind !== "summary" ||
        summary.parent_operation !== "inspect_rust_binary"
      )
        throw new Error("Expected a Rust summary");
      expect(summary.summary.rustc_commit).toEqual({
        evidence_kind: "inferred",
        hashes_count: maxHashes,
        ...(maxHashes === 64
          ? {
              coverage: {
                status: "partial",
                reason: "max_rustc_hashes",
                effective_limit: 64,
                limit: expect.objectContaining({
                  parameter: "max_rustc_hashes",
                  effective_value: 64,
                }),
              },
            }
          : {}),
      });
      expect(summary.summary.auditable_metadata?.counts.packages).toBe(2);
    }
  },
);

/** Both authenticated retention and portable imports query the same captured facts. */
const assertRetainedPages = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  evidenceId: string,
  exported: string,
) => {
  for (const [filter, expected] of [
    [
      { names: ["same"], versions: ["2"], fields: ["name", "version"] },
      [{ index: 1, name: "same", version: "2" }],
    ],
    [{ names: ["same"], indices: [0], fields: [] }, [{ index: 0 }]],
    [{ names: ["same"], versions: [], fields: [] }, []],
  ] as const) {
    const reply = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: evidenceId },
      view: { kind: "rust", collection: "packages", ...filter },
    });
    expect(reply.isError).not.toBe(true);
    expect(
      parseEvidence(reply.structuredContent).normalized_result,
    ).toMatchObject({ page: { rows: expected } });
  }

  for (const source of [
    { kind: "retained-evidence", evidence_id: evidenceId },
    { kind: "evidence-file", path: exported },
  ]) {
    const reply = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "rust",
        collection: "packages",
        names: ["same"],
        indices: [0, 1, 99],
        offset: 1,
        limit: 1,
        fields: [],
      },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      parseEvidence(reply.structuredContent).normalized_result,
    ).toMatchObject({
      parent_evidence_id: evidenceId,
      page: { rows: [{ index: 1 }] },
      coverage: {
        total: 2,
        examined: 1,
        exhausted: true,
        next_offset: null,
      },
    });
    const edgeReply = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "rust",
        collection: "edges",
        from_indices: [1, 3],
        to_indices: [0],
        fields: ["from_index", "to_index"],
      },
    });
    expect(edgeReply.isError).not.toBe(true);
    expect(
      parseEvidence(edgeReply.structuredContent).normalized_result,
    ).toMatchObject({
      page: {
        collection: "edges",
        rows: [
          { index: 1, from_index: 1, to_index: 0 },
          { index: 3, from_index: 3, to_index: 0 },
        ],
      },
    });
    const empty = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "rust",
        collection: "packages",
        names: [],
        versions: ["1"],
        fields: ["name"],
      },
    });
    expect(
      parseEvidence(empty.structuredContent).normalized_result,
    ).toMatchObject({
      page: { rows: [] },
      coverage: { total: 0, exhausted: true },
    });
  }
};

const readCycloneDx = (response: unknown) => {
  const result = analysisViewResultSchema.parse(
    parseEvidence(response).normalized_result,
  );
  if (result.kind !== "cyclonedx") throw new Error("Expected a CycloneDX view");
  return result;
};

const expectCycloneDxView = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  cli: Pick<TestCli, "run">,
  input: { exported: string; format: string; root: string; parent: Evidence },
): Promise<void> => {
  const { exported, format, root, parent } = input;
  const view = { kind: "cyclonedx" } as const;
  const request = {
    source: { kind: "evidence-file", path: exported },
    view,
  } as const;
  const reply = await call("inspect_analysis_view", request);
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const result = readCycloneDx(reply.structuredContent);
  const publicRef = "pkg:cargo/same@1";
  const appRef = "rust-package:3";
  expect(result).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    parent_operation: "inspect_rust_binary",
    document: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      compositions: [{ aggregate: "unknown" }],
      dependencies: expect.arrayContaining([
        { ref: appRef, dependsOn: [publicRef, "rust-package:1"] },
      ]),
    },
  });
  expect(result.document.components[0]).toMatchObject({
    "bom-ref": publicRef,
    purl: publicRef,
  });
  const app = result.document.components.find(({ name }) => name === "app");
  expect(app).toMatchObject({
    "bom-ref": appRef,
    version: "1",
    properties: expect.arrayContaining([
      { name: "rea:cargo:source", value: "local" },
    ]),
  });
  expect(app).not.toHaveProperty("purl");
  expect(
    result.unknowns.filter((message) =>
      message.includes("Rust package app 1 from source local"),
    ),
  ).toHaveLength(1);
  if (format !== "elf") return;

  const retained = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
    view,
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  expect(readCycloneDx(retained.structuredContent)).toEqual(result);

  const requestPath = join(root, "cyclonedx-view.json");
  await writeFile(requestPath, JSON.stringify(request));
  const cliView = await cli.run({
    arguments: ["inspect-analysis-view", requestPath, "--json"],
  });
  expect(cliView.exitCode, cliView.stderr).toBe(0);
  expect(readCycloneDx(cliView.json)).toEqual(result);
  expect(result.document.metadata.tools?.components).toEqual([
    expect.objectContaining({
      "bom-ref": `${parent.provider.id}@${parent.provider.version ?? "unknown"}`,
      name: parent.provider.name,
    }),
  ]);

  const collidingParent = createEvidence(
    evidenceSubjectInput(parent.subject),
    { id: "pkg:cargo/same", name: "Recorded Rust reader", version: "1" },
    {
      operation: parent.operation,
      parameters: parent.parameters,
      result: parent.normalized_result,
    },
  );
  await writeFile(exported, JSON.stringify(collidingParent));
  const collision = await cli.run({
    arguments: ["inspect-analysis-view", requestPath, "--json"],
  });
  expect(collision.exitCode, collision.stderr).toBe(0);
  const resolved = readCycloneDx(collision.json);
  expect(resolved.parent_evidence_id).toBe(collidingParent.evidence_id);
  const refs = [
    resolved.document.metadata.component,
    ...resolved.document.components,
    ...(resolved.document.metadata.tools?.components ?? []),
  ].map((component) => component["bom-ref"]);
  expect(new Set(refs).size).toBe(refs.length);
  expect(resolved.document.metadata.tools?.components).toEqual([
    {
      type: "application",
      "bom-ref": `tool:${publicRef}`,
      name: "Recorded Rust reader",
      version: "1",
    },
  ]);
  expect(resolved.document.components).toEqual(result.document.components);
  expect(resolved.document.dependencies).toEqual(result.document.dependencies);
};

cliTest(
  "queries stable Rust packages and edges through real CLI/MCP and portable Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-views-");
    const { call } = await connectLocalToolsMcp();
    for (const format of ["elf", "pe", "macho", "wasm"] as const) {
      const path = join(root, `source.${format}`);
      const output = join(root, `${format}-source.json`);
      const payload = rustDependencyPayload({
        packages: [
          {
            name: "same",
            version: "1",
            source: "crates.io",
            dependencies: [2],
            features: ["default"],
          },
          {
            name: "same",
            version: "2",
            source: "git+https://upstream.example/repo",
            dependencies: [0, 2],
          },
          { name: "leaf", version: "1", source: "local" },
          {
            name: "app",
            version: "1",
            source: "local",
            dependencies: [0, 1],
            root: true,
          },
        ],
      });
      await writeFile(path, rustArtifact(format, payload));
      const fullReply = await call("inspect_rust_binary", { path });
      expect(fullReply.isError).not.toBe(true);
      const full = parseEvidence(fullReply.structuredContent);
      const report = rustBinarySchema.parse(full.normalized_result);
      const selection = {
        collection: "packages",
        names: ["same"],
        fields: ["name", "version", "dependencies", "features"],
      };
      const direct = await call("inspect_rust_binary", {
        path,
        view: selection,
      });
      expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
      const selected = parseEvidence(
        direct.structuredContent,
      ).normalized_result;
      expect(selected).toMatchObject({
        kind: "rust",
        parent_evidence_id: full.evidence_id,
        page: {
          collection: "packages",
          rows: [
            {
              index: 0,
              name: "same",
              version: "1",
              dependencies: [2],
              features: ["default"],
            },
            { index: 1, name: "same", version: "2", dependencies: [0, 2] },
          ],
        },
      });
      const summary = await call("inspect_rust_binary", {
        path,
        detail: "summary",
      });
      expect(summary.isError).not.toBe(true);
      expect(
        parseEvidence(summary.structuredContent).normalized_result,
      ).toMatchObject({
        kind: "summary",
        summary: {
          auditable_metadata: {
            counts: { packages: 4, edges: 5 },
            format_version: null,
          },
        },
        source_coverage: {
          embedded_records: "complete",
          runtime_dependencies: "unknown",
        },
      });
      const delivered = await cli.run({
        arguments: [
          "inspect-rust-binary",
          path,
          "--view",
          JSON.stringify(selection),
          "--evidence_output",
          output,
          "--json",
        ],
      });
      expect(delivered.exitCode, delivered.stderr).toBe(0);
      expect(delivered.json).toMatchObject({
        summary: { normalized_result: selected },
      });
      const bundle = await readEvidenceBundle(output);
      if (!bundle.ok) throw bundle.error;
      expect(
        bundle.value.records.find(
          (row) => row.evidence_id === full.evidence_id,
        ),
      ).toEqual({ ...full, caller_input_path: path });
      const exported = join(root, `${format}-record.json`);
      await writeFile(exported, JSON.stringify(full));
      await unlink(path);

      await assertRetainedPages(call, full.evidence_id, exported);
      await expectCycloneDxView(call, cli, {
        exported,
        format,
        root,
        parent: full,
      });
      const malformed = structuredClone(report);
      malformed.auditable_metadata!.dependency_edges[0]!.to_index = 999;
      const invalid = createEvidence(
        {
          path,
          sha256: report.artifact.sha256,
          format: metadataReportSubjectFormat({ format }),
          ...fileSubjectArchitecture(full.subject),
        },
        full.provider,
        {
          operation: full.operation,
          parameters: full.parameters,
          result: malformed,
        },
      );
      expect(
        parseMcpToolError(
          await call("inspect_analysis_view", {
            source: { kind: "inline", evidence: invalid },
            view: { kind: "rust", collection: "edges" },
          }),
        ).error,
      ).toMatchObject({ code: "invalid_request" });
    }
  },
);

cliTest(
  "queries historical feature omissions from authenticated bundles without changing the parent",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-historical-features-");
    const path = join(root, "source.elf");
    await writeFile(
      path,
      createRustImage({
        format: "elf",
        payload: rustDependencyPayload({
          packages: [{ name: "old", version: "1", source: "local" }],
        }),
      }),
    );
    const { call } = await connectLocalToolsMcp();
    const captured = await call("inspect_rust_binary", { path });
    expect(captured.isError, JSON.stringify(captured.content)).not.toBe(true);
    const full = parseEvidence(captured.structuredContent);
    const explicit = await call("inspect_rust_binary", {
      path,
      detail: "complete",
    });
    expect(parseEvidence(explicit.structuredContent)).toEqual(full);
    const report = rustBinarySchema.parse(full.normalized_result);
    const metadata = report.auditable_metadata;
    if (metadata === null) throw new Error("Expected Rust dependency metadata");
    const historical = createEvidence(
      {
        path,
        sha256: report.artifact.sha256,
        format: "elf",
        ...fileSubjectArchitecture(full.subject),
      },
      full.provider,
      {
        operation: full.operation,
        parameters: full.parameters,
        result: {
          ...report,
          auditable_metadata: {
            ...metadata,
            packages: metadata.packages.map(
              ({ features: _features, ...row }) => row,
            ),
          },
        },
      },
    );
    const bundle = join(root, "historical-bundle.json");
    const record = join(root, "historical-record.json");
    await writeFile(bundle, JSON.stringify(createEvidenceBundle([historical])));
    await writeFile(record, JSON.stringify(historical));
    await unlink(path);
    const view = { kind: "rust", collection: "packages", fields: ["features"] };
    const expected = {
      parent_evidence_id: historical.evidence_id,
      page: { rows: [{ index: 0, features: null }] },
    };
    const inline = await call("inspect_analysis_view", {
      source: { kind: "inline", evidence: historical },
      view,
    });
    expect(inline.isError, JSON.stringify(inline.content)).not.toBe(true);
    expect(
      parseEvidence(inline.structuredContent).normalized_result,
    ).toMatchObject(expected);
    for (const source of [
      { kind: "retained-evidence", evidence_id: historical.evidence_id },
      { kind: "evidence-file", path: record },
    ]) {
      const reply = await cli.run({
        arguments: [
          "inspect-analysis-view",
          JSON.stringify({ source, view }),
          ...(source.kind === "retained-evidence"
            ? ["--evidence-bundle", bundle]
            : []),
          "--json",
        ],
      });
      expect(reply.exitCode, reply.stderr + JSON.stringify(reply.json)).toBe(0);
      expect(parseEvidence(reply.json).normalized_result).toMatchObject(
        expected,
      );
    }
    const imported = await call("import_evidence_bundle", { path: bundle });
    expect(imported.isError, JSON.stringify(imported.content)).not.toBe(true);
    for (const fields of [["features"], [], ["features"]]) {
      const reply = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: historical.evidence_id,
        },
        view: { ...view, fields },
      });
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
      expect(
        parseEvidence(reply.structuredContent).normalized_result,
      ).toMatchObject({
        parent_evidence_id: historical.evidence_id,
        page: {
          rows: [
            fields.length === 0 ? { index: 0 } : { index: 0, features: null },
          ],
        },
      });
    }
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual(historical);
  },
);

cliTest(
  "preserves unknown Rust metadata and refuses invalid compact CLI choices before reading",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-view-missing-");
    const path = join(root, "plain.elf");
    await writeFile(
      path,
      createRustImage({ format: "elf", omitSection: true }),
    );
    const { call } = await connectLocalToolsMcp();
    const summary = await call("inspect_rust_binary", {
      path,
      detail: "summary",
    });
    expect(summary.isError).not.toBe(true);
    const view = analysisViewResultSchema.parse(
      parseEvidence(summary.structuredContent).normalized_result,
    );
    expect(view).toMatchObject({
      summary: { auditable_metadata: null },
      source_coverage: {
        embedded_records: "unknown",
        runtime_dependencies: "unknown",
      },
    });
    const collection = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "rust", collection: "edges", offset: 3, limit: 1 },
    });
    expect(collection.isError, JSON.stringify(collection.content)).not.toBe(
      true,
    );
    expect(
      parseEvidence(collection.structuredContent).normalized_result,
    ).toMatchObject({
      page: { collection: "edges", rows: [] },
      source_coverage: { embedded_records: "unknown" },
      coverage: {
        status: "unavailable",
        examined: 0,
        total: null,
        next_offset: null,
        exhausted: false,
      },
    });
    const missing = join(root, "never-created");
    for (const args of [
      ["--detail", "summary"],
      ["--view", "{"],
      ["--detail", "complete", "--view", '{"collection":"packages"}'],
    ]) {
      const refused = await cli.run({
        arguments: ["inspect-rust-binary", missing, ...args, "--json"],
      });
      expect(refused.exitCode).toBe(1);
      expect(refused.json).toMatchObject({ code: "invalid_request" });
      if (args[0] === "--view")
        expect(refused.json).toMatchObject({
          details: {
            operation: "inspect_rust_binary",
            issues: [
              {
                path: ["view"],
                reason: "invalid_format",
                message: "view must be a JSON package or edge selection",
              },
            ],
          },
        });
      expect(JSON.stringify(refused.json)).not.toContain("ENOENT");
    }
    expect((await readFile(path)).length).toBeGreaterThan(0);
  },
);
