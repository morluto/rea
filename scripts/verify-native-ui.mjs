import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { observeNativeUi } from "../dist/native/NativeUiObservation.js";

if (process.platform !== "darwin")
  throw new Error(
    "Native UI verification requires macOS, an interactive desktop and Xcode command-line tools",
  );
const root = await mkdtemp(join(tmpdir(), "rea-ui-fixture-"));
let child;
let fixturePid;
try {
  const contents = join(root, "Fixture.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>io.rea.source-owned-ui-fixture</string><key>CFBundleName</key><string>REA UI Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  const executable = join(contents, "MacOS", "fixture");
  await promisify(execFile)("/usr/bin/xcrun", [
    "swiftc",
    "-module-cache-path",
    join(root, "modules"),
    fileURLToPath(
      new URL("../tests/conformance/native/ui.swift", import.meta.url),
    ),
    "-o",
    executable,
  ]);
  const coordinates = join(root, "scope.json");
  await writeFile(coordinates, "");
  child = spawn(
    "/usr/bin/open",
    ["-W", "-n", "-g", "--stdout", coordinates, join(root, "Fixture.app")],
    { stdio: "ignore" },
  );
  let scope;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const output = await readFile(coordinates, "utf8");
    if (output.includes("\n")) {
      scope = JSON.parse(output.split("\n")[0]);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (scope === undefined)
    throw new Error(
      "Source-owned UI fixture failed to expose one window within 20 seconds",
    );
  fixturePid = scope.pid;
  const target = await parseBinaryTarget(executable);
  if (!target.ok) throw target.error;
  const observation = await observeNativeUi(target.value, "observe_native_ui", {
    ...scope,
    observation_approved: true,
  });
  if (
    !observation.ok &&
    !/accessibility-denied|screen-recording-denied/u.test(
      observation.error.message,
    )
  )
    throw observation.error;
  if (!observation.ok && !process.argv.includes("--allow-permission-denial"))
    throw new Error(
      `Native UI E2E requires successful capture; permissions prevented coverage: ${observation.error.message}. Use --allow-permission-denial only for the separate permission diagnostic lane.`,
    );
  let scenarioStatus = "not-run-permission-denied";
  if (observation.ok) {
    const button = observation.value.initial.nodes.find(
      (node) => node.title === "Increment REA fixture",
    );
    if (button === undefined)
      throw new Error("Source-owned fixture button is absent from AX capture");
    const scenario = await observeNativeUi(
      target.value,
      "capture_native_ui_scenario",
      {
        ...scope,
        observation_approved: true,
        actions_approved: true,
        restore: "leave-as-is",
        screenshot: false,
        steps: [
          { kind: "click", path: button.path },
          { kind: "wait", milliseconds: 200 },
        ],
      },
    );
    if (!scenario.ok) throw scenario.error;
    if (
      scenario.value.steps.some((step) => step.outcome !== "completed") ||
      !scenario.value.steps
        .at(-1)
        ?.after?.nodes.some((node) => node.title === "REA fixture incremented")
    )
      throw new Error(
        `Source-owned AX scenario failed: ${JSON.stringify(scenario.value.steps.map(({ outcome, reason }) => ({ outcome, reason })))}`,
      );
    scenarioStatus = "selected-AX-button-action-observed";
    const cli = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./rea.mjs", import.meta.url)),
        "capture-native-ui-scenario",
        executable,
        "--pid",
        String(scope.pid),
        "--window-id",
        String(scope.window_id),
        "--observation-approved",
        "--actions-approved",
        "--restore",
        "leave-as-is",
        "--steps",
        JSON.stringify([
          { kind: "click", path: button.path },
          { kind: "wait", milliseconds: 200 },
        ]),
        "--json",
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 180000 },
    );
    const evidence = JSON.parse(cli.stdout);
    if (
      evidence.normalized_result?.steps?.some(
        (step) => step.outcome !== "completed",
      ) ||
      evidence.normalized_result?.steps?.length !== 2
    )
      throw new Error(
        `Native UI CLI did not preserve the approved scenario: ${JSON.stringify(evidence.error ?? evidence.normalized_result?.steps?.map(({ outcome, reason }) => ({ outcome, reason })))}`,
      );
    scenarioStatus = "selected-AX-button-action-and-CLI-parity-observed";
  }
  const mismatch = await observeNativeUi(
    { ...target.value, sha256: "0".repeat(64) },
    "observe_native_ui",
    { ...scope, observation_approved: true },
  );
  if (mismatch.ok || !mismatch.error.message.includes("target-mismatch"))
    throw new Error("Real helper did not reject changed target bytes");
  process.stdout.write(
    `${JSON.stringify({ ok: true, verification_status: observation.ok ? "passed" : "permission-boundary-only", positive_e2e: observation.ok, observation: observation.ok ? "captured-selected-fixture-window" : "os-permission-denial-verified", scenario: scenarioStatus, permission_failure: observation.ok ? null : observation.error.message, mismatch_rejected: true, target_owned: true })}\n`,
  );
} finally {
  if (fixturePid !== undefined) {
    try {
      process.kill(fixturePid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
