#!/usr/bin/env node

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PlaywrightElectronActiveProvider } from "../dist/browser/PlaywrightElectronActiveProvider.js";
import { electronActiveObservationInputSchema } from "../dist/domain/electronActiveObservation.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const executable = process.env.REA_ELECTRON_EXECUTABLE;
if (executable === undefined || executable.length === 0)
  throw new Error(
    "REA_ELECTRON_EXECUTABLE must be an absolute path to an approved Electron executable",
  );

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const applicationRoot =
  process.env.REA_ELECTRON_APPLICATION_ROOT ??
  join(repositoryRoot, "tests/conformance/readiness/electron");
const applicationPath =
  process.env.REA_ELECTRON_APPLICATION_PATH ?? join(applicationRoot, "main.js");
const input = electronActiveObservationInputSchema.parse({
  schema_version: 1,
  executable_path: executable,
  application_path: applicationPath,
  application_root: applicationRoot,
  actions: [{ step_id: "ipc", kind: "click", selector: "#run" }],
  approved: true,
});
const verifierRun = createVerifierRun();
const result = await new PlaywrightElectronActiveProvider().capture(input);
if (!result.ok) throw result.error;

const output = {
  verifier_run: await completeVerifierRun(verifierRun),
  electron: result.value.application,
  actions: result.value.actions,
  processes: result.value.processes,
  ipc: result.value.ipc,
  windows: result.value.windows,
  verified:
    result.value.actions.every(({ status }) => status === "completed") &&
    result.value.ipc.events.some(
      ({ kind, channel }) =>
        kind === "main-handler-invocation" && channel === "readiness:echo",
    ),
};
if (!output.verified)
  throw new Error(
    "real Electron verifier did not observe the readiness IPC round trip",
  );
process.stdout.write(`${JSON.stringify(output)}\n`);
