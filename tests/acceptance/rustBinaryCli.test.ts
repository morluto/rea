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
  createUniversalRustMachoImage,
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
        format_failure: expect.stringMatching(/^(?:malformed|truncated)$/u),
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
        format_failure: expect.stringMatching(/^(?:malformed|truncated)$/u),
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

cliTest(
  "recovers opt-in Cargo crate and rustc banner fingerprints across ELF, PE, and thin Mach-O with CLI/MCP parity",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-inferred-");
    const { client, call } = await connectLocalToolsMcp();

    const rodataCrates = Buffer.from(
      [
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/codec/framed.rs",
        "/.cargo/registry/src/index.crates.io-6f17d22bba15001f/futures-channel-0.3.31/src/mpsc/mod.rs",
        "C:\\workspace\\.cargo\\registry\\src\\index.crates.io-6f17d22bba15001f\\x86_64-0.15.2\\src\\lib.rs",
        "\\cargo\\registry\\src\\github.com-1ecc6299db9ec823\\rand_chacha-0.3.1\\src\\guts.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.217-alpha.1/src/lib.rs",
        "/cargo/git/checkouts/quinn-0123456789abcdef/a1b2c3d/src/endpoint.rs",
        "rustc 1.84.0 (9fc6b4312 2025-01-07)",
      ].join("\0") + "\0",
      "latin1",
    );

    for (const format of ["elf", "pe", "macho"] as const) {
      const path = join(root, `stripped.${format}`);
      await writeFile(
        path,
        createRustImage({
          format,
          omitSection: true,
          readOnlyBytes: rodataCrates,
          ...(format === "elf"
            ? {
                elfComment: Buffer.from(
                  "\0rustc version 1.85.0 (4d91de4e4 2025-02-17)\0",
                  "latin1",
                ),
              }
            : {}),
        }),
      );

      const defaultCli = await cli.run({
        arguments: ["inspect-rust-binary", path, "--json"],
      });
      expect(defaultCli.exitCode, defaultCli.stderr).toBe(0);
      const defaultEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(defaultCli.json);
      expect(defaultEvidence.parameters).toEqual({ path });
      expect(defaultEvidence.normalized_result).not.toHaveProperty(
        "inferred_crates",
      );
      expect(defaultEvidence.normalized_result).not.toHaveProperty(
        "rustc_versions",
      );
      const defaultMcp = await call("inspect_rust_binary", { path });
      expect(defaultMcp.isError, JSON.stringify(defaultMcp)).not.toBe(true);
      expectCliMcpEvidenceParity(
        defaultEvidence,
        defaultMcp.structuredContent,
        path,
      );

      const optedCli = await cli.run({
        arguments: [
          "inspect-rust-binary",
          path,
          "--include-inferred-crates",
          "--json",
        ],
      });
      expect(optedCli.exitCode, optedCli.stderr).toBe(0);
      const optedEvidence = toolContract(
        "inspect_rust_binary",
      ).outputSchema.parse(optedCli.json);
      const report = rustBinarySchema.parse(optedEvidence.normalized_result);
      expect(
        report.inferred_crates?.items.map(({ name, version, source_kind }) => ({
          name,
          version,
          source_kind,
        })),
      ).toEqual([
        { name: "tokio-util", version: "0.7.13", source_kind: "registry" },
        {
          name: "futures-channel",
          version: "0.3.31",
          source_kind: "registry",
        },
        { name: "x86_64", version: "0.15.2", source_kind: "registry" },
        { name: "rand_chacha", version: "0.3.1", source_kind: "registry" },
        {
          name: "serde",
          version: "1.0.217-alpha.1",
          source_kind: "registry",
        },
        { name: "quinn", version: null, source_kind: "git" },
      ]);
      expect(report.rustc_versions?.items.map((item) => item.version)).toEqual(
        format === "elf" ? ["1.84.0", "1.85.0"] : ["1.84.0"],
      );
      const optedMcp = await call("inspect_rust_binary", {
        path,
        include_inferred_crates: true,
      });
      expect(optedMcp.isError, JSON.stringify(optedMcp)).not.toBe(true);
      expectCliMcpEvidenceParity(
        optedEvidence,
        optedMcp.structuredContent,
        path,
      );
    }

    await client.ping();
  },
);

cliTest(
  "rebases universal Mach-O slice offsets, supports compact inferred_crates views, and enforces option dependencies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-universal-");
    const { client, call } = await connectLocalToolsMcp();

    const universalPath = join(root, "universal.macho");
    await writeFile(
      universalPath,
      createUniversalRustMachoImage({
        x86_64ReadOnly: Buffer.from(
          "/cargo/registry/src/index.crates.io-6f17d22bba15001f/x86_only-1.0.0/src/lib.rs\0",
          "latin1",
        ),
        arm64ReadOnly: Buffer.from(
          "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/lib.rs\0rustc 1.85.0 (4d91de4e4 2025-02-17)\0",
          "latin1",
        ),
      }),
    );
    const universalCli = await cli.run({
      arguments: [
        "inspect-rust-binary",
        universalPath,
        "--architecture",
        "arm64",
        "--include-inferred-crates",
        "--json",
      ],
    });
    expect(universalCli.exitCode, universalCli.stderr).toBe(0);
    const universalEvidence = toolContract(
      "inspect_rust_binary",
    ).outputSchema.parse(universalCli.json);
    const universalReport = rustBinarySchema.parse(
      universalEvidence.normalized_result,
    );
    expect(universalReport.selected_slice).toMatchObject({
      kind: "macho-selected-image-v1",
      container: "fat",
      offset: 8192,
      byte_length: 4096,
      cpu_type: 0x0100000c,
    });
    expect(universalReport.inferred_crates?.items).toEqual([
      {
        name: "tokio-util",
        version: "0.7.13",
        source_kind: "registry",
        registry_index: "index.crates.io-6f17d22bba15001f",
        checkout_id: null,
        revision: null,
        first_file_offset: 8192 + 2049,
        reference_count: 1,
      },
    ]);
    expect(
      universalReport.rustc_versions?.items[0]?.first_file_offset,
    ).toBeGreaterThan(8192 + 2048);
    const universalMcp = await call("inspect_rust_binary", {
      path: universalPath,
      architecture: "arm64",
      include_inferred_crates: true,
    });
    expect(universalMcp.isError, JSON.stringify(universalMcp)).not.toBe(true);
    expectCliMcpEvidenceParity(
      universalEvidence,
      universalMcp.structuredContent,
      universalPath,
    );

    const elfPath = join(root, "stripped.elf");
    await writeFile(
      elfPath,
      createRustImage({
        format: "elf",
        omitSection: true,
        readOnlyBytes: Buffer.from(
          [
            "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/lib.rs",
            "/cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.217/src/lib.rs",
            "/cargo/registry/src/index.crates.io-6f17d22bba15001f/quinn-0.11.6/src/lib.rs",
          ].join("\0") + "\0",
          "latin1",
        ),
      }),
    );
    const bundleOutput = join(root, "truncated-bundle.json");
    const compactCli = await cli.run({
      arguments: [
        "inspect-rust-binary",
        elfPath,
        "--include-inferred-crates",
        "--max-inferred-crates",
        "2",
        "--view",
        '{"collection":"inferred_crates","contains":"tokio","fields":["name","version"]}',
        "--evidence_output",
        bundleOutput,
        "--json",
      ],
    });
    expect(compactCli.exitCode, compactCli.stderr).toBe(0);
    expect(compactCli.json).toMatchObject({
      summary: {
        normalized_result: {
          kind: "rust",
          source_coverage: { inferred_crates: "partial" },
          rust: {
            inferred_crates: {
              available_count: 2,
              discovered_count: 3,
              max_items: 2,
              truncated: true,
            },
          },
          page: {
            collection: "inferred_crates",
            rows: [{ index: 0, name: "tokio-util", version: "0.7.13" }],
          },
        },
      },
    });

    const missingFlag = await cli.run({
      arguments: [
        "inspect-rust-binary",
        join(root, "never-created"),
        "--max-inferred-crates",
        "5",
        "--json",
      ],
    });
    expect(missingFlag.exitCode).toBe(1);
    expect(missingFlag.json).toMatchObject({ code: "invalid_request" });
    expect(JSON.stringify(missingFlag.json)).not.toContain("ENOENT");

    await client.ping();
  },
);

cliTest(
  "rejects malformed Rust view JSON before opening the selected path",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-view-json-");
    const result = await cli.run({
      arguments: [
        "inspect-rust-binary",
        join(root, "missing"),
        "--view",
        "{",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "inspect_rust_binary",
        issues: [
          {
            path: ["view"],
            reason: "invalid_format",
            message:
              "view must be a JSON package, edge or inferred_crates selection",
          },
        ],
      },
    });
    expect(JSON.stringify(result.json)).not.toContain("ENOENT");
  },
);
