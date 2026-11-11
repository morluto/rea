import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "plist";
import { expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const createWorkingBundleFixture = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const bundle = join(root, "Example.app");
  const temp = join(root, "temp");
  const contents = join(bundle, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await mkdir(temp, { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    build({ CFBundleExecutable: "Example" }),
  );
  await writeFile(
    join(contents, "MacOS", "Example"),
    thinMach(0xcffaedfe, 0x0100000c),
  );
  await writeFile(
    join(contents, "Resources", "Archive.plist"),
    build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "resource-only-value"],
      $top: { root: { CF$UID: 1 } },
    }),
  );
  const environment = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    REA_LOG_LEVEL: "silent",
  };
  return { bundle, temp, environment };
};

cliTest(
  "compiled CLI rejects empty inspect-keyed-archive target in a bundle cwd while preserving explicit dot",
  async ({ cli }) => {
    const { bundle, environment } = await createWorkingBundleFixture(
      "rea-empty-keyed-bundle-",
    );
    const archive = "Contents/Resources/Archive.plist";
    const empty = await cli.run({
      arguments: ["inspect-keyed-archive", "", archive, "--json"],
      cwd: bundle,
      environment,
    });
    expect(empty.exitCode).not.toBe(0);
    expect(empty.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: "path", code: "too_small" }),
      ],
    });

    const explicitDot = await cli.run({
      arguments: ["inspect-keyed-archive", ".", archive, "--json"],
      cwd: bundle,
      environment,
    });
    expect(explicitDot.exitCode, explicitDot.stderr).toBe(0);
    const evidence = parseEvidence(explicitDot.json);
    expect(evidence.parameters).toMatchObject({ input_path: "." });
    expect(evidence.normalized_result).toMatchObject({
      total_objects: 2,
      archive_path: archive,
    });
  },
);

cliTest(
  "compiled CLI rejects empty extract-artifact and bundle artifact targets before touching the working directory",
  async ({ cli }) => {
    const { bundle, temp, environment } = await createWorkingBundleFixture(
      "rea-empty-artifact-bundle-",
    );
    for (const command of [
      "extract-artifact",
      "decode-interface-builder",
      "inspect-asset-catalog",
      "trace-dylib-resolution",
    ]) {
      const empty = await cli.run({
        arguments: [command, "", "--json"],
        cwd: bundle,
        environment,
      });
      expect(empty.exitCode, command).not.toBe(0);
      expect(empty.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          expect.objectContaining({ path: "path", code: "too_small" }),
        ],
      });
    }
    expect(await readdir(temp)).toEqual([]);

    const explicitExtract = await cli.run({
      arguments: ["extract-artifact", ".", "--json"],
      cwd: bundle,
      environment,
    });
    expect(explicitExtract.exitCode, explicitExtract.stderr).toBe(0);
    expect(parseEvidence(explicitExtract.json).parameters).toMatchObject({
      input_path: ".",
    });
  },
);
