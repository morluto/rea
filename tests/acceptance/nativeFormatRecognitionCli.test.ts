import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { machoArm64Initializers } from "../../src/native/initializers/NativeInitializers.fixture.js";
import { arm64FunctionStartsImage } from "../../src/native/apple/MachoFunctionStarts.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

/** The first bytes of an ELF64 little-endian header; no other ELF structure. */
const elfBytes = (): Buffer => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  return bytes;
};

/** An `MZ` DOS header with no PE image behind it. */
const peBytes = (): Buffer => {
  const bytes = Buffer.alloc(64);
  bytes.write("MZ", 0, "latin1");
  return bytes;
};

/** Bytes with no ELF, PE or Mach-O magic. */
const randomBytes = (): Buffer =>
  Buffer.from(
    Array.from({ length: 64 }, (_, index) => (index * 37 + 11) & 0xff),
  );

const run = async (
  cli: { run: (input: { arguments: string[] }) => Promise<{ json: unknown }> },
  command: string,
  name: string,
  bytes: Buffer,
) => {
  const root = await createTestTempDirectory("rea-native-recognition-cli-");
  const path = join(root, name);
  await writeFile(path, bytes);
  const result = await cli.run({ arguments: [command, path, "--json"] });
  return { path, json: result.json };
};

for (const [name, bytes] of [
  ["PE", peBytes()],
  ["random bytes", randomBytes()],
] as const)
  cliTest(
    `reports a ${name} file to inspect-native-initializers as unrecognized`,
    async ({ cli }) => {
      const { path, json } = await run(
        cli,
        "inspect-native-initializers",
        "target.bin",
        bytes,
      );
      expect(json).toMatchObject({
        code: "unsupported_target",
        details: {
          operation: "inspect_native_initializers",
          path,
          failure_kind: "unrecognized",
        },
      });
    },
  );

for (const [name, bytes] of [
  ["ELF", elfBytes()],
  ["PE", peBytes()],
  ["random bytes", randomBytes()],
] as const)
  cliTest(
    `reports a ${name} file to inspect-macho-function-starts as unrecognized`,
    async ({ cli }) => {
      const { path, json } = await run(
        cli,
        "inspect-macho-function-starts",
        "target.bin",
        bytes,
      );
      expect(json).toMatchObject({
        code: "unsupported_target",
        details: {
          operation: "inspect_macho_function_starts",
          path,
          failure_kind: "unrecognized",
          format: "macho",
        },
      });
    },
  );

for (const [command, operation, image] of [
  [
    "inspect-native-initializers",
    "inspect_native_initializers",
    machoArm64Initializers,
  ],
  [
    "inspect-macho-function-starts",
    "inspect_macho_function_starts",
    arm64FunctionStartsImage,
  ],
] as const)
  cliTest(
    `keeps a cut-off Mach-O header a format failure for ${command}`,
    async ({ cli }) => {
      // A 64-bit Mach-O magic with the header cut off after 12 bytes.
      const cut = Buffer.from(image().subarray(0, 12));
      const { path, json } = await run(cli, command, "program", cut);
      expect(json).toMatchObject({
        code: "unsupported_target",
        details: { operation, path },
      });
      const failureKind = (json as { details: { failure_kind: string } })
        .details.failure_kind;
      expect(["malformed", "truncated"]).toContain(failureKind);
    },
  );

for (const [command, operation] of [
  ["inspect-go-binary", "inspect_go_binary"],
  ["inspect-rust-binary", "inspect_rust_binary"],
] as const)
  cliTest(
    `reports a non-native file to ${command} as unrecognized with its facts`,
    async ({ cli }) => {
      const { path, json } = await run(
        cli,
        command,
        "target.bin",
        randomBytes(),
      );
      expect(json).toMatchObject({
        code: "unsupported_target",
        details: {
          operation,
          path,
          failure_kind: "unrecognized",
          format: "native-binary",
        },
      });
    },
  );
