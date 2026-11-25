import { rustBinarySchema } from "../../src/domain/rust/rustBinary.js";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { machoImageWithUnknownCommand } from "../../src/artifacts/apple/MachoImage.fixture.js";
import {
  compressRustElfSectionNames,
  createRustHashOverflowImage,
  createRustImage,
  createRustWasmModule,
  createRustImageWithGoSection,
  RUSTC_HASH,
  rustDependencyPayload,
} from "../fixtures/rust/image.js";
import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { lazyLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { expectCliMcpEvidenceParity } from "../fixtures/cliMcpEvidenceParity.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";

const connectLocalToolsMcp = lazyLocalToolsMcp();

cliTest(
  "rejects misaligned 64-bit Mach-O through Rust CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-macho-alignment-");
    const { client, call } = await connectLocalToolsMcp();
    const expectedFailure = {
      code: "unsupported_target",
      details: {
        operation: "inspect_rust_binary",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
      },
    };

    const path = join(root, "misaligned.macho");
    await writeFile(path, machoImageWithUnknownCommand(true, 12));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject(expectedFailure);
    expect(result.json).not.toHaveProperty("normalized_result");
    const response = await call("inspect_rust_binary", { path });
    expect(parseMcpToolError(response).error).toMatchObject(expectedFailure);
    expect(response.structuredContent).toBeUndefined();
    await client.ping();
  },
);

cliTest(
  "reports cargo-auditable packages from thin Mach-O and core Wasm",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-carriers-");
    for (const [name, bytes, section] of [
      ["sample.macho", createRustImage({ format: "macho" }), "__DATA,.dep-v0"],
      ["sample.wasm", createRustWasmModule(), ".dep-v0"],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-rust-binary", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        result.json,
      );
      const report = rustBinarySchema.parse(evidence.normalized_result);
      expect(report.auditable_metadata).toMatchObject({
        section_name: section,
        format_version: 1,
        root_package_index: 1,
        packages: [
          { name: "itoa", version: "1.0.18" },
          { name: "sample", version: "0.1.0", root: true },
        ],
        dependency_edges: [{ from_index: 1, to_index: 0 }],
      });
      if (name === "sample.wasm") {
        expect(fileIdentity(evidence.subject)).toMatchObject({
          format: "file",
          architecture: null,
        });
        expect(report).toMatchObject({
          format: "wasm",
          architecture: "wasm",
          bits: null,
          byte_order: "little",
        });
      } else {
        expect(report).toMatchObject({ format: "macho", bits: 64 });
      }
    }
  },
);

cliTest(
  "refuses a WebAssembly component as an unsupported target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-component-");
    const path = join(root, "component.wasm");
    await writeFile(path, Buffer.from("0061736d0d000100", "hex"));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_rust_binary",
        reason: expect.stringContaining("components are unsupported"),
      },
    });
  },
);

cliTest(
  "preserves historical cargo-auditable features through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-features-legacy-");
    const { client, call } = await connectLocalToolsMcp();
    const packageFields = { version: "1.2.3", source: "crates.io" };
    const path = join(root, "historical.elf");
    await writeFile(
      path,
      createRustImage({
        format: "elf",
        payload: rustDependencyPayload({
          packages: [
            {
              ...packageFields,
              name: "selected",
              features: ["default", "serde"],
            },
            { ...packageFields, name: "unknown" },
            { ...packageFields, name: "empty", features: [] },
            {
              name: "app",
              version: "0.1.0",
              source: "local",
              dependencies: [0, 1, 2],
              root: true,
            },
          ],
        }),
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    const report = rustBinarySchema.parse(evidence.normalized_result);
    expect(
      report.auditable_metadata?.packages.map(({ name, features }) => [
        name,
        features,
      ]),
    ).toEqual([
      ["selected", ["default", "serde"]],
      ["unknown", null],
      ["empty", []],
      ["app", null],
    ]);
    const response = await call("inspect_rust_binary", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expectCliMcpEvidenceParity(evidence, response.structuredContent, path);
    await client.ping();
  },
);

cliTest(
  "distinguishes compressed ELF names, unknown names and an absent dependency section",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-rust-elf-compressed-names-",
    );
    for (const fixture of [
      { name: "zlib", type: 1, supported: true },
      { name: "zstd", type: 2, supported: true },
      { name: "unknown", type: 3, supported: false },
      { name: "absent", type: null, supported: false },
    ]) {
      const path = join(root, `${fixture.name}.elf`);
      await writeFile(
        path,
        fixture.type === null
          ? createRustImage({ format: "elf", omitSection: true })
          : compressRustElfSectionNames(
              createRustImage({ format: "elf" }),
              fixture.type,
            ),
      );
      const result = await cli.run({
        arguments: ["inspect-rust-binary", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        result.json,
      );
      const report = rustBinarySchema.parse(evidence.normalized_result);
      if (fixture.supported) {
        expect(report.auditable_metadata).toMatchObject({
          section_name: ".dep-v0",
          packages: [
            { name: "itoa", version: "1.0.18" },
            { name: "sample", version: "0.1.0", root: true },
          ],
          dependency_edges: [{ from_index: 1, to_index: 0 }],
        });
      } else if (fixture.name === "absent") {
        expect(report.auditable_metadata).toBeNull();
        expect(report.limitations.join("\n")).toContain(
          "does not mean the binary has no dependencies",
        );
      } else {
        expect(report.auditable_metadata).toBeNull();
        expect(report.limitations.join("\n")).toMatch(
          /section names.*unavailable.*compression type 3.*unsupported/iu,
        );
        expect(report.limitations.join("\n")).toContain(
          "The presence of .dep-v0 could not be determined",
        );
        expect(report.limitations.join("\n")).not.toContain(
          "No .dep-v0 section was found",
        );
      }
    }
  },
);

cliTest(
  "keeps arm64_32 in Rust CLI Evidence when dependency metadata is absent",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-arm64-32-");
    const path = join(root, "watchos-object");
    const bytes = createRustImage({
      format: "macho",
      omitSection: true,
      includeRustc: false,
    });
    bytes.writeUInt32LE(0x0200000c, 4);
    await writeFile(path, bytes);

    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.subject).toMatchObject({
      identity: { format: "mach-o", architecture: "arm64_32" },
    });
    expect(rustBinarySchema.parse(evidence.normalized_result)).toMatchObject({
      architecture: "arm64_32",
      bits: 64,
      auditable_metadata: null,
      rustc_commit: null,
    });
  },
);

cliTest(
  "preserves an unknown cargo-auditable revision and reports its fallback",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-unknown-format-");
    const path = join(root, "sample");
    const payload = rustDependencyPayload({
      format: 4,
      packages: [
        { name: "sample", version: "0.1.0", source: "local", root: true },
      ],
    });
    await writeFile(path, createRustImage({ format: "elf", payload }));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    const report = rustBinarySchema.parse(evidence.normalized_result);
    expect(report.auditable_metadata?.format_version).toBe(4);
    expect(report.limitations.join("\n")).toContain(
      "highest known preceding revision (1)",
    );
    expect(report.limitations.join("\n")).toContain(
      "this specific revision has not been independently verified",
    );
  },
);

cliTest(
  "rejects duplicate Rust dependency JSON through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-duplicate-json-");
    const { client, call } = await connectLocalToolsMcp();
    const path = join(root, "duplicate.elf");
    await writeFile(
      path,
      createRustImage({
        format: "elf",
        payload: deflateSync(Buffer.from('{"packages":[],"packages":[]}')),
        includeRustc: false,
      }),
    );

    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_rust_binary" },
    });
    const response = await call("inspect_rust_binary", { path });
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_rust_binary" },
    });
    await client.ping();
  },
);

function padRustPeDependencySection(bytes: Buffer, alignment: number): void {
  bytes.writeUInt32LE(alignment, 152 + 36); // OptionalHeader.FileAlignment
  bytes.writeUInt32LE(0, 264 + 8); // .dep-v0 VirtualSize
  bytes.writeUInt32LE(alignment, 264 + 16); // .dep-v0 SizeOfRawData
}

cliTest(
  "reads PE cargo-auditable data padded to FileAlignment through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-pe-padding-");
    const { client, call } = await connectLocalToolsMcp();
    const path = join(root, "padded.exe");
    const bytes = createRustImage({ format: "pe", includeRustc: false });
    const compressedBytes = rustDependencyPayload().length;
    const alignedSize = 512;
    expect(compressedBytes).toBeLessThan(alignedSize);
    padRustPeDependencySection(bytes, alignedSize);
    await writeFile(path, bytes);

    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    const metadata = rustBinarySchema.parse(
      evidence.normalized_result,
    ).auditable_metadata;
    expect(metadata).toMatchObject({
      file_offset: 1024,
      section_bytes: alignedSize,
      compressed_bytes: compressedBytes,
      packages: [
        { name: "itoa", version: "1.0.18" },
        { name: "sample", version: "0.1.0", root: true },
      ],
    });
    // Padding separates the section size from the consumed stream that the
    // inflate guidance names.
    expect(evidence.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /inflated JSON.*64 times the consumed compressed-stream length/iu,
        ),
      ]),
    );
    expect(evidence.locations).toContainEqual({
      kind: "file-offset-range",
      start: 1024,
      end: 1536,
    });
    const response = await call("inspect_rust_binary", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expectCliMcpEvidenceParity(evidence, response.structuredContent, path);
    await client.ping();
  },
);

cliTest(
  "limits PE inflate ratio by consumed zlib bytes through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-pe-ratio-");
    const { client, call } = await connectLocalToolsMcp();
    const path = join(root, "over-ratio.exe");
    const document = Buffer.concat([
      Buffer.from(JSON.stringify({ packages: [] })),
      Buffer.alloc(24 * 1024, 0x20),
    ]);
    const compressed = deflateSync(document);
    const alignedSize = 512;
    expect(compressed.length).toBeLessThan(alignedSize);
    expect(document.length).toBeGreaterThan(compressed.length * 64);
    expect(document.length).toBeLessThanOrEqual(alignedSize * 64);

    const bytes = createRustImage({
      format: "pe",
      payload: compressed,
      includeRustc: false,
    });
    padRustPeDependencySection(bytes, alignedSize);
    await writeFile(path, bytes);

    const expectedFailure = {
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_rust_binary",
        resource: "memory",
        reported_limits: { maximum_bytes: compressed.length * 64 },
      },
    };
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject(expectedFailure);
    const response = await call("inspect_rust_binary", { path });
    expect(parseMcpToolError(response).error).toMatchObject(expectedFailure);
    await client.ping();
  },
);

cliTest(
  "releases a failed Rust descriptor close before projecting the CLI failure",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-close-");
    const path = join(root, "sample.elf");
    const marker = join(root, "close-events.json");
    const preload = join(root, "deny-first-close.mjs");
    const bytes = createRustImage({ format: "elf" });
    await writeFile(path, bytes);
    await writeFile(
      preload,
      `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.promises.open;
    const events = [];
    let denied = false;
    let opened = 0;
    fs.promises.open = async (...args) => {
      const file = await open(...args);
      if (String(args[0]) !== process.env.REA_TEST_SELECTED_FILE) return file;
      const handleId = opened++;
      events.push({ stage: 'opened', handleId });
      const close = file.close.bind(file);
      let releaseObserved = false;
      file.close = async () => {
        if (!denied) {
          denied = true;
          events.push({ stage: 'denied', handleId, open: file.fd >= 0 });
          fs.writeFileSync(process.env.REA_TEST_CLOSE_EVENTS, JSON.stringify(events));
          throw new Error('controlled Rust descriptor close failure');
        }
        await close();
        // Node can re-enter close while notifying its attached read stream.
        // Record the descriptor's completed transition once per exact handle.
        if (!releaseObserved) {
          releaseObserved = true;
          events.push({ stage: 'released', handleId, fd: file.fd });
          fs.writeFileSync(process.env.REA_TEST_CLOSE_EVENTS, JSON.stringify(events));
        }
      };
      return file;
    };
    syncBuiltinESMExports();
  `,
    );
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
      environment: {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        REA_TEST_SELECTED_FILE: path,
        REA_TEST_CLOSE_EVENTS: marker,
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.json).toHaveProperty("code");
    expect(result.json).not.toMatchObject({ code: "cleanup_incomplete" });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
      { stage: "opened", handleId: 0 },
      { stage: "denied", handleId: 0, open: true },
      { stage: "released", handleId: 0, fd: -1 },
    ]);
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  },
);

cliTest(
  "keeps Rust evidence independent of Go section errors through public CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-go-section-");
    const { client, call } = await connectLocalToolsMcp();
    const bytes = createRustImageWithGoSection("elf", "zero-address");
    const path = join(root, "mixed.elf");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result).toMatchObject({
      artifact: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      format: "elf",
      auditable_metadata: {
        file_offset: 1024,
        root_package_index: 1,
        packages: [
          { name: "itoa", version: "1.0.18" },
          { name: "sample", version: "0.1.0", root: true },
        ],
        dependency_edges: [{ from_index: 1, to_index: 0 }],
      },
      rustc_commit: {
        evidence_kind: "inferred",
        hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
      },
    });
    const response = await call("inspect_rust_binary", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expectCliMcpEvidenceParity(evidence, response.structuredContent, path);
    const go = await cli.run({
      arguments: ["inspect-go-binary", path, "--json"],
    });
    expect(go.exitCode).toBe(1);
    const goFailure = {
      code: "unsupported_target",
      details: {
        operation: "inspect_go_binary",
        failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
        reason: expect.stringContaining(
          "Virtual address or string range is not file mapped",
        ),
      },
    };
    expect(go.json).toMatchObject(goFailure);
    const goResponse = await call("inspect_go_binary", { path });
    expect(parseMcpToolError(goResponse).error).toMatchObject(goFailure);
    await client.ping();
  },
);

cliTest(
  "reports and recovers the recorded compiler-path control without losing dependency facts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-controls-");
    const path = join(root, "overflow.elf");
    await writeFile(path, createRustHashOverflowImage());
    const inspect = async (options: string[] = []) => {
      const result = await cli.run({
        arguments: [
          "inspect-rust-binary",
          path,
          "--full-output",
          ...options,
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const envelope = result.json as {
        data: unknown;
        meta: { cli_controls?: unknown };
      };
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        envelope.data,
      );
      return {
        envelope,
        evidence,
        report: rustBinarySchema.parse(evidence.normalized_result),
      };
    };
    const initial = await inspect();
    expect(initial.report.rustc_commit?.hashes).toHaveLength(64);
    expect(initial.report.rustc_commit?.coverage?.limit).toMatchObject({
      parameter: "max_rustc_hashes",
      effective_value: 64,
    });
    expect(initial.envelope.meta.cli_controls).toEqual({
      max_rustc_hashes: "--max-rustc-hashes",
    });

    const selected = await inspect([
      "--max-rustc-hashes",
      "65",
      "--producer-limits",
      '{"input_bytes":8192,"output_bytes":16384}',
    ]);
    expect(selected.evidence.parameters).toMatchObject({
      max_rustc_hashes: 65,
      producer_limits: { input_bytes: 8192, output_bytes: 16384 },
    });
    expect(selected.report.rustc_commit?.hashes).toHaveLength(65);
    expect(selected.report.rustc_commit?.hashes.slice(0, 64)).toEqual(
      initial.report.rustc_commit?.hashes,
    );
    expect(selected.report.rustc_commit).not.toHaveProperty("coverage");
    expect(selected.envelope.meta.cli_controls).toBeUndefined();
    expect(initial.report.auditable_metadata?.packages).toHaveLength(2);
    expect(selected.report.auditable_metadata).toEqual(
      initial.report.auditable_metadata,
    );
  },
);
