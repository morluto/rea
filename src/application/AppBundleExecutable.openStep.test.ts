import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { resolveAppleBundleExecutable } from "./AppBundleExecutable.js";

it("resolves the declared executable from a commented OpenStep Info.plist", async () => {
  const root = await createTestTempDirectory("rea-openstep-bundle-");
  const bundle = join(root, "Fixture.app");
  const programs = join(bundle, "Contents", "MacOS");
  const executable = join(programs, "Fixture");
  const infoPlist = join(bundle, "Contents", "Info.plist");
  const source =
    " \t/* header */\n// executable selection\n{ CFBundleExecutable = Fixture; }";
  await mkdir(programs, { recursive: true });
  await writeFile(infoPlist, source);
  await writeFile(executable, "fixture - never executed");

  expect(await resolveAppleBundleExecutable(bundle)).toEqual({
    ok: true,
    value: { executable, infoPlist },
  });
});
