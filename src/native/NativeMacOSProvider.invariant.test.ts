import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import {
  InternalInvariantError,
  invariantViolation,
} from "../domain/internalInvariant.js";
import { NativeFixtureRunner } from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

/**
 * No input reaches an invariant site today, so the command runner reports a
 * broken internal assumption in place of a producer.
 */
it("reports an invariant violation as an adapter failure, not native output", async () => {
  const bundle = await createTestTempDirectory("rea-native-invariant-");
  const infoPlist = join(bundle, "Info.plist");
  await writeFile(infoPlist, '<?xml version="1.0"?><plist><dict/></plist>');
  const runner = new NativeFixtureRunner();
  const client = new NativeMacOSProvider(
    {},
    runner,
    "darwin",
  ).createBundleResourceClient({
    callerPath: bundle,
    canonicalPath: bundle,
    infoPlistPath: infoPlist,
    layout: "root",
    executableSha256: null,
  });
  onTestFinished(async () => {
    await client.close();
  });
  expect((await client.execute("inspect_plist", {})).ok).toBe(true);

  vi.spyOn(runner, "run").mockRejectedValue(
    invariantViolation("Native command plan is missing"),
  );
  const result = await client.execute("inspect_plist", {});
  if (result.ok) throw new Error("Expected the defect to fail inspection");
  expect(result.error._tag).toBe("ProviderAdapterError");
  expect(result.error.cause).toBeInstanceOf(InternalInvariantError);
});
