import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { thinMach } from "../../../../src/domain/binaryTarget.fixture.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  NativeCommandOptions,
  NativeCommandRunner,
} from "../../../../src/providers/NativeCommandRunner.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

/**
 * CoreFoundation accepts XML plists that strict XML 1.0 rejects. A declaration after leading
 * whitespace is the smallest such file: `plutil -lint` exits 0 on it, while the strict rule
 * requires the declaration to be the first thing in the document.
 */
const LEADING_NEWLINE_PLIST = `
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fixture</string></dict></plist>
`;

const CONVERTED_JSON = `{"CFBundleIdentifier":"com.example.fixture"}`;

/** `file` describes the bytes as text, so the strict XML reader is the one that runs. */
class PlatformRunner implements NativeCommandRunner {
  constructor(private readonly lintExitCode: number) {}

  async run(
    tool: string,
    arguments_: readonly string[],
    options?: NativeCommandOptions,
  ) {
    const replay = new NativeFixtureRunner({ file: "ASCII text\n" });
    const capture = await replay.run(tool, arguments_, options);
    if (tool !== "plutil" || !capture.ok) return capture;
    if (arguments_[0] === "-lint")
      return ok({ ...capture.value, exitCode: this.lintExitCode, stdout: "" });
    if (arguments_[0] === "-convert")
      return ok({
        ...capture.value,
        exitCode: 0,
        stdout: CONVERTED_JSON,
        stdoutBytes: Buffer.byteLength(CONVERTED_JSON),
      });
    return capture;
  }
}

const inspectPlt = async (lintExitCode: number) => {
  const root = await createTestTempDirectory("rea-plist-platform-");
  const target = join(root, "program");
  await writeFile(target, thinMach(0xfeedfacf, 0x100000c));
  await mkdir(join(root, "Contents"));
  const path = join(root, "Contents/Info.plist");
  await writeFile(path, LEADING_NEWLINE_PLIST);
  const client = new NativeMacOSProvider(
    {},
    new PlatformRunner(lintExitCode),
    "darwin",
  ).createClient(nativeMachoTarget(target));
  onTestFinished(async () => {
    await client.close();
  });
  return client.execute("inspect_plist", { path });
};

it("decodes a plist the platform reader accepts but strict XML rejects", async () => {
  const result = await inspectPlt(0);
  if (!result.ok)
    throw new Error("expected the platform-accepted plist to be read");
  expect(JSON.stringify(result.value)).toContain("com.example.fixture");
});

it("still refuses when the platform reader rejects the same bytes", async () => {
  const result = await inspectPlt(1);
  expect(result.ok).toBe(false);
});
