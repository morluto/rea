import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  compressedKernelModuleContainer,
  kernelModuleFixture,
} from "../../src/native/elf/KernelModule.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "honors modinfo field retention budgets through CLI flags",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-text-cli-");
    const path = join(root, "text.ko");
    const key = "k".repeat(257);
    const value = "v".repeat(4097);
    await writeFile(
      path,
      kernelModuleFixture({ modinfo: Buffer.from(`${key}=${value}\0`) }),
    );
    const result = await cli.run({
      arguments: [
        "inspect-kernel-module",
        path,
        "--max-modinfo-key-bytes",
        "257",
        "--max-modinfo-value-bytes",
        "4097",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.modinfo?.entries[0]).toMatchObject({
      key,
      value,
      status: "observed",
      reason: null,
      omitted_fields: [],
    });
    expect(evidence.normalized_result.coverage.status).toBe("complete");
    const omitted = await cli.run({
      arguments: [
        "inspect-kernel-module",
        path,
        "--max-modinfo-value-bytes",
        "4096",
        "--full-output",
        "--json",
      ],
    });
    expect(omitted.exitCode, omitted.stderr).toBe(0);
    expect((omitted.json as { meta: unknown }).meta).toMatchObject({
      cli_controls: {
        max_modinfo_key_bytes: "--max-modinfo-key-bytes",
        max_modinfo_value_bytes: "--max-modinfo-value-bytes",
      },
    });
  },
);

cliTest(
  "reports license, duplicate aliases, and version CRCs through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-cli-");
    const path = join(root, "demo.ko");
    await writeFile(
      path,
      kernelModuleFixture({
        sharedNameSections: {
          name: ".init.text",
          count: 1,
          body: Buffer.from([1, 2, 3]),
        },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-kernel-module", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.modinfo?.entries.map((entry) => [
        entry.key,
        entry.value,
      ]),
    ).toEqual([
      ["license", "GPL"],
      ["vermagic", "5.15.0 SMP mod_unload"],
      ["alias", "pci:v1"],
      ["alias", "pci:v2"],
      ["name", "demo"],
      ["depends", ""],
    ]);
    expect(evidence.normalized_result.versions?.entries[0]?.crc_hex).toBe(
      "0000000012345678",
    );
    expect(evidence.normalized_result).toMatchObject({
      signature: { status: "present" },
      coverage: { status: "partial" },
      init_text: { status: "present", bytes: 4 },
    });
    expect(evidence.normalized_result.limitations).toContainEqual(
      expect.stringMatching(/Multiple \.init\.text .*first .*examined/u),
    );
  },
);

cliTest(
  "resolves a relative kernel module path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-cli-rel-");
    await writeFile(join(root, "demo.ko"), kernelModuleFixture({ type: 3 }));
    const result = await cli.run({
      arguments: ["inspect-kernel-module", "demo.ko", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.applicability).toBe("not_applicable");
    expect(evidence.normalized_result.type_name).toBe("shared");
    expect(evidence.subject?.local_path).toBe(join(root, "demo.ko"));
  },
);

cliTest(
  "reports a compressed container without claiming the payload is a module",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-cli-xz-");
    const path = join(root, "demo.ko.xz");
    await writeFile(path, compressedKernelModuleContainer("xz"));
    const result = await cli.run({
      arguments: ["inspect-kernel-module", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result).toMatchObject({
      applicability: "unsupported",
      format: null,
      compression: { codec: "xz", status: "unsupported" },
      next_probe: { operation: "external_decompression" },
      modinfo: null,
    });
    expect(fileIdentity(evidence.subject).format).toBe("file");
  },
);

cliTest(
  "reports structured details.limit and CLI flags for max-file-bytes and max-entries refusals",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-cli-limit-");
    const path = join(root, "demo.ko");
    const bytes = kernelModuleFixture();
    await writeFile(path, bytes);

    const fileBudget = await cli.run({
      arguments: [
        "inspect-kernel-module",
        path,
        "--max-file-bytes",
        "64",
        "--json",
      ],
    });
    expect(fileBudget.exitCode).not.toBe(0);
    expect(fileBudget.json).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_file_bytes",
          effective_value: 64,
          unit: "bytes",
          minimum: 64,
          maximum: 536870912,
          default_value: 67108864,
          applies_at: "next_call",
          required_value: bytes.length,
          cli_flag: "--max-file-bytes",
        },
      },
      remediation: {
        action: expect.stringContaining("--max-file-bytes"),
      },
    });
    expect(
      (fileBudget.json as { remediation: { action: string } }).remediation
        .action,
    ).toContain(`at least ${String(bytes.length)}`);

    const entryBudget = await cli.run({
      arguments: [
        "inspect-kernel-module",
        path,
        "--max-entries",
        "1",
        "--json",
      ],
    });
    expect(entryBudget.exitCode).not.toBe(0);
    expect(entryBudget.json).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_entries",
          effective_value: 1,
          unit: "count",
          minimum: 1,
          maximum: 65536,
          default_value: 8192,
          applies_at: "next_call",
          cli_flag: "--max-entries",
        },
      },
      remediation: {
        action: expect.stringContaining("--max-entries"),
      },
    });

    const recovered = await cli.run({
      arguments: [
        "inspect-kernel-module",
        path,
        "--max-file-bytes",
        String(bytes.length),
        "--max-entries",
        "16",
        "--json",
      ],
    });
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(
      toolContract("inspect_kernel_module").outputSchema.parse(recovered.json)
        .normalized_result.applicability,
    ).toBe("applicable");
  },
);
