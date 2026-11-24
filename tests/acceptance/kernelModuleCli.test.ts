import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  compressedKernelModuleContainer,
  crc32Array,
  extendedVersionSections,
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
  "decodes __ksymtab_strings, __kcrctab*, and CONFIG_EXTENDED_MODVERSIONS through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-ext-cli-");
    const path = join(root, "ext.ko");
    const longSym = `_RNvNt_${"ext_modversion_name_".repeat(4)}sym`;
    const ext = extendedVersionSections(
      [
        { crc: 0x10203040, name: "printk" },
        { crc: 0xa1b2c3d4, name: longSym },
      ],
      true,
    );
    await writeFile(
      path,
      kernelModuleFixture({
        versions: null,
        ksymtabStrings: Buffer.from("my_export\0MY_NS\0", "latin1"),
        kcrctab: crc32Array([0xfeedface], true),
        kcrctabGpl: crc32Array([0xcafebabe], true),
        versionExtNames: ext.names,
        versionExtCrcs: ext.crcs,
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-kernel-module", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_kernel_module").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.versions?.status).toBe("absent");
    expect(evidence.normalized_result.extended_versions).toMatchObject({
      status: "present",
      entry_crc_bytes: 4,
      entries: [
        { index: 0, crc_hex: "10203040", name: "printk", status: "observed" },
        { index: 1, crc_hex: "a1b2c3d4", name: longSym, status: "observed" },
      ],
    });
    expect(
      evidence.normalized_result.ksymtab?.strings?.entries.map(
        (entry) => entry.value,
      ),
    ).toEqual(["my_export", "MY_NS"]);
    expect(
      evidence.normalized_result.ksymtab?.kcrctab?.entries.map(
        (entry) => entry.crc_hex,
      ),
    ).toEqual(["feedface"]);
    expect(
      evidence.normalized_result.ksymtab?.kcrctab_gpl?.entries.map(
        (entry) => entry.crc_hex,
      ),
    ).toEqual(["cafebabe"]);
    expect(evidence.normalized_result.coverage).toEqual({
      status: "complete",
      examined_entries: 14,
    });
  },
);

cliTest(
  "reports malformed extended modversions mismatches and refuses exceeded entry budgets via CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-module-ext-err-");
    const mismatchPath = join(root, "mismatch.ko");
    await writeFile(
      mismatchPath,
      kernelModuleFixture({
        versions: null,
        versionExtNames: Buffer.from("only_one\0", "latin1"),
        versionExtCrcs: crc32Array([0x11111111, 0x22222222], true),
      }),
    );
    const mismatch = await cli.run({
      arguments: ["inspect-kernel-module", mismatchPath, "--json"],
    });
    expect(mismatch.exitCode, mismatch.stderr).toBe(0);
    const parsed = toolContract("inspect_kernel_module").outputSchema.parse(
      mismatch.json,
    );
    expect(parsed.normalized_result.coverage.status).toBe("partial");
    expect(parsed.normalized_result.extended_versions).toMatchObject({
      status: "malformed",
      reason: "version_ext_count_mismatch",
      names_section: { status: "present", count: 1 },
      crcs_section: { status: "present", count: 2 },
      entries: [],
    });

    const overBudget = await cli.run({
      arguments: [
        "inspect-kernel-module",
        mismatchPath,
        "--max-entries",
        "7",
        "--json",
      ],
    });
    expect(overBudget.exitCode, overBudget.stderr).toBe(1);
    expect(overBudget.json).toMatchObject({
      code: "resource_constraint",
      remediation: {
        action: expect.stringContaining("max_entries"),
      },
      details: {
        operation: "inspect_kernel_module",
        resource: "capacity",
        reported_limits: { max_entries: 7 },
      },
    });
  },
);
