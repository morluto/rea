import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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

cliTest(
  "retains Kconfig-produced Unicode separators inside quoted values",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kconfig-unicode-cli-");
    const path = join(root, "vmlinux");
    // Linux Kconfig conf emits these Unicode characters literally, escaping
    // only the quote and backslash; they do not terminate a .config line.
    const value = 'oracle"quote\\slash\u2028line\u2029paragraph';
    const text = `CONFIG_LOCALVERSION=${JSON.stringify(value)}\nCONFIG_OK=y\n`;
    const config = Buffer.from(text, "utf8");
    await writeFile(
      path,
      Buffer.concat([
        kernelBuildConfigFixture().subarray(0, 64),
        Buffer.from("IKCFG_ST"),
        gzipSync(config),
        Buffer.from("IKCFG_ED"),
      ]),
    );
    const result = await cli.run({
      arguments: ["inspect-kernel-build-config", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.normalized_result.config).toMatchObject({
      status: "present",
      reason: null,
      sha256: createHash("sha256").update(config).digest("hex"),
      option_count: 2,
      matched_count: 2,
      entries: [
        { name: "CONFIG_LOCALVERSION", kind: "string", value },
        { name: "CONFIG_OK", kind: "y", value: "y" },
      ],
    });
  },
);
