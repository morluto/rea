import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "../../fixtures/canonicalOutputSchema.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { goBinarySchema } from "../../../src/domain/go/goBinary.js";
import {
  analysisViewResultSchema,
  goBinarySummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  createGoBinaryFixture,
  GO_MODULE_TEXT,
} from "../../fixtures/go/image.js";
import { createGoRodataStringFixture } from "../../fixtures/go/rodataStringImage.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

type Operation = "inspect_go_binary" | "inspect_analysis_view";
const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());
const writeGoModuleFixture = async (root: string) => {
  const path = join(root, "application");
  const fixture = createGoBinaryFixture({
    goVersion: "go1.26.0",
    moduleText:
      GO_MODULE_TEXT +
      "dep\texample.com/dependency\tv2.0.0\th1:second\nfuture\tunknown\n",
  });
  await writeFile(path, fixture.bytes);
  return { path, bytes: fixture.bytes };
};

const goViewTest = mcpTest.extend<{
  goViews: {
    client: Client;
    root: string;
    call: (
      name: Operation,
      input: Record<string, unknown>,
    ) => Promise<Evidence>;
  };
}>({
  goViews: async ({ mcp }, use) => {
    const root = await createTestTempDirectory("rea-go-views-");
    const session = createTestBinarySession(() => {
      throw new Error("No disassembler for Go views");
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
        undefined,
        schemaValidation,
      );
      const catalog = await client.listTools();
      const schemas = new Map(
        catalog.tools
          .filter(
            (tool) =>
              tool.name === "inspect_go_binary" ||
              tool.name === "inspect_analysis_view",
          )
          .map((tool) => {
            const output = canonicalOutputSchema(tool.name);
            if (output === undefined)
              throw new Error(`Missing ${tool.name} output schema`);
            expect(output.$schema).toBe(
              "https://json-schema.org/draft/2020-12/schema",
            );
            expect(schemaValidation.assertions.validateSchema(output)).toBe(
              true,
            );
            expect(
              schemaValidation.assertions.validateSchema(tool.inputSchema),
            ).toBe(true);
            return [tool.name, tool] as const;
          }),
      );
      const call = async (name: Operation, input: Record<string, unknown>) => {
        const tool = schemas.get(name);
        if (tool === undefined) throw new Error(`Missing ${name} tool`);
        expect(
          schemaValidation.getValidator(tool.inputSchema)(input).valid,
          `${name} rejected its valid input`,
        ).toBe(true);
        const reply = await client.callTool(
          { name, arguments: input },
          { toolDefinition: withCanonicalOutputSchema(tool) },
        );
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        return parseEvidence(reply.structuredContent);
      };
      await use({ client, root, call });
    } finally {
      await session.close();
    }
  },
});

const goPage = (evidence: Evidence) => {
  const view = analysisViewResultSchema.parse(evidence.normalized_result);
  if (view.kind !== "go") throw new Error("Expected a Go row page");
  return view;
};

goViewTest(
  "rejects authenticated inline and file parents with conflicting architecture",
  async ({ goViews: { client, root, call } }) => {
    const { path } = await writeGoModuleFixture(root);
    const complete = await call("inspect_go_binary", {
      detail: "complete",
      path,
    });
    const report = goBinarySchema.parse(complete.normalized_result);
    const conflicting = createEvidence(
      {
        path,
        sha256: report.artifact.sha256,
        format: "elf",
        architecture: "arm64",
      },
      { id: "go-build-info", name: "Go metadata test fixture", version: "1" },
      {
        operation: "inspect_go_binary",
        parameters: { path },
        result: report,
        confidence: "observed",
      },
    );
    const evidencePath = join(root, "conflicting.json");
    await writeFile(evidencePath, JSON.stringify(conflicting));
    for (const source of [
      { kind: "inline", evidence: conflicting },
      { kind: "evidence-file", path: evidencePath },
    ]) {
      for (const view of [
        { kind: "summary" },
        { kind: "go", collection: "dependencies" },
      ]) {
        const reply = await client.callTool({
          name: "inspect_analysis_view",
          arguments: { source, view },
        });
        expect(parseMcpToolError(reply).error).toMatchObject({
          code: "invalid_request",
          details: {
            operation: "inspect_analysis_view",
            issues: [{ path: ["source", "subject"], reason: "invalid_value" }],
          },
        });
      }
    }
  },
);

goViewTest(
  "rejects authenticated Go reports that claim complete parsing with unparsed records",
  async ({ goViews: { client, root, call } }) => {
    const moduleText = "path\tapp\nmod\tapp\tv1\ndep\tbroken\n";
    const rejections = [];
    for (const encoding of ["text", "bytes"] as const) {
      const fixture = createGoBinaryFixture({ moduleText });
      if (encoding === "bytes")
        fixture.bytes[
          fixture.moduleOffset + 16 + moduleText.indexOf("broken")
        ] = 0xff;
      const path = join(root, encoding);
      await writeFile(path, fixture.bytes);
      const admitted = await call("inspect_go_binary", {
        detail: "complete",
        path,
      });
      const report = goBinarySchema.parse(admitted.normalized_result);
      const info = report.build_info;
      if (info === null) throw new Error("Expected observed build info");
      expect(info.module.complete).toBe(false);
      expect(info.module.unparsed_lines).toHaveLength(
        encoding === "text" ? 1 : 0,
      );
      expect(info.module.unparsed_line_bytes_base64).toHaveLength(
        encoding === "bytes" ? 1 : 0,
      );
      const partialBom = await call("inspect_analysis_view", {
        source: { kind: "inline", evidence: admitted },
        view: { kind: "cyclonedx" },
      });
      expect(partialBom.normalized_result).toMatchObject({
        kind: "cyclonedx",
        document: { dependencies: [{ dependsOn: [expect.any(String)] }] },
      });

      const conflicting = createEvidence(
        {
          path,
          sha256: report.artifact.sha256,
          format: "elf",
          architecture: "x86_64",
        },
        { id: "go-build-info", name: "Go metadata test fixture", version: "1" },
        {
          operation: "inspect_go_binary",
          parameters: { path },
          result: {
            ...report,
            build_info: { ...info, module: { ...info.module, complete: true } },
          },
          confidence: "observed",
        },
      );
      for (const kind of ["summary", "cyclonedx"]) {
        rejections.push(
          await client.callTool({
            name: "inspect_analysis_view",
            arguments: {
              source: { kind: "inline", evidence: conflicting },
              view: { kind },
            },
          }),
        );
      }
    }
    expect(rejections.map(({ isError }) => isError)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    for (const response of rejections) {
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_analysis_view",
          issues: [
            {
              path: [
                "source",
                "normalized_result",
                "build_info",
                "module",
                "complete",
              ],
              reason: "invalid_value",
            },
          ],
        },
      });
    }
  },
);

goViewTest(
  "retains exact Go rows and complete Evidence after source removal",
  async ({ goViews: { client, root, call } }) => {
    const { path, bytes } = await writeGoModuleFixture(root);
    const complete = await call("inspect_go_binary", {
      detail: "complete",
      path,
    });
    const summary = await call("inspect_go_binary", {
      path,
      detail: "summary",
    });
    expect(summary).toMatchObject({
      raw_result: null,
      normalized_result: {
        kind: "summary",
        parent_evidence_id: complete.evidence_id,
        unknowns: expect.arrayContaining([
          expect.stringContaining("runtime dependencies"),
        ]),
        source_coverage: {
          build_info_available: true,
          module_parse_complete: false,
          runtime_dependencies: "unknown",
        },
        summary: {
          build_info: {
            go_version: "go1.26.0",
            module: {
              available_counts: {
                dependencies: 2,
                settings: 3,
                unparsed_lines: 1,
              },
            },
          },
        },
      },
    });
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    await unlink(path);
    const source = {
      kind: "retained-evidence",
      evidence_id: complete.evidence_id,
    };
    const query = async (view: Record<string, unknown>) =>
      goPage(await call("inspect_analysis_view", { source, view }));
    const dependencies = { kind: "go", collection: "dependencies" };
    const matching = { ...dependencies, paths: ["example.com/dependency"] };
    const pageView = {
      ...matching,
      fields: ["version", "replacement"],
      offset: 0,
      limit: 1,
    };
    const first = await query(pageView);
    expect(first.page.rows).toEqual([
      {
        index: 0,
        version: "v1.2.3",
        replacement: { path: "../dependency", version: "", sum: "" },
      },
    ]);
    expect(first.coverage).toMatchObject({
      total: 2,
      next_offset: 1,
      exhausted: false,
    });
    const second = await query({ ...pageView, offset: 1 });
    expect(second.page.rows).toEqual([
      { index: 1, version: "v2.0.0", replacement: null },
    ]);
    expect(second.coverage).toMatchObject({
      total: 2,
      next_offset: null,
      exhausted: true,
    });

    expect((await query({ ...dependencies, fields: [] })).page.rows).toEqual([
      { index: 0 },
      { index: 1 },
    ]);
    for (const { selection, total } of [
      { selection: { paths: [] }, total: 0 },
      { selection: { indices: [] }, total: 0 },
      { selection: { paths: ["other"], indices: [1] }, total: 0 },
      { selection: { offset: 99 }, total: 2 },
    ]) {
      const empty = await query({ ...dependencies, ...selection });
      expect(empty.page.rows).toEqual([]);
      expect(empty.coverage).toMatchObject({
        total,
        next_offset: null,
        exhausted: true,
      });
    }
    const selected = await query({
      ...matching,
      indices: [1],
      fields: ["version"],
    });
    expect(selected.page.rows).toEqual([{ index: 1, version: "v2.0.0" }]);
    const setting = await query({
      kind: "go",
      collection: "settings",
      keys: ["GOOS"],
      fields: ["value"],
    });
    expect(setting.page.rows).toEqual([{ index: 1, value: "linux" }]);
    expect(setting.coverage.total).toBe(1);
    const invalid = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source,
        view: { ...dependencies, fields: ["module_bytes_base64"] },
      },
    });
    expect(parseMcpToolError(invalid).error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
    });

    const bundlePath = join(root, "evidence.json");
    const exported = await client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: bundlePath },
    });
    expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      records: unknown[];
    };
    expect(
      bundle.records
        .map((record) => parseEvidence(record))
        .find((record) => record.evidence_id === complete.evidence_id),
    ).toEqual(complete);
    await client.ping();
  },
);

mcpTest(
  "keeps unavailable Go metadata unknown in summaries and empty pages",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-go-absent-view-");
    const path = join(root, "application");
    await writeFile(path, createGoBinaryFixture({ omitBuildInfo: true }).bytes);
    const session = createTestBinarySession(() => {
      throw new Error("No deep provider");
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      const reply = await client.callTool({
        name: "inspect_go_binary",
        arguments: { path, detail: "summary" },
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const summary = goBinarySummaryViewResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      expect(summary).toMatchObject({
        summary: { build_info: null },
        source_coverage: {
          build_info_available: false,
          module_parse_complete: null,
          runtime_dependencies: "unknown",
        },
      });
      const source = {
        kind: "retained-evidence",
        evidence_id: summary.parent_evidence_id,
      };
      const empty = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: { kind: "go", collection: "dependencies", offset: 3, limit: 1 },
        },
      });
      expect(empty.isError, JSON.stringify(empty)).not.toBe(true);
      const page = goPage(parseEvidence(empty.structuredContent));
      expect(page).toMatchObject({
        page: { collection: "dependencies", rows: [] },
        coverage: {
          status: "unavailable",
          examined: 0,
          total: null,
          next_offset: null,
          exhausted: false,
        },
        source_coverage: {
          build_info_available: false,
          module_parse_complete: null,
          runtime_dependencies: "unknown",
        },
      });
      expect(page.unknowns.join(" ")).toContain("remain unknown");
      const incompatible = await client.callTool({
        name: "inspect_analysis_view",
        arguments: { source, view: { kind: "native", facet: "procedure" } },
      });
      expect(parseMcpToolError(incompatible).error.code).toBe(
        "invalid_request",
      );
    } finally {
      await session.close();
    }
  },
);

goViewTest(
  "pages and filters retained Go string_literals through MCP views",
  async ({ goViews: { client, root, call } }) => {
    const path = join(root, "strings.elf");
    const fixture = createGoRodataStringFixture({
      format: "elf",
      rodata: Buffer.from(
        "ListResourceProvidersgenaihttps://example.invalid/v1",
        "utf8",
      ),
      headers: [
        { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 21n },
        { section: "data", offsetInSection: 16, ptr: 0x102015n, len: 5n },
        { section: "data", offsetInSection: 32, ptr: 0x10201an, len: 26n },
        { section: "data", offsetInSection: 48, ptr: 0x102015n, len: 5n },
      ],
    });
    await writeFile(path, fixture.bytes);

    const limited = goBinarySummaryViewResultSchema.parse(
      (
        await call("inspect_go_binary", {
          path,
          include_string_literals: true,
          max_string_literals: 2,
          detail: "summary",
        })
      ).normalized_result,
    );
    expect(limited.source_coverage.string_literals).toBe("truncated");
    expect(limited.summary.string_literals).toMatchObject({
      evidence_kind: "inferred",
      available_count: 2,
      discovered_count: 3,
      aggregate_bytes: 26,
      max_items: 2,
      truncated: true,
      limits_reached: ["max_string_literals"],
    });

    const summary = goBinarySummaryViewResultSchema.parse(
      (
        await call("inspect_go_binary", {
          path,
          include_string_literals: true,
          detail: "summary",
        })
      ).normalized_result,
    );
    expect(summary.source_coverage.string_literals).toBe("complete");
    expect(summary.summary.string_literals).toMatchObject({
      evidence_kind: "inferred",
      available_count: 3,
      discovered_count: 3,
      truncated: false,
    });

    expect(
      limited.unknowns.filter((reason) => !summary.unknowns.includes(reason)),
    ).toHaveLength(1);

    const source = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    const page = goPage(
      await call("inspect_analysis_view", {
        source,
        view: {
          kind: "go",
          collection: "string_literals",
          contains: "ena",
          fields: ["value", "location", "reference_count"],
        },
      }),
    );
    expect(page.page).toEqual({
      collection: "string_literals",
      rows: [
        {
          index: 1,
          value: "genai",
          location: { offset: fixture.rodataOffset + 21, bytes: 5 },
          reference_count: 2,
        },
      ],
    });

    const unrequestedSummary = goBinarySummaryViewResultSchema.parse(
      (await call("inspect_go_binary", { path, detail: "summary" }))
        .normalized_result,
    );
    expect(unrequestedSummary.source_coverage.string_literals).toBe(
      "not-requested",
    );
    const refused = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: unrequestedSummary.parent_evidence_id,
        },
        view: { kind: "go", collection: "string_literals" },
      },
    });
    expect(parseMcpToolError(refused).error).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: ["view", "collection"], reason: "invalid_value" }],
      },
    });
  },
);
