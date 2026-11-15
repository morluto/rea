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
    expect(evidence.subject?.format).toBe("elf");
  },
);

cliTest(
  "keeps the compiler group separate from an empty builder group",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kernel-banner-cli-");
    const path = join(root, "banner.bin");
    const text = "Linux version 6.1.0 () (gcc 12.2.0) #1 SMP";
    await writeFile(path, `${text}\0`);
    const result = await cli.run({
      arguments: ["inspect-kernel-build-config", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.banner).toMatchObject({
      status: "present",
      text,
      version: "6.1.0",
      builder: null,
      compiler: "gcc 12.2.0",
      location: { space: "file", offset: 0, bytes: text.length },
    });
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
