import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  bzImageGzipFixture,
  bzImageXzFixture,
  kernelBuildConfigFixture,
} from "../../src/native/elf/KernelBuildConfig.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = toolContract("inspect_kernel_build_config");

cliTest(
  "reports the banner and one filtered config option through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-config-cli-");
    const path = join(root, "vmlinux");
    await writeFile(path, kernelBuildConfigFixture());
    const result = await cli.run({
      arguments: [
        "inspect-kernel-build-config",
        path,
        "--name",
        "CONFIG_SECURITY_SELINUX",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.banner.version).toBe("6.6.0");
    expect(evidence.normalized_result.config).toMatchObject({
      status: "present",
      option_count: 9,
      matched_count: 1,
      entries: [{ name: "CONFIG_SECURITY_SELINUX", kind: "y", value: "y" }],
    });
    expect(fileIdentity(evidence.subject).format).toBe("elf");
  },
);

cliTest(
  "resolves a relative bzImage path and pages its inflated config",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-config-cli-rel-");
    await writeFile(join(root, "bzImage"), bzImageGzipFixture());
    const result = await cli.run({
      arguments: [
        "inspect-kernel-build-config",
        "bzImage",
        "--offset",
        "8",
        "--limit",
        "1",
        "--json",
      ],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.payload).toMatchObject({
      container: "bzimage",
      status: "inflated",
    });
    expect(
      evidence.normalized_result.config.entries.map((entry) => entry.name),
    ).toEqual(["CONFIG_MODULE_SIG_FORCE"]);
    expect(evidence.subject?.local_path).toBe(join(root, "bzImage"));
    expect(fileIdentity(evidence.subject).format).toBe("file");
    expect(evidence.confidence).toBe("observed");
  },
);

cliTest(
  "names an xz payload as unsupported without claiming an absent config",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-config-cli-xz-");
    const path = join(root, "bzImage");
    await writeFile(path, bzImageXzFixture());
    const result = await cli.run({
      arguments: ["inspect-kernel-build-config", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      payload: { codec: "xz", status: "unsupported" },
      next_probe: { operation: "external_decompression" },
      config: { status: "unsupported" },
    });
  },
);

cliTest(
  "retains the kernel banner groups and Kconfig source spellings",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kconfig-values-cli-");
    const path = join(root, "vmlinux");
    const banner = "Linux version 6.1.0 () (gcc 12.2.0) #1 SMP";
    const value = 'oracle"quote\\slash\u2028line\u2029paragraph';
    const config = [
      `CONFIG_LOCALVERSION=${JSON.stringify(value)}`,
      "CONFIG_OK=y",
      "CONFIG_BARE_HEX=AbCd",
      "CONFIG_PADDED_HEX=00042",
      "CONFIG_PREFIXED_HEX=0xABcd",
      "CONFIG_NEGATIVE_INT=-42",
      "",
    ].join("\n");
    const elfHeader = kernelBuildConfigFixture().subarray(0, 64);
    await writeFile(
      path,
      Buffer.concat([
        elfHeader,
        Buffer.from(`${banner}\0`),
        Buffer.from("IKCFG_ST"),
        gzipSync(config),
        Buffer.from("IKCFG_ED"),
      ]),
    );
    const result = await cli.run({
      arguments: ["inspect-kernel-build-config", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      contract.outputSchema.parse(result.json).normalized_result,
    ).toMatchObject({
      banner: {
        status: "present",
        text: banner,
        version: "6.1.0",
        builder: null,
        compiler: "gcc 12.2.0",
        location: { space: "file", offset: 64, bytes: banner.length },
      },
      config: {
        status: "present",
        reason: null,
        sha256: createHash("sha256").update(config).digest("hex"),
        option_count: 6,
        matched_count: 6,
        entries: [
          { name: "CONFIG_LOCALVERSION", kind: "string", value },
          { name: "CONFIG_OK", kind: "y", value: "y" },
          { name: "CONFIG_BARE_HEX", kind: "number", value: "AbCd" },
          { name: "CONFIG_PADDED_HEX", kind: "number", value: "00042" },
          { name: "CONFIG_PREFIXED_HEX", kind: "number", value: "0xABcd" },
          { name: "CONFIG_NEGATIVE_INT", kind: "number", value: "-42" },
        ],
      },
    });
  },
);
