import { unknownTarget } from "../../src/domain/targetIdentity.js";
import { expect, it } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { gpuCodeObjectsSchema } from "../../src/domain/gpu/gpuCodeObjects.js";
import {
  gpuCodeObjectsPageViewResultSchema,
  gpuCodeObjectsSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence, createEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { lazyLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";
import {
  cudaFixture,
  peGpuFixture,
  ccobFixture,
  ptxFixture,
  amdFixture,
  amdDescriptorNoteFixture,
  amdNoteFixture,
  cubinFixture,
  hipFixture,
  elfFixture,
  llvmBitcodeFixture,
} from "../fixtures/gpu/codeObjects.js";

const connectLocalToolsMcp = lazyLocalToolsMcp();

cliTest(
  "reads CUDA/PTX and compressed HIP through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gpu-cli-");
    for (const [name, bytes] of [
      ["cuda", cudaFixture("zstd")],
      ["hip", ccobFixture()],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          "kernels",
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(report.kernels).toHaveLength(name === "cuda" ? 2 : 1);
      expect(report.kernels[0]!.parameter_bytes).toBe(12);
      expect(report.coverage.payloads).toBe("complete");
    }
  },
);

cliTest(
  "reports the AMD metadata nesting allowance while retaining a preceding kernel",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-amdgpu-metadata-depth-");
    const path = join(root, "amdgpu");
    // A one-entry map whose value is 32 nested single-element MessagePack arrays.
    const metadata = Buffer.from([
      0x81,
      0xa1,
      0x78,
      ...Array<number>(32).fill(0x91),
      0,
    ]);
    await writeFile(
      path,
      amdFixture(false, amdDescriptorNoteFixture(metadata)),
    );
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const report = gpuCodeObjectsSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(report.objects[0]).toMatchObject({
      inspection: "capacity",
      limitations: expect.arrayContaining([
        "AMDGPU metadata exceeds its 32-level nesting allowance",
      ]),
      amd_target_metadata: {
        note_coverage: "partial",
        notes: [expect.any(Object)],
      },
    });
    expect(report.kernels.map(({ name }) => name)).toEqual(["add_one"]);
  },
);

cliTest(
  "inventories a complete CCOB stream containing ordinary CCOB payload text",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ccob-embedded-marker-");
    const bundle = hipFixture(
        Buffer.from("ordinary CCOB marker"),
        "host-other",
      ),
      compressed = deflateSync(bundle, { level: 0 });
    expect(compressed.indexOf("CCOB")).toBeGreaterThan(0);
    for (const version of [1, 2] as const) {
      const width = version === 1 ? 20 : 24,
        header = Buffer.from(
          ccobFixture(version, "zlib", bundle).subarray(0, width),
        );
      if (version === 2) header.writeUInt32LE(width + compressed.length, 8);
      const bytes = Buffer.concat([header, compressed]),
        path = join(root, `v${version}`);
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          "inventory",
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      expect(report.coverage).toMatchObject({
        discovery: "complete",
        payloads: "not-requested",
      });
      expect(report.objects).toHaveLength(3);
      expect(report.objects[0]).toMatchObject({
        kind: "hip-bundle",
        inspection: "complete",
        encoded_size: compressed.length,
        decoded_size: bundle.length,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        location: { offset: width, size: compressed.length },
      });
      expect(
        report.objects
          .slice(1)
          .map(({ bundle_id, inspection }) => [bundle_id, inspection]),
      ).toEqual([
        ["host-x86_64-unknown-linux", "complete"],
        ["host-other", "complete"],
      ]);
    }
  },
);

cliTest(
  "distinguishes unsupported HIP bitcode from corrupted ELF through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-hip-bitcode-cli-"),
      bitcode = llvmBitcodeFixture(),
      corruptedElf = amdFixture(),
      bundleId = "hip-amdgcn-amd-amdhsa--gfx900";
    corruptedElf.writeBigUInt64LE(BigInt(corruptedElf.length + 1), 40);
    for (const [name, payload, analysis, inspection] of [
      ["inventory", bitcode, "inventory", "inventory"],
      ["bitcode", bitcode, "kernels", "unsupported"],
      ["corrupt-elf", corruptedElf, "kernels", "malformed"],
    ] as const) {
      const bytes = hipFixture(payload, bundleId),
        path = join(root, name);
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          analysis,
          "--targets",
          '["gfx900"]',
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      const row = report.objects.find(({ kind }) => kind === "amdgpu")!;
      expect(row).toMatchObject({
        bundle_id: bundleId,
        target: "gfx900",
        payload_target: null,
        inspection,
        encoded_size: payload.length,
        location: {
          container_id: null,
          offset: bytes.length - payload.length,
          size: payload.length,
        },
        sha256:
          analysis === "inventory"
            ? null
            : createHash("sha256").update(payload).digest("hex"),
      });
      expect(report.coverage.payloads).toBe(
        analysis === "inventory" ? "not-requested" : "partial",
      );
      expect(report.kernels).toEqual([]);
      if (name === "bitcode") {
        expect(row.limitations.join(" ")).toContain("LLVM bitcode");
        expect(row.limitations.join(" ")).toContain(
          "validity and inner target were not inspected",
        );
      }
    }
    const path = join(root, "raw-bitcode");
    await writeFile(path, bitcode);
    const raw = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--json",
      ],
    });
    expect(raw.exitCode).toBe(1);
    expect(raw.json).toMatchObject({ code: "unsupported_target" });
  },
);

cliTest(
  "keeps embedded Clang bundle reads inside their native section",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gpu-section-range-");
    const magic = Buffer.from("__CLANG_OFFLOAD_BUNDLE__"),
      truncated = magic,
      complete = Buffer.concat([magic, Buffer.alloc(8)]);
    const cases = [
      ["truncated-zero-neighbor", truncated, Buffer.alloc(8)],
      [
        "truncated-one-neighbor",
        truncated,
        Buffer.from([1, ...Array(7).fill(0)]),
      ],
      ["complete", complete, Buffer.alloc(8)],
    ] as const;
    const reports = [];
    for (const [name, bundle, adjacent] of cases) {
      const bytes = elfFixture(62, [
          { name: ".hip_fatbin", bytes: bundle },
          { name: ".data", bytes: adjacent },
        ]),
        path = join(root, name);
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          "kernels",
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      reports.push(report);
    }
    const [zeroNeighbor, oneNeighbor, completeReport] = reports;
    expect(zeroNeighbor!.coverage).toMatchObject({
      discovery: "partial",
      payloads: "partial",
    });
    expect(oneNeighbor!.coverage).toMatchObject({
      discovery: "partial",
      payloads: "partial",
    });
    expect(zeroNeighbor!.objects[0]).toMatchObject({
      kind: "native-section",
      inspection: "malformed",
      location: { size: 24, section_name: ".hip_fatbin" },
    });
    expect(oneNeighbor!.objects[0]).toMatchObject({
      kind: "native-section",
      inspection: "malformed",
      location: { size: 24, section_name: ".hip_fatbin" },
    });
    expect(completeReport!.coverage).toMatchObject({
      discovery: "complete",
      payloads: "complete",
    });
    expect(completeReport!.objects[0]).toMatchObject({
      kind: "native-section",
      inspection: "complete",
      location: { size: 32, section_name: ".hip_fatbin" },
    });
  },
);

cliTest(
  "compares equivalent PTX targets and retains family-specific CUDA targets",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gpu-target-spelling-");
    for (const [name, target, payloadTarget, ptx, flags] of [
      [
        "compute",
        "sm_80",
        "compute_80",
        ptxFixture.replace(".target sm_80", ".target compute_80"),
        0,
      ],
      [
        "family",
        "sm_100f",
        "sm_100f",
        ptxFixture.replace(".target sm_80", ".target sm_100f"),
        0x200000,
      ],
    ] as const) {
      const bytes = cudaFixture("none", [
          {
            kind: 1,
            target: name === "compute" ? 80 : 100,
            bytes: Buffer.from(ptx),
            flags,
          },
        ]),
        path = join(root, name);
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          "kernels",
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      expect(report.objects[0]).toMatchObject({
        target,
        payload_target: payloadTarget,
        target_consistency: "consistent",
      });
      expect(report.coverage.payloads).toBe("complete");
    }
  },
);

cliTest(
  "reads CUDA V2 parameter records through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cubin-v2-parameter-"),
      bytes = cudaFixture("none", [
        {
          kind: 2,
          target: 80,
          bytes: cubinFixture({ architecture: 80, v2ParameterSize: 20000 }),
        },
      ]),
      path = join(root, "large-parameter.cubin");
    await writeFile(path, bytes);
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        response.json,
      ),
    );
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    expect(report.kernels[0]).toMatchObject({
      parameter_count: 1,
      parameter_bytes: 20000,
      parameters: [{ ordinal: 0, offset: 0, size: 20000 }],
    });
    expect(report.coverage.payloads).toBe("complete");
  },
);

cliTest(
  "preserves HIP v3 feature target IDs for exact selection",
  async ({ cli }) => {
    const target = "amdgcn-amd-amdhsa--gfx906+xnack",
      root = await createTestTempDirectory("rea-hip-v3-target-id-"),
      payload = amdFixture(false, undefined, target);
    payload.writeUInt32LE(0x2f, 48); // EF_AMDGPU_MACH_AMDGCN_GFX906
    const excludedTarget = "amdgcn-amd-amdhsa--gfx906";
    const excluded = amdFixture(false, undefined, excludedTarget);
    excluded.writeUInt32LE(0x2f, 48);
    const bytes = hipFixture(payload, `hip-${target}`, [
        { id: `hip-${excludedTarget}`, bytes: excluded },
      ]),
      path = join(root, "feature.bundle");
    await writeFile(path, bytes);
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--targets",
        JSON.stringify(["gfx906+xnack"]),
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        response.json,
      ),
    );
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    const candidates = report.objects.filter(({ kind }) => kind === "amdgpu");
    expect(candidates).toMatchObject([
      {
        bundle_id: `hip-${target}`,
        target: "gfx906+xnack",
        inspection: "complete",
      },
      {
        bundle_id: `hip-${excludedTarget}`,
        target: "gfx906",
        inspection: "not-selected",
      },
    ]);
    expect(report.kernels).toMatchObject([
      { object_id: candidates[0]?.id, name: "add_one" },
    ]);
    expect(report.coverage.payloads).toBe("partial");
  },
);

cliTest(
  "preserves PTX targets, entry names, layout and real register declarations",
  async ({ cli }) => {
    const source = ptxFixture
        .replace(".target sm_80", ".target compute_80")
        .replace(".entry add_one", ".entry %add_one")
        .replace(".u64 output", ".u64 .ptr .global output")
        .replace(
          ".u32 value",
          ".u64 .ptr .global .align 4 ptr_arg, .param .u64 .ptr .align 1 increment_param_0, .param .u64 .ptr.global.align 4 joined_arg, .param .u64 .ptr .global.align 16 partly_joined_arg, .param .u64 .ptr.global .align 16 joined_space_arg, .param .b8 .align 8 payload[8], .param .u32 value",
        )
        .replace(".reg .b32", ".reg.b32")
        .replace(
          ".reg .b64 %rd<5>;",
          ".reg .b64 %rd<5>; F: .callprototype _ (.reg.b32 _);",
        ),
      root = await createTestTempDirectory("rea-ptx-callprototype-"),
      path = join(root, "prototype.ptx");
    await writeFile(path, source);
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        response.json,
      ),
    );
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    expect(report.objects[0]).toMatchObject({
      target: "compute_80",
      inspection: "complete",
    });
    expect(report.kernels).toHaveLength(1);
    expect(report.kernels[0]).toMatchObject({
      name: "%add_one",
      parameter_count: 8,
      parameter_bytes: 60,
      parameters: [
        { name: "output", offset: 0, size: 8 },
        { name: "ptr_arg", offset: 8, size: 8 },
        { name: "increment_param_0", offset: 16, size: 8 },
        { name: "joined_arg", offset: 24, size: 8 },
        { name: "partly_joined_arg", offset: 32, size: 8 },
        { name: "joined_space_arg", offset: 40, size: 8 },
        { name: "payload", offset: 48, size: 8 },
        { ordinal: 7, name: "value", offset: 56, size: 4, type: ".u32" },
      ],
      registers: {
        virtual: [
          { type: ".b32", count: 9 },
          { type: ".b64", count: 5 },
        ],
      },
    });
    expect(report.coverage.payloads).toBe("complete");
    expect(report.ptx_artifacts).toMatchObject([
      {
        text: source,
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ]);
  },
);

cliTest(
  "resolves CUBIN SHN_XINDEX symbols through their ELF extension table",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cubin-shndx-cli-");
    const bytes = cubinFixture({ extendedSectionIndex: true });
    const path = join(root, "extended.cubin");
    await writeFile(path, bytes);
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        response.json,
      ),
    );
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(report.artifact.sha256).toBe(sha256);
    expect(report.objects[0]!.sha256).toBe(sha256);
    expect(report.kernels).toHaveLength(1);
    expect(report.kernels[0]).toMatchObject({
      name: "add_one",
      parameter_count: 2,
      parameter_bytes: 12,
      shared_bytes: 1056,
      sources: {
        parameters: expect.objectContaining({ section_index: 65537 }),
        shared: expect.objectContaining({ section_index: 65538 }),
      },
    });

    const malformedBytes = Buffer.from(bytes);
    const sectionTable = Number(malformedBytes.readBigUInt64LE(40));
    const sectionCount = Number(
      malformedBytes.readBigUInt64LE(sectionTable + 32),
    );
    let indexTable: number | undefined;
    for (let index = 0; index < sectionCount; index++)
      if (malformedBytes.readUInt32LE(sectionTable + index * 64 + 4) === 18) {
        indexTable = index;
        break;
      }
    expect(indexTable).toBeDefined();
    malformedBytes.writeBigUInt64LE(4n, sectionTable + indexTable! * 64 + 32);
    const malformedPath = join(root, "short-shndx.cubin");
    await writeFile(malformedPath, malformedBytes);
    const malformed = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        malformedPath,
        "--analysis",
        "kernels",
        "--json",
      ],
    });
    expect(malformed.exitCode, malformed.stderr).toBe(0);
    const malformedEvidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        malformed.json,
      ),
    );
    const malformedReport = gpuCodeObjectsSchema.parse(
      malformedEvidence.normalized_result,
    );
    expect(malformedReport.objects[0]!.inspection).toBe("malformed");
    expect(malformedReport.coverage.payloads).toBe("partial");
  },
);

cliTest(
  "keeps entry-scoped PTX pragmas outside the body boundary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ptx-entry-pragma-");
    const preamble = ".version 8.8\n.target sm_80\n.address_size 64\n",
      body = "{ .reg .b32 %r<3>; .shared .align 4 .b8 scratch[16]; ret; }",
      declarations = [
        ["plain", `.visible .entry k(.param .u32 input) ${body}`],
        [
          "entry-pragma",
          `.visible .entry k(.param .u32 input) .pragma "nounroll"; ${body}`,
        ],
        [
          "body-pragma",
          `.visible .entry k(.param .u32 input) { .pragma "nounroll"; .reg .b32 %r<3>; .shared .align 4 .b8 scratch[16]; ret; }`,
        ],
      ] as const;
    const reports = new Map();
    for (const [name, declaration] of declarations) {
      const text = `${preamble}${declaration}\n`,
        path = join(root, `${name}.ptx`);
      await writeFile(path, text);
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          path,
          "--analysis",
          "kernels",
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const evidence = parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          response.json,
        ),
      );
      const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
      expect(report.ptx_artifacts[0]!.sha256).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
      reports.set(name, report);
    }
    const expected = {
      name: "k",
      parameter_count: 1,
      parameter_bytes: 4,
      registers: { virtual: [{ type: ".b32", count: 3 }] },
      shared_bytes: 16,
    };
    for (const [name, report] of reports) {
      expect(report.kernels[0]).toMatchObject(expected);
      expect(report.coverage.payloads).toBe("complete");
      const declaration = declarations.find(
        ([caseName]) => caseName === name,
      )![1];
      expect(report.kernels[0]!.location.size).toBe(
        Buffer.byteLength(declaration.slice(declaration.indexOf(".entry"))),
      );
    }
  },
);

cliTest(
  "extracts entry parameters declared in PTX 1.3 bodies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ptx-legacy-cli-");
    const text = `.version 1.3\n.target sm_80\n.address_size 64\n.entry kernel {\n.param .u32 input;\nret;\n}\n`;
    const path = join(root, "legacy.ptx");
    await writeFile(path, text);
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        response.json,
      ),
    );
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    expect(report.kernels).toEqual([
      expect.objectContaining({
        name: "kernel",
        parameter_count: 1,
        parameter_bytes: 4,
        parameters: [
          expect.objectContaining({
            ordinal: 0,
            name: "input",
            offset: 0,
            size: 4,
            type: ".u32",
          }),
        ],
      }),
    ]);
    const malformedPath = join(root, "truncated.ptx");
    await writeFile(
      malformedPath,
      `.version 1.3\n.target sm_80\n.entry kernel {\n.param .u32 input\n`,
    );
    const malformed = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        malformedPath,
        "--analysis",
        "kernels",
        "--json",
      ],
    });
    expect(malformed.exitCode, malformed.stderr).toBe(0);
    const malformedEvidence = parseEvidence(
      toolContract("inspect_gpu_code_objects").outputSchema.parse(
        malformed.json,
      ),
    );
    const malformedReport = gpuCodeObjectsSchema.parse(
      malformedEvidence.normalized_result,
    );
    expect(malformedReport.objects[0]!.inspection).toBe("malformed");
    expect(malformedReport.coverage.payloads).toBe("partial");
  },
);

cliTest(
  "attributes malformed selector JSON to its actual CLI option",
  async ({ cli }) => {
    for (const name of ["object_ids", "targets", "view"]) {
      const response = await cli.run({
        arguments: [
          "inspect-gpu-code-objects",
          "/not-opened-for-invalid-selectors",
          `--${name}`,
          "[",
          "--json",
        ],
      });
      expect(response.exitCode).not.toBe(0);
      expect(response.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_gpu_code_objects",
          issues: [
            {
              path: [name],
              reason: "invalid_format",
              message: `${name} must be valid JSON`,
            },
          ],
        },
      });
    }
  },
);

cliTest(
  "publishes and enforces the lowercase --expected_sha256 digest",
  async ({ cli }) => {
    const schema = await cli.run({
      arguments: ["inspect-gpu-code-objects", "--schema", "--json"],
    });
    expect(schema.exitCode, schema.stderr).toBe(0);
    expect(schema.json).toMatchObject({
      options: {
        properties: { expected_sha256: { pattern: "^[a-f0-9]{64}$" } },
      },
    });
    // PowerShell's Get-FileHash prints the digest in upper case.
    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        "/not-opened-for-invalid-selectors",
        "--expected_sha256",
        "AB".repeat(32),
        "--json",
      ],
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [expect.objectContaining({ path: "expected_sha256" })],
    });
  },
);

it("preserves incomplete decoder coverage through MCP target and object pages", async () => {
  const root = await createTestTempDirectory("rea-gpu-partial-"),
    { call } = await connectLocalToolsMcp();
  const cases = {
    "section-names": () => {
      const bytes = cubinFixture();
      bytes.writeUInt16LE(0, 62);
      return bytes;
    },
    symbols: () => {
      const bytes = cubinFixture();
      bytes.writeUInt32LE(1, Number(bytes.readBigUInt64LE(40)) + 3 * 64 + 4);
      return bytes;
    },
    "later-amd-note": () => amdFixture(false, Buffer.alloc(3)),
    "modern-amd-target-conflict": () =>
      hipFixture(
        amdFixture(false, undefined, "amdgpu9.00-amd-amdhsa--gfx900"),
        "hipv4-amdgpu11.00-amd-amdhsa--gfx1100",
      ),
    "target-conflict": () =>
      cudaFixture("none", [
        {
          kind: 2,
          target: 80,
          bytes: cubinFixture({ architecture: 90 }),
        },
      ]),
    "register-conflict": () => cubinFixture({ textRegisters: 11 }),
    "ptx-parameter": () =>
      Buffer.from(ptxFixture.replace(".u64 output", ".u64 .vendor output")),
    "ptx-shared": () =>
      Buffer.from(ptxFixture.replace("scratch[32]", "scratch[]")),
  };
  for (const [missing, fixture] of Object.entries(cases)) {
    const bytes = fixture(),
      path = join(root, missing);
    await writeFile(path, bytes);
    const reply = await call("inspect_gpu_code_objects", {
      path,
      analysis: "kernels",
      view: { collection: "targets" },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const targets = gpuCodeObjectsPageViewResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    expect(targets.source_coverage.payloads).toBe("partial");
    expect(targets.items).toEqual([
      expect.objectContaining({
        target:
          missing === "later-amd-note"
            ? "amdgcn-amd-amdhsa--gfx900"
            : missing === "modern-amd-target-conflict"
              ? "gfx1100"
              : "sm_80",
        kernel_count: missing === "symbols" ? 0 : 1,
        kernel_coverage: "partial",
      }),
    ]);
    const objectReply = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: targets.parent_evidence_id,
      },
      view: {
        kind: "gpu-code-objects",
        collection: "objects",
        fields: ["kind"],
      },
    });
    expect(objectReply.isError, JSON.stringify(objectReply)).not.toBe(true);
    const objects = gpuCodeObjectsPageViewResultSchema.parse(
      parseEvidence(objectReply.structuredContent).normalized_result,
    );
    expect(objects.items).toEqual([
      ...(missing === "modern-amd-target-conflict"
        ? [expect.objectContaining({ kind: "host", inspection: "complete" })]
        : []),
      expect.objectContaining({
        inspection: missing === "later-amd-note" ? "malformed" : "partial",
      }),
    ]);
    if (missing === "target-conflict")
      expect(objects.items[0]).toMatchObject({
        target: "sm_80",
        payload_target: "sm_90",
        target_consistency: "conflict",
      });
    if (missing === "modern-amd-target-conflict")
      expect(objects.items[1]).toMatchObject({
        kind: "amdgpu",
        target: "gfx1100",
        payload_target: "amdgpu9.00-amd-amdhsa--gfx900",
        target_consistency: "conflict",
      });
  }
});

it("keeps unknown target discovery visible in the default MCP summary", async () => {
  const root = await createTestTempDirectory("rea-gpu-unknown-target-"),
    path = join(root, "cuda");
  await writeFile(path, cubinFixture({ osAbi: 0x41, flags: 0x06016402 }));
  const { call } = await connectLocalToolsMcp();
  const reply = await call("inspect_gpu_code_objects", { path });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const result = gpuCodeObjectsSummaryViewResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(result.summary.coverage.discovery).toBe("partial");
  expect(result.summary.counts).toMatchObject({ objects: 1, targets: 0 });
  const detailedReply = await call("inspect_gpu_code_objects", {
    path,
    analysis: "kernels",
    view: { collection: "objects" },
  });
  expect(detailedReply.isError, JSON.stringify(detailedReply)).not.toBe(true);
  const detailed = gpuCodeObjectsPageViewResultSchema.parse(
    parseEvidence(detailedReply.structuredContent).normalized_result,
  );
  expect(detailed.items).toHaveLength(1);
  const source = {
    kind: "retained-evidence",
    evidence_id: detailed.parent_evidence_id,
  } as const;
  for (const collection of ["objects", "targets", "kernels"] as const) {
    const filteredReply = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "gpu-code-objects",
        collection,
        targets: [""],
      },
    });
    expect(filteredReply.isError, JSON.stringify(filteredReply)).not.toBe(true);
    const filtered = gpuCodeObjectsPageViewResultSchema.parse(
      parseEvidence(filteredReply.structuredContent).normalized_result,
    );
    expect(filtered.items).toEqual([]);
  }
});

it("retains selected kernel facts and complete PTX for historical MCP pages after source removal", async () => {
  const root = await createTestTempDirectory("rea-gpu-mcp-"),
    path = join(root, "application");
  await writeFile(path, cudaFixture("zstd"));
  const { call } = await connectLocalToolsMcp();
  const inventoryReply = await call("inspect_gpu_code_objects", {
    path,
    view: { collection: "objects", fields: ["kind", "target"] },
  });
  expect(inventoryReply.isError, JSON.stringify(inventoryReply)).not.toBe(true);
  const inventory = gpuCodeObjectsPageViewResultSchema.parse(
    parseEvidence(inventoryReply.structuredContent).normalized_result,
  );
  expect(inventory.items).toHaveLength(2);
  expect(inventory.items[0]).not.toHaveProperty("sha256");
  expect(inventory.items[0]).toHaveProperty("metadata_location");
  const targetsReply = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: inventory.parent_evidence_id,
    },
    view: { kind: "gpu-code-objects", collection: "targets" },
  });
  expect(targetsReply.isError, JSON.stringify(targetsReply)).not.toBe(true);
  const targets = gpuCodeObjectsPageViewResultSchema.parse(
    parseEvidence(targetsReply.structuredContent).normalized_result,
  );
  expect(targets.items).toHaveLength(2);
  expect(targets.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: "sm_80",
        object_count: 1,
        kernel_count: 0,
        kernel_coverage: "not-requested",
      }),
      expect.objectContaining({
        target: "sm_90",
        object_count: 1,
        kernel_count: 0,
        kernel_coverage: "not-requested",
      }),
    ]),
  );
  const inspectedReply = await call("inspect_gpu_code_objects", {
    path,
    analysis: "kernels",
    view: {
      collection: "kernels",
      names: ["add_one"],
      fields: ["parameter_count", "registers"],
    },
  });
  expect(inspectedReply.isError, JSON.stringify(inspectedReply)).not.toBe(true);
  const inspected = gpuCodeObjectsPageViewResultSchema.parse(
    parseEvidence(inspectedReply.structuredContent).normalized_result,
  );
  expect(inspected.items).toHaveLength(2);
  expect(inspected.items[0]).not.toHaveProperty("parameters");
  expect(inspected.items[0]).toHaveProperty("sources");
  const objectId =
    "object_id" in inspected.items[0]!
      ? inspected.items[0]!.object_id
      : undefined;
  expect(objectId).toBeTypeOf("string");
  await unlink(path);
  const source = {
    kind: "retained-evidence",
    evidence_id: inspected.parent_evidence_id,
  };
  const textReply = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "gpu-code-objects",
      collection: "ptx",
      object_id: objectId,
      offset: 0,
      limit: 4096,
    },
  });
  expect(textReply.isError, JSON.stringify(textReply)).not.toBe(true);
  const text = gpuCodeObjectsPageViewResultSchema.parse(
    parseEvidence(textReply.structuredContent).normalized_result,
  );
  expect(text.ptx!.text).toBe(ptxFixture);
  expect(text.ptx!.sha256).toBe(
    createHash("sha256").update(ptxFixture).digest("hex"),
  );
  const summaryReply = await call("inspect_analysis_view", {
    source,
    view: { kind: "summary" },
  });
  expect(summaryReply.isError, JSON.stringify(summaryReply)).not.toBe(true);
  const summary = gpuCodeObjectsSummaryViewResultSchema.parse(
    parseEvidence(summaryReply.structuredContent).normalized_result,
  );
  expect(summary.summary.counts).toMatchObject({
    objects: 2,
    kernels: 2,
    ptx_artifacts: 1,
  });
  expect(summary.summary).not.toHaveProperty("ptx_artifacts");
});

it("rejects forged duplicate object IDs and mismatched Evidence subjects through MCP", async () => {
  const root = await createTestTempDirectory("rea-gpu-import-"),
    path = join(root, "cuda");
  await writeFile(path, cudaFixture());
  const { call } = await connectLocalToolsMcp();
  const reply = await call("inspect_gpu_code_objects", {
    path,
    analysis: "kernels",
    detail: "complete",
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const parent = parseEvidence(reply.structuredContent),
    report = gpuCodeObjectsSchema.parse(parent.normalized_result);
  const forgedHeaderReport = gpuCodeObjectsSchema.parse(
    parent.normalized_result,
  );
  forgedHeaderReport.objects[1]!.cuda_target_header!.location.container_id =
    forgedHeaderReport.objects[0]!.id;
  const forgedHeader = createEvidence(
    unknownTarget("not-observed"),
    parent.provider,
    {
      operation: parent.operation,
      parameters: parent.parameters,
      result: forgedHeaderReport,
    },
  );
  expect(
    parseMcpToolError(
      await call("inspect_analysis_view", {
        source: { kind: "inline", evidence: forgedHeader },
        view: { kind: "gpu-code-objects", collection: "objects" },
      }),
    ).error,
  ).toMatchObject({ code: "invalid_request" });
  report.objects[1]!.id = report.objects[0]!.id;
  const forged = createEvidence(
    unknownTarget("not-observed"),
    parent.provider,
    {
      operation: "inspect_gpu_code_objects",
      parameters: parent.parameters,
      result: report,
    },
  );
  const failure = parseMcpToolError(
    await call("inspect_analysis_view", {
      source: { kind: "inline", evidence: forged },
      view: { kind: "gpu-code-objects", collection: "objects" },
    }),
  );
  expect(failure.error).toMatchObject({ code: "invalid_request" });
  const mismatched = createEvidence(
    { path: join(root, "other-file"), sha256: "f".repeat(64), format: "file" },
    parent.provider,
    {
      operation: parent.operation,
      parameters: parent.parameters,
      result: parent.normalized_result,
    },
  );
  const identityFailure = parseMcpToolError(
    await call("inspect_analysis_view", {
      source: { kind: "inline", evidence: mismatched },
      view: { kind: "summary" },
    }),
  );
  expect(identityFailure.error).toMatchObject({ code: "invalid_request" });
});

cliTest(
  "uses DOS relocation ownership before GPU section discovery through the CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-gpu-dos-relocations-cli-");
    const path = join(root, "selected.exe");
    const bytes = peGpuFixture();
    bytes.writeUInt16LE(bytes.length % 512, 2);
    bytes.writeUInt16LE(Math.ceil(bytes.length / 512), 4);
    bytes.writeUInt16LE(2, 8);
    await writeFile(path, bytes);
    const args = [
      "inspect-gpu-code-objects",
      path,
      "--analysis",
      "inventory",
      "--json",
    ];
    const valid = await cli.run({ arguments: args });
    expect(valid.exitCode, valid.stderr).toBe(0);
    bytes.writeUInt16LE(1, 6);
    bytes.writeUInt16LE(4, 8);
    bytes.writeUInt16LE(60, 24);
    await writeFile(path, bytes);
    const refused = await cli.run({ arguments: args });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      details: {
        operation: "inspect_gpu_code_objects",
        format_failure: "malformed",
        reason: expect.stringContaining(
          "MZ header does not declare a PE image",
        ),
      },
    });
  },
);

cliTest(
  "delivers retained AMD note Evidence through a truncated tail over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-amd-target-sources-");
    const path = join(root, "amdgpu");
    const note = amdNoteFixture();
    const bytes = amdFixture(false, Buffer.concat([note, Buffer.alloc(3)]));
    await writeFile(path, bytes);

    const response = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        path,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(response.json);
    const report = gpuCodeObjectsSchema.parse(evidence.normalized_result);
    const target = "amdgcn-amd-amdhsa--gfx900";
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const row = report.objects[0]!;
    const first = bytes.indexOf(note);
    expect(first).toBeGreaterThan(64);
    expect(row).toMatchObject({
      target,
      payload_target: target,
      inspection: "malformed",
      amd_target_metadata: {
        flags: "0x0000012c",
        processor: "gfx900",
        header_location: { container_id: row.id, offset: 0, size: 64 },
        note_coverage: "partial",
        notes: [first, first + note.length].map((offset) => ({
          target,
          target_state: "declared",
          location: {
            container_id: row.id,
            section_index: 2,
            section_name: ".note",
            offset: offset + 20,
            size: note.readUInt32LE(4),
          },
        })),
      },
    });
    expect(
      report.kernels.map(({ name, object_id }) => [name, object_id]),
    ).toEqual([
      ["add_one", row.id],
      ["add_one", row.id],
    ]);
    expect(report.coverage.payloads).toBe("partial");

    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_gpu_code_objects", {
      path,
      analysis: "kernels",
      detail: "complete",
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const mcp = parseEvidence(reply.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(report);
    for (const fields of [["amd_target_metadata"], ["kind"]] as const) {
      const projected = await call("inspect_analysis_view", {
        source: { kind: "retained-evidence", evidence_id: mcp.evidence_id },
        view: { kind: "gpu-code-objects", collection: "objects", fields },
      });
      expect(projected.isError, JSON.stringify(projected)).not.toBe(true);
      const { items } = gpuCodeObjectsPageViewResultSchema.parse(
        parseEvidence(projected.structuredContent).normalized_result,
      );
      expect(items).toHaveLength(1);
      if (fields[0] === "amd_target_metadata")
        expect(items[0]).toHaveProperty(
          "amd_target_metadata",
          row.amd_target_metadata,
        );
      else expect(items[0]).not.toHaveProperty("amd_target_metadata");
    }
  },
);

it("does not interpret non-AMD ELF flags as AMD processor declarations through MCP", async () => {
  const root = await createTestTempDirectory("rea-amd-machine-");
  const path = join(root, "wrong-machine");
  const payload = amdFixture();
  payload.writeUInt16LE(62, 18);
  await writeFile(path, hipFixture(payload, "hip-amdgcn-amd-amdhsa--"));
  const { call } = await connectLocalToolsMcp();
  const reply = await call("inspect_gpu_code_objects", {
    path,
    analysis: "kernels",
    detail: "complete",
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const report = gpuCodeObjectsSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(report.objects.find(({ kind }) => kind === "amdgpu")).toMatchObject({
    target: null,
    payload_target: null,
    amd_target_metadata: null,
    target_consistency: "unknown",
    inspection: "malformed",
  });
  expect(report.kernels).toEqual([]);
  expect(report.coverage.payloads).toBe("partial");
});

cliTest(
  "reports partial coverage and clears provenance for conflicting CUDA shared-memory and register declarations",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cuda-resource-conflict-");
    const name = "add_one";
    const symbols = Buffer.alloc(48);
    symbols.writeUInt32LE(1, 24);
    symbols[28] = 0x12;
    symbols[29] = 0x10;
    symbols.writeUInt16LE(4, 30);
    symbols.writeBigUInt64LE(16n, 40);
    const info = Buffer.from(
      "03190c0004170c00000000000100080000f0110004170c00000000000000000000f02100",
      "hex",
    );
    const regRecord = (value: number): Buffer => {
      const record = Buffer.from("042f08000100000000000000", "hex");
      record.writeUInt32LE(value, 8);
      return record;
    };
    const dupSharedCubin = elfFixture(
      190,
      [
        { name: ".strtab", type: 3, bytes: Buffer.from(`\0${name}\0`) },
        { name: ".symtab", type: 2, link: 2, entrySize: 24, bytes: symbols },
        {
          name: `.text.${name}`,
          flags: 0x100006n,
          info: 1,
          bytes: Buffer.alloc(16),
        },
        { name: ".nv.info", type: 0x70000000, link: 3, bytes: regRecord(10) },
        {
          name: `.nv.info.${name}`,
          type: 0x70000000,
          link: 3,
          info: 4,
          bytes: info,
        },
        { name: `.nv.shared.${name}`, type: 8, info: 4, size: 64 },
        { name: `.nv.shared.${name}.extra`, type: 8, info: 4, size: 128 },
      ],
      0x81,
    );
    const regConflictCubin = cubinFixture({
      globalRegisters: 10,
      textRegisters: 16,
      shared: 64,
    });

    const dupSharedPath = join(root, "dup-shared.cubin");
    await writeFile(dupSharedPath, dupSharedCubin);
    const dupSharedResult = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        dupSharedPath,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(dupSharedResult.exitCode, dupSharedResult.stderr).toBe(0);
    const dupSharedReport = gpuCodeObjectsSchema.parse(
      parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          dupSharedResult.json,
        ),
      ).normalized_result,
    );
    expect(dupSharedReport.objects[0]).toMatchObject({ inspection: "partial" });
    expect(dupSharedReport.coverage.payloads).toBe("partial");
    expect(dupSharedReport.kernels[0]).toMatchObject({
      name: "add_one",
      registers: { physical: 10 },
      shared_bytes: null,
      sources: { shared: null },
      limitations: expect.arrayContaining([
        "Conflicting CUDA shared memory declarations; shared byte count remains unknown",
      ]),
    });
    expect(dupSharedReport.kernels[0]?.sources.registers).not.toBeNull();

    const regConflictPath = join(root, "reg-conflict.cubin");
    await writeFile(regConflictPath, regConflictCubin);
    const regConflictResult = await cli.run({
      arguments: [
        "inspect-gpu-code-objects",
        regConflictPath,
        "--analysis",
        "kernels",
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(regConflictResult.exitCode, regConflictResult.stderr).toBe(0);
    const regConflictReport = gpuCodeObjectsSchema.parse(
      parseEvidence(
        toolContract("inspect_gpu_code_objects").outputSchema.parse(
          regConflictResult.json,
        ),
      ).normalized_result,
    );
    expect(regConflictReport.objects[0]).toMatchObject({
      inspection: "partial",
    });
    expect(regConflictReport.coverage.payloads).toBe("partial");
    expect(regConflictReport.kernels[0]).toMatchObject({
      name: "add_one",
      registers: { physical: null },
      shared_bytes: 64,
      sources: { registers: null },
      limitations: expect.arrayContaining([
        "Conflicting CUDA register declarations; physical count remains unknown",
      ]),
    });
    expect(regConflictReport.kernels[0]?.sources.shared).not.toBeNull();
  },
);
