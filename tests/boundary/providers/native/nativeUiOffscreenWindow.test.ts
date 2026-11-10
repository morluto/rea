import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { AnalysisInputError } from "../../../../src/domain/analysisErrorCore.js";
import { createNativeUiHelperRuntime } from "../../../../src/native/NativeUiHelperRuntime.js";
import { observeNativeUi } from "../../../../src/native/NativeUiObservation.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const scopeSchema = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
});

// Ownership starts with the launch: the app inherits the launcher's run token, so
// the sweep finds it with or without a ready record. /usr/bin/open's own token is
// withheld, so its retained handle must stop it before the sweep can succeed.
const launch = async (bundle: string, name: string) => {
  const coordinates = join(bundle, "..", `${name}.json`);
  await writeFile(coordinates, "");
  const owned = await spawnOwnedProviderProcess({
    command: "/usr/bin/open",
    arguments: ["-W", "-n", "-g", "--stdout", coordinates, bundle],
    runId: randomUUID(),
    sweepTokenOwnedProcesses: true,
  });
  const launcher = new ProviderProcessSupervisor(
    { process: owned.process, ownsProcessLifetime: true },
    { maxDiagnosticBytes: { stdout: 0, stderr: 64 * 1024 } },
  );
  onTestFinished(async () => {
    const stopped = await launcher.stop();
    const swept = await cleanupOwnedProcessGroup(owned.ownership);
    expect(stopped.status).not.toBe("incomplete");
    expect(swept).toMatchObject({ cleaned: true });
  });
  const deadline = performance.now() + 30_000;
  for (;;) {
    const [line] = (await readFile(coordinates, "utf8")).split("\n");
    if (line !== undefined && line.length > 0)
      return scopeSchema.parse(JSON.parse(line));
    if (performance.now() >= deadline)
      throw new Error("The off-screen fixture never reported its window");
    await delay(50);
  }
};

// The fixture window is real and never ordered in; the helper is compiled and run
// by the production runtime. Capture is off for the raw helper reads, so these
// facts need no Accessibility or Screen Recording permission.
it.skipIf(process.platform !== "darwin")(
  "selects a window that exists off screen and still refuses absent and foreign windows",
  { timeout: 240_000 },
  async () => {
    const root = await createTestTempDirectory("rea-native-ui-offscreen-");
    const bundle = join(root, "Fixture.app");
    const contents = join(bundle, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>io.rea.source-owned-offscreen-fixture</string><key>CFBundleName</key><string>REA Offscreen Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    const executable = join(contents, "MacOS", "fixture");
    await promisify(execFile)("/usr/bin/xcrun", [
      "swiftc",
      "-module-cache-path",
      join(root, "modules"),
      resolve("tests/conformance/native/ui-offscreen.swift"),
      "-o",
      executable,
    ]);
    const selected = await launch(bundle, "selected");
    const foreign = await launch(bundle, "foreign");
    const target = await parseBinaryTarget(executable);
    if (!target.ok) throw target.error;

    const runtime = createNativeUiHelperRuntime(process.env);
    onTestFinished(() => runtime.close());
    const read = (windowId: number) =>
      runtime.invoke({
        pid: selected.pid,
        window_id: windowId,
        executable: target.value.path,
        sha256: target.value.sha256,
        screenshot: false,
        accessibility: false,
        max_nodes: 1,
      });

    expect(await read(selected.window_id)).toMatchObject({
      ok: true,
      result: { window: { pid: selected.pid, window_id: selected.window_id } },
    });
    for (const windowId of [foreign.window_id, 2_147_483_000])
      expect(await read(windowId)).toMatchObject({
        ok: false,
        code: "window-mismatch",
      });

    // Through the shared observation, the window is no longer called absent. Its
    // outcome depends on the host's permissions, which this test does not select.
    const options = { environment: process.env, runtime };
    const observed = await observeNativeUi(
      target.value,
      "observe_native_ui",
      selected,
      options,
    );
    if (!observed.ok)
      expect(JSON.stringify(observed.error)).not.toContain("window-mismatch");

    // The fact the verifier's changed-bytes check reads.
    const changed = await observeNativeUi(
      { ...target.value, sha256: "0".repeat(64) },
      "observe_native_ui",
      selected,
      options,
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error).toBeInstanceOf(AnalysisInputError);
    expect((changed.error as AnalysisInputError).issues?.[0]).toMatchObject({
      path: ["pid"],
      message: expect.stringMatching(/^target-mismatch:/u),
    });
  },
);
