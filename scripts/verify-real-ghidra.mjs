#!/usr/bin/env node

import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGhidraAnalysisProfile } from "../dist/ghidra/GhidraAnalysisProfile.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import {
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_VERSION,
} from "../dist/ghidra/GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "../dist/ghidra/GhidraLauncher.js";
import { GHIDRA_PROVIDER_IDENTITY } from "../dist/ghidra/GhidraProvider.js";
import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";

const installDir = process.env.GHIDRA_INSTALL_DIR;
if (installDir === undefined || !isAbsolute(installDir))
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to the absolute root of an extracted Ghidra 12.1.2 release.",
  );
const targetPath = process.env.GHIDRA_TARGET_PATH ?? "/usr/bin/true";
const installation = inspectGhidraInstallation({
  installDir,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (!installation.available || installation.analyzeHeadlessPath === null)
  throw new Error(
    `Ghidra installation is unavailable: ${JSON.stringify(installation)}`,
  );
if (installation.providerVersion !== SUPPORTED_GHIDRA_VERSION)
  throw new Error("Ghidra provider version commitment drifted");
const parsedTarget = await parseBinaryTarget(targetPath);
if (!parsedTarget.ok) throw parsedTarget.error;
const profile = await resolveGhidraAnalysisProfile(
  parsedTarget.value,
  GHIDRA_PROVIDER_IDENTITY,
  installation,
);
if (!profile.ok || profile.value.profile === null)
  throw new Error("Ghidra analysis profile could not be committed");

const client = new GhidraClient({
  launcher: new GhidraHeadlessLauncher({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { javaHome: process.env.JAVA_HOME }),
    bridgeScriptPath: fileURLToPath(
      new URL("../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
    ),
  }),
  targetPath: parsedTarget.value.path,
  providerVersion: SUPPORTED_GHIDRA_VERSION,
  profileDigest: profile.value.profile.digest,
});

let runtimeCoordinates;
let observedSession;
try {
  const started = await client.start();
  if (!started.ok) throw started.error;
  assertSession(started.value, profile.value.profile.digest);
  const pinged = await client.ping();
  if (!pinged.ok) throw pinged.error;
  assertSession(pinged.value, profile.value.profile.digest);
  observedSession = pinged.value;
  runtimeCoordinates = client.diagnostics();
  for (const name of ["runtime_root", "socket_path", "project_root"])
    if (typeof runtimeCoordinates[name] !== "string")
      throw new Error(`Ghidra verifier did not observe ${name}`);
  if (typeof runtimeCoordinates.process_id !== "number")
    throw new Error("Ghidra verifier did not observe its process ID");
} finally {
  await client.close();
}

if (runtimeCoordinates === undefined)
  throw new Error("Ghidra runtime coordinates were not captured");
if (observedSession === undefined)
  throw new Error("Ghidra session metadata was not captured");
for (const name of ["runtime_root", "socket_path", "project_root"]) {
  const path = runtimeCoordinates[name];
  if (typeof path === "string" && (await exists(path)))
    throw new Error(`Ghidra cleanup left ${name}: ${path}`);
}
const pid = runtimeCoordinates.process_id;
if (typeof pid === "number" && processExists(pid))
  throw new Error(`Ghidra cleanup left process ${String(pid)}`);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
    target_path: parsedTarget.value.path,
    target_sha256: parsedTarget.value.sha256,
    analysis_profile_digest: profile.value.profile.digest,
    language_id: observedSession.target.language_id,
    compiler_spec_id: observedSession.target.compiler_spec_id,
    cleanup: "complete",
  })}\n`,
);

function assertSession(session, expectedDigest) {
  if (
    session.provider.id !== "ghidra" ||
    session.provider.version !== SUPPORTED_GHIDRA_VERSION ||
    session.profile_digest !== expectedDigest ||
    session.read_only !== true ||
    session.analysis_complete !== true ||
    session.analysis_timed_out !== false ||
    session.capabilities.join(",") !== "ping,shutdown"
  )
    throw new Error(
      `Ghidra session commitment drifted: ${JSON.stringify(session)}`,
    );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
}
