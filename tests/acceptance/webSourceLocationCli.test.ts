import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { expect, onTestFinished } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { webSourceLocationFixture } from "../fixtures/webSourceLocation.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../support/cli/cliFixture.js";

const expectRetainedSourceMap = async (
  path: string,
  evidenceId: string,
  sha256: string,
) => {
  const bytes = await readFile(path);
  const bundle = JSON.parse(bytes.toString("utf8")) as {
    records: {
      evidence_id: string;
      raw_result: { source_map_text?: string } | null;
    }[];
  };
  const parent = bundle.records.find(
    (record) => record.evidence_id === evidenceId,
  );
  expect(parent?.evidence_id).toBe(evidenceId);
  expect(
    createHash("sha256")
      .update(parent?.raw_result?.source_map_text ?? "")
      .digest("hex"),
  ).toBe(sha256);
  return bytes.length;
};

const expectEqualPositionSummary = async (
  client: Client,
  input: Record<string, unknown>,
) => {
  const compact = await client.callTool({
    name: "trace_web_source_location",
    arguments: {
      ...input,
      detail: "summary",
    },
  });
  expect(compact.isError).not.toBe(true);
  expect(compact.structuredContent).toMatchObject({
    normalized_result: {
      summary: {
        match_count: 2,
        matches: [
          { match_index: 0, source_index: 0 },
          { match_index: 1, source_index: 1 },
        ],
      },
    },
  });
  expect(JSON.stringify(compact.structuredContent)).not.toContain('"text":');
};

const expectCliSourceLocationSummary = async (
  cli: TestCli,
  arguments_: readonly string[],
  expected: { bundlePath: string; evidenceId: string; sha256: string },
) => {
  const { bundlePath, evidenceId, sha256 } = expected;
  const missingSink = await cli.run({
    arguments: [...arguments_, "--detail", "summary"],
    timeoutMs: 45000,
  });
  expect(missingSink.exitCode).toBe(1);
  expect(missingSink.json).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["evidence_output"] }] },
  });
  const summary = await cli.run({
    arguments: [
      ...arguments_,
      "--detail",
      "summary",
      "--evidence_output",
      bundlePath,
    ],
    timeoutMs: 45000,
  });
  expect(summary.exitCode, summary.stderr).toBe(0);
  expect(summary.stdout.length).toBeLessThan(30000);
  const retainedBytes = await expectRetainedSourceMap(
    bundlePath,
    evidenceId,
    sha256,
  );
  expect(summary.json).toMatchObject({
    evidence_bundle: { path: bundlePath, bytes: retainedBytes },
    summary: {
      normalized_result: {
        parent_evidence_id: evidenceId,
        summary: {
          match_count: 1,
          matches: [
            {
              match_index: 0,
              source_index: 0,
              content: { state: "embedded", code_units: 8 },
            },
          ],
        },
      },
    },
  });
};

const expectInvalidSourceLocation = (
  json: unknown,
  manifest: string,
  root: string,
  map: string,
  sourceMapText: string,
) => {
  expect(json).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["generated_position", "line"],
          reason: "out_of_range",
          maximum: 1,
        },
      ],
      partial_observation: {
        kind: "web-trace-observation",
        analysis: "incomplete",
        manifest: { path: manifest },
        source: { path: join(root, "files", "modules", "main.js") },
        source_map: {
          path: map,
          sha256: createHash("sha256").update(sourceMapText).digest("hex"),
        },
      },
    },
  });
};

const expectSourceLocationLimitations = (json: unknown) => {
  const limitation =
    "Source names and sourceRoot are reported declarations. REA derives resolved URLs using WHATWG URL resolution; the pinned upstream codec decodes mappings. No original source is fetched or executed.";
  expect(json).toMatchObject({
    limitations: expect.arrayContaining([limitation]),
    normalized_result: { limitations: expect.arrayContaining([limitation]) },
  });
};

const expectColumnOutOfRange = (
  response: Parameters<typeof parseMcpToolError>[0],
  sourceLength: number,
) => {
  expect(parseMcpToolError(response).error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["generated_position", "column"],
          reason: "out_of_range",
          maximum: sourceLength,
        },
      ],
    },
  });
};

cliTest(
  "accepts numeric UTF-16 coordinates and runs the actual owned source-map codec without a browser",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-map-cli-");
    const fixture = webSourceLocationFixture(
      JSON.stringify({
        version: 3,
        sources: ["dir/original.ts", "dir//original.ts"],
        sourcesContent: ["original", "second"],
        names: [],
        mappings: "AAAA,ACAA",
      }),
    );
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    let manifest = join(root, "manifest.json").replaceAll("\\", "/");
    const map = join(root, "app.js.map");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    if (process.platform !== "win32") {
      await mkdir(join(root, "lexical"));
      await mkdir(join(root, "nested"));
      await symlink(join(root, "nested"), join(root, "lexical", "link"));
      manifest = `${root}/lexical/link/../manifest.json`;
    }
    await writeFile(map, fixture.sourceMap.text);
    const response = await cli.run({
      arguments: [
        "trace-web-source-location",
        manifest,
        "0",
        map,
        fixture.sourceMap.url,
        "1",
        "0",
        "--json",
      ],
      environment: {
        REA_LOG_LEVEL: "silent",
        REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
        CLANG_MODULE_CACHE_PATH: map,
      },
      timeoutMs: 45000,
    });
    expect(response.exitCode, response.stdout + response.stderr).toBe(0);
    expect(response.json).toMatchObject({
      normalized_result: {
        manifest: {
          path: manifest,
          reported_output_directory: fixture.manifest.output_directory,
        },
        source: {
          script_index: 0,
          path: join(root, "files", "modules", "main.js"),
        },
        source_map: { association: "caller-selected" },
        generated_offset: 0,
        execution: "unknown",
        matches: [
          {
            source_index: 0,
            resolved_url: "https://app.test/dir/original.ts",
            content: { text: "original" },
          },
          {
            source_index: 1,
            resolved_url: "https://app.test/dir//original.ts",
            content: { text: "second" },
          },
        ],
        runtime: {
          id: process.versions.bun === undefined ? "node-v8" : "bun",
        },
      },
    });
    expectSourceLocationLimitations(response.json);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
        "mcp",
      ],
      env: {
        ...getDefaultEnvironment(),
        REA_LOG_LEVEL: "silent",
        CLANG_MODULE_CACHE_PATH: map,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "source-location-cli-parity",
      version: "1",
    });
    onTestFinished(async () => {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    });
    await client.connect(transport);
    const mcpResponse = await client.callTool({
      name: "trace_web_source_location",
      arguments: {
        manifest_path: manifest,
        script_index: 0,
        source_map: { path: map, url: fixture.sourceMap.url },
        generated_position: { line: 1, column: 0 },
      },
    });
    expect(mcpResponse.isError, JSON.stringify(mcpResponse)).not.toBe(true);
    expect(mcpResponse.structuredContent).toEqual(response.json);
    await expectEqualPositionSummary(client, {
      manifest_path: manifest,
      script_index: 0,
      source_map: { path: map, url: fixture.sourceMap.url },
      generated_position: { line: 1, column: 0 },
    });
    const pastColumn = await client.callTool({
      name: "trace_web_source_location",
      arguments: {
        manifest_path: manifest,
        script_index: 0,
        source_map: { path: map, url: fixture.sourceMap.url },
        generated_position: { line: 1, column: 10 },
      },
    });
    expectColumnOutOfRange(pastColumn, fixture.source.length);
    const invalid = await cli.run({
      arguments: [
        "trace-web-source-location",
        manifest,
        "0",
        map,
        fixture.sourceMap.url,
        "2",
        "0",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
      timeoutMs: 45000,
    });
    expect(invalid.exitCode).toBe(1);
    expectInvalidSourceLocation(
      invalid.json,
      manifest,
      root,
      map,
      fixture.sourceMap.text,
    );
  },
  // Allow cold CLI and MCP ownership preparation across the full parity sequence.
  180_000,
);

cliTest(
  "applies the shared version constraint to nested indexed maps through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-indexed-map-version-");
    const fixture = webSourceLocationFixture();
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json").replaceAll("\\", "/");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    const { call } = await connectLocalToolsMcp({
      REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
    });
    const leaf: unknown = JSON.parse(fixture.sourceMap.text);
    for (const [index, version] of [3, 2, null, undefined, "3"].entries()) {
      const text = JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version,
              sections: [{ offset: { line: 0, column: 0 }, map: leaf }],
            },
          },
        ],
      });
      const path = join(root, `nested-${index}.map`);
      await writeFile(path, text);
      const result = await cli.run({
        arguments: [
          "trace-web-source-location",
          manifest,
          "0",
          path,
          fixture.sourceMap.url,
          "1",
          "0",
          "--json",
        ],
        environment: {
          REA_LOG_LEVEL: "silent",
          REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
        },
        timeoutMs: 45_000,
      });
      const response = await call("trace_web_source_location", {
        manifest_path: manifest,
        script_index: 0,
        source_map: { path, url: fixture.sourceMap.url },
        generated_position: { line: 1, column: 0 },
      });
      if (version === 3) {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            matches: [
              {
                state: "mapped",
                section_path: [0, 0],
                content: { text: "original" },
              },
            ],
          },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        expect(response.structuredContent).toEqual(result.json);
      } else {
        const failure = {
          code: "invalid_request",
          details: {
            partial_observation: {
              kind: "web-trace-observation",
              analysis: "incomplete",
              manifest: {
                path: manifest,
                sha256: createHash("sha256")
                  .update(JSON.stringify(fixture.manifest))
                  .digest("hex"),
              },
              source: {
                path: join(root, "files", "modules", "main.js"),
                sha256: createHash("sha256")
                  .update(fixture.source)
                  .digest("hex"),
              },
              source_map: {
                path,
                sha256: createHash("sha256").update(text).digest("hex"),
                bytes: Buffer.byteLength(text),
              },
            },
            issues: [
              {
                path: ["source_map", "path"],
                reason: "invalid_format",
                message: expect.stringContaining(
                  "not a version 3 map. Section path: [0].",
                ),
              },
            ],
          },
        };
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject(failure);
        expect(result.json).not.toHaveProperty("normalized_result");
        expect(parseMcpToolError(response).error).toMatchObject(failure);
        expect(response.structuredContent).toBeUndefined();
      }
    }
  },
  180_000,
);

cliTest(
  "traces empty equal-offset sections while rejecting decreasing offsets and represented overlaps",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-empty-indexed-map-");
    const fixture = webSourceLocationFixture();
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json").replaceAll("\\", "/");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    const { call } = await connectLocalToolsMcp();
    const leaf: unknown = JSON.parse(fixture.sourceMap.text);
    const empty = { version: 3, sources: [], names: [], mappings: "" };
    const nestedEmpty = {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: empty }],
    };
    for (const [index, sample] of [
      { first: empty, firstColumn: 0, nextColumn: 0, succeeds: true },
      { first: nestedEmpty, firstColumn: 0, nextColumn: 0, succeeds: true },
      { first: empty, firstColumn: 0, nextColumn: 1, succeeds: true },
      { first: leaf, firstColumn: 0, nextColumn: 0, succeeds: false },
      { first: empty, firstColumn: 1, nextColumn: 0, succeeds: false },
    ].entries()) {
      const path = join(root, `empty-${index}.map`);
      await writeFile(
        path,
        JSON.stringify({
          version: 3,
          sections: [
            {
              offset: { line: 0, column: sample.firstColumn },
              map: sample.first,
            },
            { offset: { line: 0, column: sample.nextColumn }, map: leaf },
          ],
        }),
      );
      const result = await cli.run({
        arguments: [
          "trace-web-source-location",
          manifest,
          "0",
          path,
          fixture.sourceMap.url,
          "1",
          String(sample.nextColumn),
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
        timeoutMs: 45_000,
      });
      const response = await call("trace_web_source_location", {
        manifest_path: manifest,
        script_index: 0,
        source_map: { path, url: fixture.sourceMap.url },
        generated_position: { line: 1, column: sample.nextColumn },
      });
      if (sample.succeeds) {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.json).toMatchObject({
          normalized_result: {
            lookup: {
              matched_generated_position: {
                line: 1,
                column: sample.nextColumn,
              },
            },
            matches: [
              {
                state: "mapped",
                section_path: [1],
                content: { text: "original" },
              },
            ],
          },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        expect(response.structuredContent).toEqual(result.json);
      } else {
        const failure = {
          code: "invalid_request",
          details: {
            issues: [
              {
                path: ["source_map", "path"],
                reason: "invalid_format",
                message: expect.stringMatching(/overlap|nondecreasing/u),
              },
            ],
          },
        };
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject(failure);
        expect(parseMcpToolError(response).error).toMatchObject(failure);
      }
    }
  },
  180_000,
);

cliTest(
  "resolves empty-sourceRoot sources against the map URL through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-empty-source-root-");
    // webpack 5 and tsc emit `"sourceRoot": ""` for map-relative sources.
    const text = JSON.stringify({
      version: 3,
      sourceRoot: "",
      sources: ["../src/a.ts", "webpack://app/./src/b.ts", "dir//c.ts"],
      sourcesContent: ["a", "b", "c"],
      names: [],
      mappings: "AAAA,ACAA,ACAA",
    });
    const fixture = webSourceLocationFixture(text);
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json").replaceAll("\\", "/");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    const map = join(root, "app.js.map");
    await writeFile(map, text);
    const url = "https://cdn.test/npm/app@1/dist/app.js.map";
    const result = await cli.run({
      arguments: [
        "trace-web-source-location",
        manifest,
        "0",
        map,
        url,
        "1",
        "0",
        "--json",
      ],
      environment: {
        REA_LOG_LEVEL: "silent",
        REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
      },
      timeoutMs: 45_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      normalized_result: {
        matches: [
          {
            source_index: 0,
            reported_source_root: "",
            resolved_url: "https://cdn.test/npm/app@1/src/a.ts",
          },
          {
            source_index: 1,
            reported_source_root: "",
            resolved_url: "webpack://app/src/b.ts",
          },
          {
            source_index: 2,
            reported_source_root: "",
            resolved_url: "https://cdn.test/npm/app@1/dist/dir//c.ts",
          },
        ],
      },
    });
    const { call } = await connectLocalToolsMcp({
      REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
    });
    const response = await call("trace_web_source_location", {
      manifest_path: manifest,
      script_index: 0,
      source_map: { path: map, url },
      generated_position: { line: 1, column: 0 },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(result.json);
  },
  180_000,
);

cliTest(
  "raises local source-map admission and recovers the same complete map through the owned codec",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-map-budget-cli-");
    const fixture = webSourceLocationFixture(
      JSON.stringify({
        version: 3,
        sources: ["original.ts"],
        sourcesContent: ["original"],
        names: [],
        mappings: "AAAA",
        x_padding: "x".repeat(1024),
      }),
    );
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json");
    const map = join(root, "app.js.map");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    await writeFile(map, fixture.sourceMap.text);
    const args = [
      "trace-web-source-location",
      manifest,
      "0",
      map,
      fixture.sourceMap.url,
      "1",
      "0",
      "--format",
      "json",
    ];
    const refused = await cli.run({
      arguments: [...args, "--source-map-bytes", "128"],
      timeoutMs: 45000,
    });
    expect(refused.exitCode).toBe(1);
    expect((refused.json as { code?: unknown }).code).toBe("truncated");
    expect(refused.json).toMatchObject({
      code: "truncated",
      details: {
        detail: expect.stringContaining("source_map_limits.map_bytes"),
      },
    });
    const recovered = await cli.run({
      arguments: [
        ...args,
        "--source-map-bytes",
        String(Buffer.byteLength(fixture.sourceMap.text)),
      ],
      timeoutMs: 45000,
    });
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(recovered.json).toMatchObject({
      parameters: {
        source_map_limits: {
          map_bytes: Buffer.byteLength(fixture.sourceMap.text),
        },
      },
      normalized_result: {
        source_map: {
          sha256: createHash("sha256")
            .update(fixture.sourceMap.text)
            .digest("hex"),
        },
        matches: [
          { reported_source: "original.ts", content: { text: "original" } },
        ],
      },
    });
  },
);

cliTest(
  "admits a complete map above 4 MiB by default while honoring a smaller caller budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-map-default-admission-");
    const fixture = webSourceLocationFixture(
      JSON.stringify({
        version: 3,
        sources: ["original.ts"],
        sourcesContent: ["original"],
        names: [],
        mappings: "AAAA",
        x_retained_extension: "x".repeat(6 * 1024 * 1024),
      }),
    );
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json");
    const map = join(root, "app.js.map");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    await writeFile(map, fixture.sourceMap.text);
    const arguments_ = [
      "trace-web-source-location",
      manifest,
      "0",
      map,
      fixture.sourceMap.url,
      "1",
      "0",
      "--json",
    ];
    const refused = await cli.run({
      arguments: [...arguments_, "--source-map-bytes", "4194304"],
      timeoutMs: 45000,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.stringify(refused.json)).toContain(
      "source_map_limits.map_bytes",
    );
    const completed = await cli.run({
      arguments: arguments_,
      timeoutMs: 45000,
    });
    expect(completed.exitCode, completed.stderr).toBe(0);
    const evidence = completed.json as {
      evidence_id: string;
      normalized_result: unknown;
      raw_result: { source_map_text: string };
    };
    expect(evidence.normalized_result).toMatchObject({
      source_map: { sha256: fixture.sourceMap.file.sha256 },
      matches: [{ source_index: 0, content: { text: "original" } }],
    });
    expect(
      createHash("sha256")
        .update(evidence.raw_result.source_map_text)
        .digest("hex"),
    ).toBe(fixture.sourceMap.file.sha256);
    await expectCliSourceLocationSummary(cli, arguments_, {
      bundlePath: join(root, "cli-complete.json"),
      evidenceId: evidence.evidence_id,
      sha256: fixture.sourceMap.file.sha256,
    });
    const { call } = await connectLocalToolsMcp();
    const input = {
      manifest_path: manifest,
      script_index: 0,
      source_map: { path: map, url: fixture.sourceMap.url },
      generated_position: { line: 1, column: 0 },
    };
    const overflow = await call("trace_web_source_location", input);
    expect(parseMcpToolError(overflow).error).toMatchObject({
      code: "resource_constraint",
      details: {
        reported_limits: {
          boundary: "mcp-response",
          evidence_reference: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
          continuation: {
            name: "inspect_analysis_view",
            arguments: {
              view: { kind: "source-location", collection: "matches" },
            },
          },
        },
      },
    });
    await unlink(map);
    const source = {
      kind: "retained-evidence",
      evidence_id: evidence.evidence_id,
    };
    const page = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "source-location",
        collection: "matches",
        offset: 0,
        limit: 1,
      },
    });
    expect(page.isError).not.toBe(true);
    expect(page.structuredContent).toMatchObject({
      normalized_result: {
        items: [
          {
            match_index: 0,
            source_index: 0,
            original_position: { line: 1, column: 0 },
          },
        ],
        coverage: { total: 1, exhausted: true },
      },
    });
    const text = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "source-location",
        collection: "source-text",
        match_index: 0,
        offset: 0,
        limit: 8,
      },
    });
    expect(text.isError).not.toBe(true);
    expect(text.structuredContent).toMatchObject({
      normalized_result: { item: { text: "original" } },
    });
    const exportPath = join(root, "session-complete.json");
    expect(
      (await call("export_evidence_bundle", { path: exportPath })).isError,
    ).not.toBe(true);
    await expectRetainedSourceMap(
      exportPath,
      evidence.evidence_id,
      fixture.sourceMap.file.sha256,
    );
    const emptyMap = '{"version":3,"sources":[],"names":[],"mappings":""}';
    await writeFile(map, emptyMap);
    const empty = await call("trace_web_source_location", {
      ...input,
      detail: "summary",
    });
    expect(empty.isError).not.toBe(true);
    expect(empty.structuredContent).toMatchObject({
      normalized_result: {
        summary: { match_count: 0, matches: [] },
        coverage: { status: "empty", total: 0, exhausted: true },
      },
    });
  },
  180_000,
);
