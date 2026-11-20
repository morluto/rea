import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { observeNativeUi } from "../dist/native/NativeUiObservation.js";
import { NATIVE_UI_HELPER_MAX_BUFFER } from "../dist/native/NativeUiOutputBudget.js";
import { artifactMcpResult, withArtifactMcp } from "./lib/artifact-e2e.mjs";
import {
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
  signalProcessWithStartIdentity,
} from "../dist/process/ProcessOwnershipObservation.js";
import {
  isProcessOwnershipInspectionCancellation,
  ProcessOwnershipInspectionCancelled,
} from "../dist/process/ProcessInspectionCancellation.js";
import { HOST_PLATFORM } from "../dist/platform/HostPlatform.js";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

if (HOST_PLATFORM.platform !== "darwin")
  throw new Error(
    "Native UI verification requires macOS, an interactive desktop and Xcode command-line tools",
  );
const rootFixture = await VerifierFixture.open({
  prefix: "rea-ui-fixture-",
  private: false,
});
const root = rootFixture.path;
const FIXTURE_READY_TIMEOUT_MS = 20_000;
const FIXTURE_EXIT_GRACE_MS = 10_000;
const startupRecord = z.strictObject({ pid: z.int().positive() });
const readyRecord = startupRecord.extend({ window_id: z.int().positive() });

const report = await withVerifierFixture(rootFixture, async () => {
  const childRetrievalTest = join(root, "child-retrieval-test");
  await promisify(execFile)("/usr/bin/xcrun", [
    "swiftc",
    fileURLToPath(
      new URL("../bridge/native/NativeUIChildren.swift", import.meta.url),
    ),
    fileURLToPath(
      new URL("../bridge/native/NativeUIValues.swift", import.meta.url),
    ),
    fileURLToPath(
      new URL(
        "../tests/conformance/native/native-ui-children/main.swift",
        import.meta.url,
      ),
    ),
    "-o",
    childRetrievalTest,
  ]);
  const childRetrieval = await promisify(execFile)(childRetrievalTest, []);
  const [slashRichProducerJson, numericProducerJson] = childRetrieval.stdout
    .trimEnd()
    .split("\n");
  if (
    slashRichProducerJson === undefined ||
    numericProducerJson === undefined
  ) {
    throw new Error(
      "Native UI serializer seam did not emit its producer bytes",
    );
  }
  const slashRichConsumerJson = JSON.stringify(
    JSON.parse(slashRichProducerJson),
  );
  if (slashRichProducerJson !== slashRichConsumerJson) {
    throw new Error(
      "Swift helper JSON bytes differ from the normalized JavaScript consumer representation",
    );
  }
  const numericConsumerJson = JSON.stringify(JSON.parse(numericProducerJson));
  if (
    Buffer.byteLength(numericProducerJson) <=
    Buffer.byteLength(numericConsumerJson)
  ) {
    throw new Error(
      "Foundation numeric fixture no longer exercises larger producer JSON bytes",
    );
  }
  if (Buffer.byteLength(numericProducerJson) > NATIVE_UI_HELPER_MAX_BUFFER) {
    throw new Error("Foundation numeric fixture exceeds the raw helper budget");
  }

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
  const scope = await waitForOwnedFixture(
    join(root, "Fixture.app"),
    coordinates,
    rootFixture,
  );
  const target = await parseBinaryTarget(executable);
  if (!target.ok) throw target.error;
  const observation = await observeNativeUi(
    target.value,
    "observe_native_ui",
    {
      ...scope,
    },
    { environment: process.env },
  );
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
        screenshot: false,
        steps: [
          { kind: "click", path: button.path },
          { kind: "wait", milliseconds: 200 },
        ],
      },
      { environment: process.env },
    );
    if (!scenario.ok) throw scenario.error;
    if (
      scenario.value.steps.some((step) => step.outcome !== "completed") ||
      !scenario.value.steps
        .at(-1)
        ?.after?.nodes.some(
          (node) => node.title === "REA fixture incremented 1",
        )
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
      evidence.normalized_result?.steps?.length !== 2 ||
      !evidence.normalized_result?.steps
        ?.at(-1)
        ?.after?.nodes.some(
          (node) => node.title === "REA fixture incremented 2",
        )
    )
      throw new Error(
        `Native UI CLI did not preserve the selected scenario: ${JSON.stringify(evidence.error ?? evidence.normalized_result?.steps?.map(({ outcome, reason }) => ({ outcome, reason })))}`,
      );
    scenarioStatus = "selected-AX-button-action-and-CLI-parity-observed";
    await withArtifactMcp(executable, async (client) => {
      const observed = await artifactMcpResult(client, "observe_native_ui", {
        ...scope,
        screenshot: false,
      });
      if (
        !observed.initial.nodes.some(
          (node) =>
            node.role === "AXButton" &&
            JSON.stringify(node.path) === JSON.stringify(button.path),
        )
      )
        throw new Error("MCP omitted the selected fixture's actual AX button");
      const captured = await artifactMcpResult(
        client,
        "capture_native_ui_scenario",
        {
          ...scope,
          screenshot: false,
          steps: [
            { kind: "click", path: button.path },
            { kind: "wait", milliseconds: 200 },
          ],
        },
      );
      if (
        captured.steps.length !== 2 ||
        captured.steps.some((step) => step.outcome !== "completed") ||
        !captured.steps
          .at(-1)
          ?.after?.nodes.some(
            (node) => node.title === "REA fixture incremented 3",
          )
      )
        throw new Error("MCP did not observe the selected fixture's AX action");
    });
    scenarioStatus = "selected-AX-button-action-and-CLI-MCP-parity-observed";
  }
  const mismatch = await observeNativeUi(
    { ...target.value, sha256: "0".repeat(64) },
    "observe_native_ui",
    scope,
    { environment: process.env },
  );
  // A selection failure carries its helper code in the issue, not in its message.
  if (
    mismatch.ok ||
    !mismatch.error.issues?.some(({ message }) =>
      message.startsWith("target-mismatch:"),
    )
  )
    throw new Error("Real helper did not reject changed target bytes");
  return {
    ok: true,
    verification_status: observation.ok ? "passed" : "permission-boundary-only",
    positive_e2e: observation.ok,
    observation: observation.ok
      ? "captured-selected-fixture-window"
      : "os-permission-denial-verified",
    scenario: scenarioStatus,
    permission_failure: observation.ok ? null : observation.error.message,
    mismatch_rejected: true,
    target_owned: true,
  };
});
process.stdout.write(`${JSON.stringify(report)}\n`);

/**
 * Each stage gives the native inspection owner its own cancellation budget.
 * Wait for admitted reads to settle so cancellation cannot orphan helper work.
 * @template T
 * @param {number} milliseconds
 * @param {(scope: { signal: AbortSignal, active: () => boolean }) => Promise<T>} observe
 * @returns {Promise<T | undefined>}
 */
async function beforeFixtureDeadline(milliseconds, observe) {
  const deadline = performance.now() + milliseconds;
  const signal = AbortSignal.timeout(milliseconds);
  const active = () => !signal.aborted && performance.now() < deadline;
  try {
    const result = await observe({ signal, active });
    return active() ? result : undefined;
  } catch (cause) {
    if (
      !isProcessOwnershipInspectionCancellation(cause) ||
      cause.reason !== signal.reason
    )
      throw cause;
    return undefined;
  }
}

/**
 * @param {(scope: { signal: AbortSignal, active: () => boolean }) =>
 *   Promise<{ pid: number, identity: string } | undefined>} identify
 */
async function stopOwnedFixture(identify) {
  return beforeFixtureDeadline(FIXTURE_EXIT_GRACE_MS, async (scope) => {
    const { signal, active } = scope;
    let signaled = false;
    while (active()) {
      const owner = await identify(scope);
      if (!active()) break;
      if (owner !== undefined) {
        const { pid, identity } = owner;
        const exit = await observeProcessStartIdentityExit(
          pid,
          identity,
          undefined,
          signal,
        );
        if (!active()) break;
        if (exit === "exited") return true;
        if (!signaled) {
          const outcome = await signalProcessWithStartIdentity(
            pid,
            identity,
            "SIGTERM",
            {
              inspectionSignal: signal,
              sendSignal: (checkedPid, action) => {
                if (!active())
                  throw new ProcessOwnershipInspectionCancelled(signal.reason);
                process.kill(checkedPid, action);
              },
            },
          );
          if (!active()) break;
          if (outcome === "gone" || outcome === "identity-changed") return true;
          signaled = outcome === "signaled";
        }
      }
      await delay(100);
    }
    return false;
  });
}

/**
 * The app announces its PID before AppKit starts. A different record names
 * its ready window. Only the app with the launch's token owns the fixture.
 * @param {string} bundle
 * @param {string} coordinates
 * @param {VerifierFixture} fixture
 */
async function waitForOwnedFixture(bundle, coordinates, fixture) {
  const token = randomUUID();
  const launcher = spawn(
    "/usr/bin/open",
    [
      "-W",
      "-n",
      "-g",
      "--stdout",
      coordinates,
      "--env",
      `REA_PROCESS_RUN_ID=${token}`,
      bundle,
    ],
    { stdio: "ignore" },
  );
  /** @type {Error | undefined} */
  let launcherFailure;
  const launcherExit = new Promise((resolve) => {
    launcher.once("exit", resolve);
    launcher.once("error", (cause) => {
      launcherFailure = cause;
      if (launcher.pid === undefined) resolve(undefined);
    });
  });
  /** @type {{ pid: number, identity: string } | undefined} */
  let owner;
  // A final unterminated row can still be in flight.
  const records = async () =>
    (await readFile(coordinates, "utf8")).split("\n").slice(0, -1);
  const identify = async (startup, { signal, active }) => {
    if (startup === undefined || owner !== undefined || !active()) return;
    const { pid } = startupRecord.parse(JSON.parse(startup));
    const identity = await observeProcessStartIdentity(
      pid,
      undefined,
      token,
      signal,
    );
    if (identity?.state === "readable" && active())
      owner = { pid, identity: identity.identity };
  };

  fixture.releaseAfter(async () => {
    if (launcherFailure !== undefined && launcher.pid === undefined) return;
    const exited = await stopOwnedFixture(async (scope) => {
      if (owner === undefined) await identify((await records())[0], scope);
      return owner;
    });
    if (!exited)
      throw new Error(
        `Source-owned UI fixture exit was not observed; retained ${fixture.path}`,
      );
  });
  fixture.releaseAfter(async () => {
    // The ChildProcess handle owns the launcher, regardless of app ownership.
    // Launcher completion does not establish anything about the app.
    if (
      launcher.exitCode === null &&
      launcher.signalCode === null &&
      launcher.pid !== undefined
    )
      launcher.kill("SIGTERM");
    const exited = await Promise.race([
      launcherExit.then(() => true),
      delay(FIXTURE_EXIT_GRACE_MS, false, { ref: false }),
    ]);
    if (!exited) {
      launcher.unref();
      throw new Error("Source-owned UI fixture launcher exit was not observed");
    }
  });

  const readyScope = await beforeFixtureDeadline(
    FIXTURE_READY_TIMEOUT_MS,
    async (scope) => {
      while (scope.active()) {
        if (launcherFailure !== undefined) throw launcherFailure;
        const [startup, ready] = await records();
        await identify(startup, scope);
        if (ready !== undefined && scope.active()) {
          const observed = readyRecord.parse(JSON.parse(ready));
          if (owner?.pid === observed.pid) return observed;
        }
        await delay(100);
      }
      return undefined;
    },
  );
  if (readyScope !== undefined) return readyScope;
  throw new Error(
    "Source-owned UI fixture failed to expose one authenticated window within 20 seconds",
  );
}
