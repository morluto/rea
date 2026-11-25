import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const fileIdentity = (path: string, bytes: Buffer) => ({
  kind: "file-snapshot-hash",
  path,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

// Foreign bytes each reader refuses before it decodes any structure. The
// malformed and truncated cases live in the target-failure conformance
// registry (tests/support/targetFailure); these join it when the unsupported
// and unrecognised refusals migrate onto the TargetFailure model (#14239).
for (const command of [
  "inspect-python-pyc",
  "inspect-erlang-beam",
  "inspect-rust-binary",
  "inspect-go-binary",
  "inspect-elf-notes",
  "inspect-elf-dependencies",
  "inspect-elf-debug-link",
  "inspect-elf-unwind-ranges",
  "inspect-devicetree",
  "inspect-pe-imports",
  "inspect-kernel-module",
  "inspect-apple-ips",
  "inspect-pe-load-config",
  "inspect-pe-certificates",
  "inspect-pe-resources",
  "inspect-native-exports",
  "inspect-native-initializers",
  "inspect-binary-hardening",
]) {
  const isBeam = command === "inspect-erlang-beam";

  cliTest(
    `${command} retains the completed file identity after format refusal`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-format-refusal-");
      const path = join(root, "foreign.bin");
      const bytes = isBeam ? Buffer.from("FOR1") : Buffer.alloc(64, 0x7f);
      await writeFile(path, bytes);
      const result = await cli.run({ arguments: [command, path, "--json"] });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        details: { partial_observation: fileIdentity(path, bytes) },
      });
    },
  );
}
