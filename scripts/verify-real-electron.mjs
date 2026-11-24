#!/usr/bin/env node

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PlaywrightElectronActiveProvider } from "../dist/browser/PlaywrightElectronActiveProvider.js";
import { captureElectronScenario } from "../dist/application/javascript/ElectronActiveObservationService.js";
import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
} from "../dist/domain/javascript/electronActiveObservation.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import { verifyElectronToolContracts } from "./verify/electron/tool-contracts.mjs";

const executable = process.env.REA_ELECTRON_EXECUTABLE;
if (executable === undefined || executable.length === 0)
  throw new Error(
    "REA_ELECTRON_EXECUTABLE must identify the Electron executable for this verification lane",
  );

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
await verifyElectronToolContracts({ executable, repositoryRoot });
const fixtureApplicationRoot = join(
  repositoryRoot,
  "tests/conformance/readiness/electron",
);
const applicationRoot =
  process.env.REA_ELECTRON_APPLICATION_ROOT ?? fixtureApplicationRoot;
const applicationPath =
  process.env.REA_ELECTRON_APPLICATION_PATH ?? join(applicationRoot, "main.js");
const isReadinessFixture =
  applicationRoot === fixtureApplicationRoot &&
  applicationPath === join(fixtureApplicationRoot, "main.js");
const profile = await VerifierFixture.open({
  prefix: "rea-electron-readiness-",
  private: false,
});
const verifierRun = createVerifierRun();
const provider = new PlaywrightElectronActiveProvider(process.env);
profile.releaseAfter(() => provider.close());
const { input, capture } = await withVerifierFixture(profile, async () => {
  const input = electronActiveObservationInputSchema.parse({
    executable_path: executable,
    application_path: applicationPath,
    application_root: applicationRoot,
    ...(isReadinessFixture
      ? { args: [`--rea-verifier-profile=${profile.path}`] }
      : {}),
    actions: [
      { step_id: "ipc", kind: "click", selector: "#run", window_index: 0 },
      {
        step_id: "open-url",
        kind: "deep-link",
        delivery: "open-url",
        url: "rea-readiness://open-url",
      },
      {
        step_id: "second-instance",
        kind: "deep-link",
        delivery: "second-instance",
        url: "rea-readiness://second-instance",
      },
      { step_id: "renderer-reload", kind: "renderer-reload", window_index: 1 },
      { step_id: "renderer-crash", kind: "renderer-crash", window_index: 1 },
      {
        step_id: "settle-after-crash",
        kind: "wait",
        duration_ms: 250,
        window_index: 1,
      },
    ],
  });
  const result = await captureElectronScenario(provider, input);
  if (!result.ok) throw result.error;
  return {
    input,
    capture: electronActiveObservationResultSchema.parse(
      result.value.normalized_result,
    ),
  };
});
const crashAction = capture.actions.find(
  ({ kind }) => kind === "renderer-crash",
);
const crashedWindow = capture.windows.find(
  ({ window_id }) => window_id === crashAction?.target,
);

const output = {
  verifier_run: await completeVerifierRun(verifierRun),
  electron: capture.application,
  actions: capture.actions,
  processes: capture.processes,
  ipc: capture.ipc,
  timeline: capture.timeline,
  windows: capture.windows,
  verified:
    capture.coverage.status === "partial_attach" &&
    capture.actions.length === input.actions.length &&
    capture.actions.every(
      ({ step_id, status }, index) =>
        step_id === input.actions[index].step_id && status === "completed",
    ) &&
    capture.actions.some(
      ({ kind, window_index }) =>
        kind === "renderer-reload" && window_index === 1,
    ) &&
    capture.actions.some(
      ({ kind, window_index }) =>
        kind === "renderer-crash" && window_index === 1,
    ) &&
    capture.windows.length >= 2 &&
    capture.actions
      .filter(({ target }) => target !== null)
      .every(({ target }) =>
        capture.windows.some(({ window_id }) => window_id === target),
      ) &&
    crashedWindow !== undefined &&
    capture.timeline.events.some(
      ({ event, target }) =>
        event === "render-process-gone" &&
        target === crashedWindow.web_contents_id,
    ) &&
    capture.ipc.events.some(
      ({ kind, channel }) =>
        kind === "main-handler-invocation" && channel === "readiness:echo",
    ) &&
    capture.timeline.events.some(
      ({ kind, event, phase }) =>
        kind === "window-lifecycle" &&
        event === "created" &&
        phase === "completed",
    ) &&
    capture.timeline.events.some(
      ({ kind, event }) =>
        kind === "process-lifecycle" && event === "utility-process-fork",
    ) &&
    capture.timeline.events.some(
      ({ kind, event, phase }) =>
        kind === "shell-attempt" &&
        event === "openExternal" &&
        phase === "blocked",
    ) &&
    capture.timeline.events.some(
      ({ kind, event, phase }) =>
        kind === "preload" && event === "configured" && phase === "completed",
    ) &&
    capture.timeline.events.some(
      ({ kind, event }) =>
        kind === "protocol" &&
        (event === "open-url" || event === "second-instance"),
    ) &&
    capture.timeline.events.some(
      ({ kind, event }) =>
        kind === "process-lifecycle" && event === "child.spawn",
    ),
};
process.stdout.write(`${JSON.stringify(output)}\n`);
if (!output.verified)
  throw new Error(
    "real Electron verifier did not observe the readiness IPC round trip",
  );
