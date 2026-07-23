#!/usr/bin/env node

import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGhidraAnalysisProfile } from "../dist/ghidra/GhidraAnalysisProfile.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import { GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS } from "../dist/ghidra/GhidraDefaults.js";
import {
  GHIDRA_FUNCTION_OPERATIONS,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "../dist/ghidra/GhidraFunctionValues.js";
import {
  GHIDRA_INVENTORY_OPERATIONS,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "../dist/ghidra/GhidraInventoryValues.js";
import {
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_VERSION,
} from "../dist/ghidra/GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "../dist/ghidra/GhidraLauncher.js";
import { GHIDRA_PROVIDER_IDENTITY } from "../dist/ghidra/GhidraProvider.js";
import { GHIDRA_SESSION_CAPABILITIES as SESSION_CAPABILITIES } from "../dist/ghidra/GhidraSessionValues.js";
import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "The real Windows Ghidra verifier requires a Windows x64 host",
  );
const installDir = process.env.GHIDRA_INSTALL_DIR;
if (installDir === undefined || !isAbsolute(installDir))
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to the absolute root of Ghidra 12.1.2.",
  );
const installation = inspectGhidraInstallation({
  installDir,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (
  !installation.available ||
  installation.analyzeHeadlessPath === null ||
  installation.providerVersion !== SUPPORTED_GHIDRA_VERSION
)
  throw new Error(
    `Windows Ghidra installation is unavailable: ${JSON.stringify(installation)}`,
  );

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetPath = resolve(root, "build", "fixtures", "rea-ghidra-windows.exe");
const target = await parseBinaryTarget(targetPath);
if (
  !target.ok ||
  target.value.format !== "pe" ||
  target.value.architecture !== "x86_64" ||
  target.value.executableRole !== "application" ||
  target.value.managed !== false
)
  throw new Error(
    `Controlled Windows fixture failed admission: ${JSON.stringify(target)}`,
  );
const profile = await resolveGhidraAnalysisProfile(
  target.value,
  GHIDRA_PROVIDER_IDENTITY,
  installation,
);
if (!profile.ok || profile.value.profile === null)
  throw new Error("Windows Ghidra profile could not be committed");

const client = new GhidraClient({
  launcher: new GhidraHeadlessLauncher({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { javaHome: process.env.JAVA_HOME }),
    bridgeScriptPath: fileURLToPath(
      new URL("../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
    ),
    platform: "win32",
  }),
  targetPath: target.value.path,
  targetSha256: target.value.sha256,
  transport: "authenticated-loopback-tcp",
  providerVersion: SUPPORTED_GHIDRA_VERSION,
  profileDigest: profile.value.profile.digest,
  requestTimeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
});

let coordinates;
let report;
const observed = new Set();
try {
  const started = await client.start();
  if (!started.ok) throw started.error;
  assertSession(
    started.value,
    target.value.sha256,
    profile.value.profile.digest,
  );
  coordinates = client.diagnostics();
  assertRuntimeCoordinates(coordinates, target.value.sha256);

  const documents = await inventory("list_documents", {});
  const names = await inventory("list_names", {});
  const procedures = await inventory("list_procedures", {});
  const segments = await inventory("list_segments", {});
  const strings = await inventory("list_strings", {});
  if (
    !Array.isArray(documents) ||
    documents.length !== 1 ||
    !pageHasItems(procedures) ||
    !Array.isArray(segments) ||
    segments.length === 0 ||
    !isPage(names) ||
    !isPage(strings)
  )
    throw new Error("Windows Ghidra inventory proof was incomplete");
  const procedure = procedures.items.find(
    (item) => item.procedure?.external === false,
  );
  if (procedure === undefined)
    throw new Error("Windows Ghidra fixture exposed no local procedure");

  await inventory("address_name", { address: procedure.address });
  const resolvedAddress = await inventory("procedure_address", {
    procedure: procedure.value,
  });
  if (resolvedAddress !== procedure.address)
    throw new Error("Windows procedure name/address resolution drifted");
  await inventory("resolve_containing_procedure", {
    address: procedure.address,
  });
  await inventory("search_procedures", { pattern: procedure.value });
  await inventory("search_strings", { pattern: "rea" });

  for (const operation of [
    "procedure_assembly",
    "procedure_callees",
    "procedure_callers",
    "procedure_info",
    "procedure_pseudo_code",
    "read_function_instructions",
    "procedure_references",
  ])
    await functionOperation(operation, { procedure: procedure.value });
  await functionOperation("xrefs", { address: procedure.address });
  await functionOperation("analyze_function", {
    procedure: procedure.value,
    include_assembly: true,
  });

  const expected = [
    ...GHIDRA_INVENTORY_OPERATIONS,
    ...GHIDRA_FUNCTION_OPERATIONS,
  ];
  if (
    observed.size !== expected.length ||
    expected.some((operation) => !observed.has(operation))
  )
    throw new Error(
      `Windows Ghidra operation proof was incomplete: ${JSON.stringify([...observed])}`,
    );

  report = {
    ok: true,
    provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
    target: {
      format: target.value.format,
      architecture: target.value.architecture,
      executable_role: target.value.executableRole,
      managed: target.value.managed,
      sha256: target.value.sha256,
    },
    bridge_version: started.value.bridge_version,
    transport: "authenticated-loopback-tcp",
    operations: [...observed].sort((left, right) => left.localeCompare(right)),
    cleanup: "complete",
    limitations: [
      "approved-non-sensitive-fixtures-only",
      "no-job-object-ownership",
      "no-private-dacl-proof",
      "no-reparse-point-authority",
    ],
  };
} finally {
  await client.close();
  if (coordinates !== undefined) await assertCleanup(coordinates);
}
if (report === undefined)
  throw new Error("Windows Ghidra report was not produced");
process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), ...report })}\n`,
);

async function inventory(operation, parameters) {
  const input = parseGhidraInventoryInput(operation, parameters);
  if (!input.ok) throw input.error;
  const called = await client.callTool(operation, input.value);
  if (!called.ok) throw called.error;
  const result = parseGhidraInventoryResult(operation, called.value);
  if (!result.ok) throw result.error;
  observed.add(operation);
  return result.value;
}

async function functionOperation(operation, parameters) {
  const input = parseGhidraFunctionInput(operation, parameters);
  if (!input.ok) throw input.error;
  const called = await client.callTool(operation, input.value, {
    timeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  });
  if (!called.ok) throw called.error;
  const result = parseGhidraFunctionResult(operation, called.value);
  if (!result.ok) throw result.error;
  observed.add(operation);
  return result.value;
}

function assertSession(session, targetSha256, profileDigest) {
  if (
    session.provider.id !== "ghidra" ||
    session.provider.version !== SUPPORTED_GHIDRA_VERSION ||
    session.profile_digest !== profileDigest ||
    session.target.sha256 !== targetSha256 ||
    session.read_only !== true ||
    session.analysis_complete !== true ||
    session.analysis_timed_out !== false ||
    session.capabilities.join(",") !== SESSION_CAPABILITIES.join(",")
  )
    throw new Error(
      `Windows Ghidra session commitment drifted: ${JSON.stringify(session)}`,
    );
}

function assertRuntimeCoordinates(runtime, targetSha256) {
  if (
    runtime.transport !== "authenticated-loopback-tcp" ||
    runtime.target_sha256 !== targetSha256 ||
    typeof runtime.runtime_root !== "string" ||
    typeof runtime.endpoint_path !== "string" ||
    typeof runtime.project_root !== "string" ||
    typeof runtime.process_id !== "number"
  )
    throw new Error(
      `Windows Ghidra runtime coordinates are incomplete: ${JSON.stringify(runtime)}`,
    );
}

async function assertCleanup(runtime) {
  for (const name of ["runtime_root", "endpoint_path", "project_root"]) {
    const path = runtime[name];
    if (typeof path === "string" && (await exists(path)))
      throw new Error(`Windows Ghidra cleanup left ${name}: ${path}`);
  }
  if (
    typeof runtime.process_id === "number" &&
    processExists(runtime.process_id)
  )
    throw new Error(
      `Windows Ghidra cleanup left process ${String(runtime.process_id)}`,
    );
}

const isPage = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Array.isArray(value.items);

const pageHasItems = (value) => isPage(value) && value.items.length > 0;

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
