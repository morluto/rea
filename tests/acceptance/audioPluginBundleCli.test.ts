import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.skipIf(process.platform !== "darwin")(
  "inspects Audio Unit and VST3 bundle directories through CFBundleExecutable",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-audio-plugin-bundle-");
    for (const name of ["Reverb.component", "Reverb.vst3"]) {
      const bundle = join(root, name);
      const programs = join(bundle, "Contents", "MacOS");
      await mkdir(programs, { recursive: true });
      await writeFile(
        join(bundle, "Contents", "Info.plist"),
        "<plist><dict><key>CFBundleExecutable</key><string>Reverb</string></dict></plist>",
      );
      await copyFile("/usr/bin/true", join(programs, "Reverb"));
      const result = await cli.run({
        arguments: ["inspect-macho", bundle, "--json"],
        environment:
          process.env.DEVELOPER_DIR === undefined
            ? {}
            : { DEVELOPER_DIR: process.env.DEVELOPER_DIR },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = parseEvidence(result.json);
      expect(evidence.caller_input_path).toBe(bundle);
      expect(evidence.subject?.local_path).toBe(
        await realpath(join(programs, "Reverb")),
      );
    }
  },
);
