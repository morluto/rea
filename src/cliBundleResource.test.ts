import { unknownTarget } from "./domain/targetIdentity.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";

import { createCli } from "./cli.js";
import { parseEvidence } from "./domain/evidence.js";

it("inspects a keyless app bundle through the public CLI and preserves resource provenance", async () => {
  const parent = await createTestTempDirectory("rea-bundle-resource-cli-");
  const bundle = join(parent, "Fixture.app");
  const resources = join(bundle, "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(bundle, "Info.plist"), "<plist><dict/></plist>");
  await writeFile(
    join(resources, "Archive.plist"),
    build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "resource-only-value"],
      $top: { root: { UID: 1 } },
    }),
  );

  const cli = createCli({ REA_LOG_LEVEL: "silent" });
  let stdout = "";
  let exitCode = 0;
  await cli.serve(
    ["inspect-keyed-archive", bundle, "Resources/Archive.plist", "--json"],
    {
      env: {},
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  expect(exitCode, stdout).toBe(0);
  expect(parseEvidence(JSON.parse(stdout))).toMatchObject({
    subject: {
      identity: unknownTarget("not-observed"),
      name: null,
      local_path: null,
    },
    normalized_result: {
      archive_path: "Resources/Archive.plist",
      target_sha256: null,
      resource_root: {
        caller_path: bundle,
        canonical_path: bundle,
        executable_sha256: null,
      },
      objects: expect.arrayContaining([
        expect.objectContaining({ value: "resource-only-value" }),
      ]),
    },
  });
});
