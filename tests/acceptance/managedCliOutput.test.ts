import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "managed CLI retains metadata and CIL after repeated local constructor owner lookups",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-row-lookup-");
    const path = join(root, "local-attributes.dll");
    await writeFile(
      path,
      buildManagedPeFixture({
        additionalEmptyTypes: 512,
        customAttributeRowCount: 512,
        customAttributeTypeRaw: (1 << 3) | 2,
        typeName: "LookupAttribute",
        extendsRaw: 0,
        methodName: ".ctor",
        methodFlags: 0x1886,
        methodSignature: Buffer.from([0x20, 0x01, 0x01, 0x0e]),
        ilBody: Buffer.from([0x06, 0x2a]),
      }),
    );
    const artifact = await cli.run({
      arguments: ["inspect-managed-artifact", path, "--json"],
    });
    expect(artifact.exitCode).toBe(0);
    expect(artifact.json).toMatchObject({
      normalized_result: {
        coverage: { state: "complete", issues: [] },
        attributes: expect.arrayContaining([
          expect.objectContaining({
            type_name: "Fixture.LookupAttribute",
            constructor_token: "0x06000001",
          }),
        ]),
      },
    });
    expect(artifact.json).toHaveProperty(
      "normalized_result.attributes.length",
      512,
    );
    const members = await cli.run({
      arguments: ["inspect-managed-members", path, "--json"],
    });
    expect(members.exitCode).toBe(0);
    expect(members.json).toMatchObject({
      normalized_result: {
        coverage: { state: "complete", issues: [] },
        types: expect.arrayContaining([
          expect.objectContaining({ full_name: "Fixture.Empty0" }),
          expect.objectContaining({ full_name: "Fixture.Empty511" }),
          expect.objectContaining({ full_name: "Fixture.LookupAttribute" }),
        ]),
        methods: [
          expect.objectContaining({
            name: ".ctor",
            declaring_type: "Fixture.LookupAttribute",
            body: expect.objectContaining({
              status: "present",
              instruction_count: 1,
            }),
          }),
        ],
      },
    });
    expect(members.json).toHaveProperty("normalized_result.types.length", 513);
  },
);

cliTest(
  "managed CLI separates .NET Standard API targets from runtime evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-runtime-family-");
    for (const [name, targetFramework, readyToRun, runtimeFamily] of [
      ["standard", ".NETStandard,Version=v2.0", false, "unknown"],
      ["core", ".NETCoreApp,Version=v8.0", false, "modern-dotnet"],
      ["standard-r2r", ".NETStandard,Version=v2.0", true, "modern-dotnet"],
    ] as const) {
      const path = join(root, `${name}.dll`);
      await writeFile(
        path,
        buildManagedPeFixture({ targetFramework, readyToRun }),
      );
      const result = await cli.run({
        arguments: ["inspect-managed-artifact", path, "--json"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        operation: "inspect_managed_artifact",
        subject: { local_path: path },
        normalized_result: {
          classification: {
            status: "managed",
            runtime_family: runtimeFamily,
            implementation: readyToRun ? "cil-and-ready-to-run" : "cil",
            evidence: expect.arrayContaining([
              expect.objectContaining({
                code: readyToRun
                  ? "ready-to-run-signature-observed"
                  : "target-framework-observed",
                detail: expect.stringContaining(
                  readyToRun
                    ? "ReadyToRun signature"
                    : name === "standard"
                      ? "does not identify a runtime family"
                      : "names modern .NET",
                ),
                file_offset: expect.any(Number),
              }),
            ]),
          },
          target_frameworks: [targetFramework],
          coverage: { state: "complete", issues: [] },
        },
      });
    }
  },
);

cliTest(
  "managed CLI preserves evidence, filters, envelopes, and bounded token counts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-cli-output-");
    const path = join(root, "fixture.dll");
    await writeFile(path, buildManagedPeFixture());
    const argv = ["inspect-managed-members", path, "--json"];
    const result = await cli.run({ arguments: argv });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_managed_members",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path },
      normalized_result: {
        methods: [expect.objectContaining({ token: expect.any(String) })],
      },
    });
    const filtered = await cli.run({
      arguments: [...argv, "--filter-output", "operation", "--full-output"],
    });
    expect(filtered.exitCode).toBe(0);
    expect(filtered.json).toMatchObject({
      ok: true,
      data: "inspect_managed_members",
      meta: {
        command: "inspect-managed-members",
        duration: expect.stringMatching(/^\d+ms$/u),
      },
    });
    const count = await cli.run({
      arguments: [...argv, "--filter-output", "operation", "--token-count"],
    });
    expect(count.exitCode).toBe(0);
    expect(count.stdout).toMatch(/^\d+\n$/u);
    const omittedCount = await cli.run({
      arguments: [...argv, "--filter-output", "toString", "--token-count"],
    });
    expect(omittedCount.exitCode).toBe(0);
    expect(omittedCount.stdout).toBe("0\n");
    const jsonl = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--format",
        "jsonl",
        "--filter-output",
        "operation",
      ],
    });
    expect(jsonl.exitCode).toBe(0);
    expect(jsonl.json).toBe("inspect_managed_members");
  },
);

cliTest(
  "managed CLI rejects repeated or empty type selections as invalid input",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-cli-types-");
    const path = join(root, "fixture.dll");
    await writeFile(path, buildManagedPeFixture());
    for (const [types, message] of [
      [["Fixture.Empty0", "Fixture.Empty0"], "must not repeat a name"],
      [[""], ">=1 characters"],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-managed-members",
          path,
          ...types.flatMap((type) => ["--type", type]),
          "--json",
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          expect.objectContaining({
            path: expect.stringMatching(/^type/u),
            message: expect.stringContaining(message),
          }),
        ],
      });
    }
  },
);

cliTest(
  "managed CLI bounds CIL claims by section virtual ranges",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-virtual-size-");
    for (const virtualSectionSize of [0, 0x800, 0x801, 0x802]) {
      // The two-byte tiny method starts at RVA 0x2800. Its header alone fits
      // at size 0x801, and its full CIL fits exactly at size 0x802.
      const bytes = buildManagedPeFixture({
        virtualSectionSize,
        ilBody: Buffer.from([0x06, 0x2a]),
      });
      const path = join(root, `virtual-${virtualSectionSize}.dll`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-managed-members", path, "--json"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        normalized_result:
          virtualSectionSize === 0
            ? {
                methods: [],
                metadata: { status: "malformed" },
                coverage: { state: "unavailable" },
              }
            : {
                methods: [
                  {
                    rva: 0x2800,
                    body:
                      virtualSectionSize === 0x802
                        ? {
                            status: "present",
                            normalized_il_sha256: expect.any(String),
                          }
                        : {
                            status: "malformed",
                            normalized_il_sha256: null,
                          },
                  },
                ],
                coverage: {
                  state: virtualSectionSize === 0x802 ? "complete" : "partial",
                },
              },
      });
    }
  },
);

cliTest(
  "managed CLI distinguishes raw padding from overlapping virtual sections",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-section-identity-");
    for (const virtualSectionSize of [0x800, 0x900]) {
      const bytes = buildManagedPeFixture({ virtualSectionSize });
      const coff = bytes.readUInt32LE(0x3c) + 4;
      const firstSection = coff + 20 + bytes.readUInt16LE(coff + 16);
      const secondSection = firstSection + 40;
      bytes.writeUInt16LE(2, coff + 2);
      bytes.write(".il", secondSection, "ascii");
      bytes.writeUInt32LE(0x100, secondSection + 8);
      bytes.writeUInt32LE(0x2800, secondSection + 12);
      bytes.writeUInt32LE(0x100, secondSection + 16);
      bytes.writeUInt32LE(0x0a00, secondSection + 20);
      const path = join(root, `sections-${virtualSectionSize}.dll`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-managed-members", path, "--json"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        normalized_result: {
          methods: [
            {
              rva: 0x2800,
              body:
                virtualSectionSize === 0x800
                  ? {
                      status: "present",
                      file_offset: 0x0a00,
                      normalized_il_sha256: expect.any(String),
                    }
                  : {
                      status: "malformed",
                      normalized_il_sha256: null,
                      issue: expect.stringContaining("ambiguous overlapping"),
                    },
            },
          ],
          coverage: {
            state: virtualSectionSize === 0x800 ? "complete" : "partial",
          },
        },
      });
    }
  },
);
