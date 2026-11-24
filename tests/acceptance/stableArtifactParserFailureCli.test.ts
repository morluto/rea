import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { peCertificateFixture } from "../../src/native/pe/PeCertificates.fixture.js";

const fileIdentity = (path: string, bytes: Buffer) => ({
  kind: "file-snapshot-hash",
  path,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

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
  const operation = command.replaceAll("-", "_");
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

  // One public owner for the byte readers' malformed-target projection: the
  // bytes, not the request, are at fault, so no argument recovery is offered.
  // Format-specific structure (an IPS body, a shortcut CLSID) keeps its own
  // command test. A BEAM reader sees the ELF magic as a foreign container.
  cliTest(
    `${command} refuses a truncated ELF header as a malformed target`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-malformed-target-");
      const path = join(root, "truncated.bin");
      const bytes = Buffer.from("\x7fELF");
      await writeFile(path, bytes);
      const result = await cli.run({ arguments: [command, path, "--json"] });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "unsupported_target",
        category: "unsupported_target",
        details: {
          operation,
          path,
          format_failure: "malformed",
          partial_observation: fileIdentity(path, bytes),
        },
      });
      expect(result.json).not.toHaveProperty("recovery");
    },
  );
}

/** A PE image whose first WIN_CERTIFICATE declares less than its own header. */
const shortCertificateHeader = (): Buffer => {
  const bytes = peCertificateFixture();
  bytes.writeUInt32LE(4, bytes.readUInt32LE(0x98 + 96 + 4 * 8));
  return bytes;
};

// Structure past the shared headers is refused by each format's own parser,
// which names its format and failure kind once for every adapter.
for (const { command, bytes, formatFailure, format } of [
  {
    command: "inspect-erlang-beam",
    bytes: () => Buffer.from("FOR1"),
    formatFailure: "truncated",
    format: "beam",
  },
  {
    command: "inspect-pe-certificates",
    bytes: shortCertificateHeader,
    formatFailure: "malformed",
    format: "pe-certificate-table",
  },
] as const)
  cliTest(
    `${command} refuses ${formatFailure} ${format} structure as the target's`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-format-body-");
      const path = join(root, "target.bin");
      const selected = bytes();
      await writeFile(path, selected);
      const result = await cli.run({ arguments: [command, path, "--json"] });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "unsupported_target",
        category: "unsupported_target",
        retryable: false,
        details: {
          operation: command.replaceAll("-", "_"),
          path,
          format_failure: formatFailure,
          format,
          partial_observation: fileIdentity(path, selected),
        },
      });
      expect(result.json).not.toHaveProperty("recovery");
    },
  );
