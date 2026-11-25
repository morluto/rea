import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { inspectManagedArtifactBytes } from "#dist/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "#dist/dotnet/ManagedMemberInspector.js";
import { importManagedReconstructionEvidence } from "#dist/application/managed/ManagedReconstructionService.js";
import { createEvidence } from "#dist/domain/evidence.js";
import { MANAGED_STATIC_PROVIDER } from "#dist/domain/investigationProviders.js";
import { managedReconstructionImportResultSchema } from "#dist/domain/managed/managedReconstruction.js";
import { verifyManagedAppManifest } from "./manifest.mjs";

/** @typedef {import("#dist/domain/binaryTargetTypes.js").BinaryTarget} BinaryTarget */
/** @typedef {import("#dist/domain/evidence.js").Evidence} Evidence */
/** @typedef {ReturnType<typeof inspectManagedMembersBytes>} ManagedMemberInspection */
/** @typedef {ManagedMemberInspection["methods"][number]} ManagedMethod */

/**
 * A source-owned managed fixture written into the verifier workspace.
 * @typedef {{
 *   readonly bytes: Buffer;
 *   readonly path: string;
 *   readonly target: BinaryTarget;
 * }} ManagedOracleFixture
 */

/**
 * What the oracles need from the conformance support.
 * @typedef {{
 *   readonly workspace: string;
 *   readonly defaultIlBody: Buffer;
 *   readonly fixture: (
 *     name: string,
 *     options: { readonly methodName: string; readonly ilBody?: Buffer },
 *   ) => Promise<ManagedOracleFixture>;
 *   readonly sha256: (bytes: Buffer) => string;
 * }} ManagedOracleContext
 */

/** @typedef {ManagedOracleContext & { readonly verifyManagedAppManifest: typeof verifyManagedAppManifest }} ManagedOracleSupport */

const execFileAsync = promisify(execFile);

/** @param {ManagedOracleContext} context */
export const createManagedConformanceOracleSupport = (context) => {
  const support = { ...context, verifyManagedAppManifest };
  return {
    runManagedAppManifestSelfTest: () => runManagedAppManifestSelfTest(support),
    runOptionalManagedAppManifest: () => runOptionalManagedAppManifest(support),
    runOptionalIlspyOracle: () => runOptionalIlspyOracle(support),
  };
};

/** @param {ManagedOracleSupport} context */
async function runManagedAppManifestSelfTest(context) {
  const sample = await context.fixture("manifest-self-test.exe", {
    methodName: "PinnedSemanticSlice",
    ilBody: context.defaultIlBody,
  });
  const artifact = inspectManagedArtifactBytes(sample.bytes, sample.target);
  const members = inspectManagedMembersBytes(sample.bytes, sample.target);
  const method = members.methods[0];
  assert.ok(method);
  const manifest = {
    label: "source-owned manifest verifier self-test",
    target: {
      path: sample.path,
      sha256: sample.target.sha256,
      mvid: artifact.module?.mvid,
      assembly_name: artifact.assembly?.name,
      runtime_family: artifact.classification.runtime_family,
      managed_architecture: artifact.classification.managed_architecture,
    },
    methods: [
      {
        label: "pinned-semantic-slice",
        token: method.token,
        signature_sha256: method.signature.raw_sha256,
        il_size: method.body.il_size,
        il_sha256: method.body.il_sha256,
        normalized_il_sha256: method.body.normalized_il_sha256,
      },
    ],
    application_graph: {
      expected_node_kinds: [
        "artifact",
        "managed-assembly",
        "managed-module",
        "managed-type",
        "managed-method",
      ],
      feature_traces: [
        {
          label: "trace pinned method by name",
          method_token: method.token,
          seed: "PinnedSemanticSlice",
          match: "exact",
          min_matched_seeds: 1,
        },
      ],
    },
  };
  const manifestPath = join(
    context.workspace,
    "source-owned-managed-app-manifest.json",
  );
  const summary = await context.verifyManagedAppManifest(
    manifest,
    manifestPath,
  );
  const rejectedMismatches = await verifyManifestRejections(
    context,
    manifest,
    manifestPath,
  );
  return {
    verified: true,
    rejected_mismatches: rejectedMismatches,
    assertions: summary.assertions,
    methods: summary.methods.length,
    applicationGraph: summary.application_graph ?? null,
    target: summary.target,
  };
}

/**
 * Each authored mismatch must be refused by the manifest verifier.
 * @param {ManagedOracleSupport} context
 * @param {object} manifest A manifest the verifier accepts.
 * @param {string} manifestPath
 */
async function verifyManifestRejections(context, manifest, manifestPath) {
  const refusals = [
    {
      label: "target sha256",
      owner: ["target"],
      key: "sha256",
      wrong: "0".repeat(64),
      expected: /target sha256 mismatch/u,
    },
    {
      label: "method token",
      owner: ["methods", 0],
      key: "token",
      wrong: "0x0600ffff",
      expected: /method 0x0600ffff was not returned/u,
    },
    {
      label: "signature sha256",
      owner: ["methods", 0],
      key: "signature_sha256",
      wrong: "0".repeat(64),
      expected: /signature sha256 mismatch/u,
    },
    {
      label: "IL size",
      owner: ["methods", 0],
      key: "il_size",
      wrong: 999,
      expected: /IL size mismatch/u,
    },
    {
      label: "IL sha256",
      owner: ["methods", 0],
      key: "il_sha256",
      wrong: "0".repeat(64),
      expected: /IL sha256 mismatch/u,
    },
    {
      label: "normalized IL sha256",
      owner: ["methods", 0],
      key: "normalized_il_sha256",
      wrong: "0".repeat(64),
      expected: /normalized IL sha256 mismatch/u,
    },
  ];
  for (const { label, owner: ownerPath, key, wrong, expected } of refusals) {
    const rejected = structuredClone(manifest);
    const owner = manifestField(rejected, ownerPath);
    assert.notEqual(
      owner[key],
      wrong,
      `${label} control must differ from the valid manifest`,
    );
    owner[key] = wrong;
    await assert.rejects(
      () => context.verifyManagedAppManifest(rejected, manifestPath),
      expected,
      `Manifest verifier accepted an authored wrong ${label}`,
    );
  }
  return refusals.map(({ label }) => label);
}

/**
 * The object or array at `path` inside a manifest.
 * @param {unknown} manifest
 * @param {readonly (string | number)[]} path
 */
function manifestField(manifest, path) {
  let field = manifest;
  for (const key of path) field = manifestObject(field, path)[key];
  return manifestObject(field, path);
}

/**
 * @param {unknown} value
 * @param {readonly (string | number)[]} path
 * @returns {Record<string | number, unknown>}
 */
function manifestObject(value, path) {
  assert.ok(
    typeof value === "object" && value !== null,
    `manifest has no object at ${path.join(".")}`,
  );
  return /** @type {Record<string | number, unknown>} */ (value);
}

/** @param {ManagedOracleSupport} context */
async function runOptionalManagedAppManifest(context) {
  const manifestPath = process.env.REA_MANAGED_APP_MANIFEST_PATH;
  if (manifestPath === undefined) return null;
  if (manifestPath.trim().length === 0)
    throw new Error("REA_MANAGED_APP_MANIFEST_PATH is set but empty");
  const resolvedManifestPath = resolve(process.cwd(), manifestPath);
  const text = await readFile(resolvedManifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `managed app manifest ${resolvedManifestPath} is not valid JSON: ${message}`,
    );
  }
  return {
    configured: true,
    ...(await context.verifyManagedAppManifest(manifest, resolvedManifestPath)),
  };
}

/** @param {ManagedOracleSupport} context */
async function runOptionalIlspyOracle(context) {
  const ilspyPath = process.env.REA_ILSPY_CMD_PATH;
  if (ilspyPath === undefined) return null;
  ensureIlspy(
    ilspyPath.trim().length > 0,
    "REA_ILSPY_CMD_PATH is set but empty",
  );
  ensureIlspy(
    isAbsolute(ilspyPath),
    "REA_ILSPY_CMD_PATH must be an absolute path",
  );
  await ensureExecutable(ilspyPath);
  const versionOutput = await runIlspy(ilspyPath, ["--version"], 64 * 1024);
  const version = ilspyVersion(versionOutput);
  const executableSha256 = context.sha256(await readFile(ilspyPath));
  const sample = await context.fixture("ilspy-oracle.exe", {
    methodName: "PinnedSemanticSlice",
  });
  const artifact = inspectManagedArtifactBytes(sample.bytes, sample.target);
  const members = inspectManagedMembersBytes(sample.bytes, sample.target);
  const method = members.methods[0];
  ensureIlspy(method !== undefined, "source-owned fixture has no method");
  const listOutput = await runIlspy(
    ilspyPath,
    ["--disable-updatecheck", "-l", "c", sample.path],
    256 * 1024,
  );
  ensureIlspy(
    listOutput.includes("Class Fixture.Program"),
    "ilspycmd class listing did not include Fixture.Program",
  );
  const csharp = await runIlspy(
    ilspyPath,
    ["--disable-updatecheck", "--type", "Fixture.Program", sample.path],
    256 * 1024,
  );
  ensureIlspy(
    csharp.includes("PinnedSemanticSlice"),
    "ilspycmd C# output did not include the pinned method name",
  );
  ensureIlspy(
    csharp.length <= 65_536,
    "ilspycmd C# output exceeded the managed reconstruction import bound",
  );
  const reconstruction = importIlspyReconstruction({
    sample,
    method,
    members,
    version,
    executableSha256,
    csharp,
  });
  const imported = managedReconstructionImportResultSchema.parse(
    reconstruction.normalized_result,
  );
  return {
    env: "REA_ILSPY_CMD_PATH",
    configured: true,
    version,
    executable_sha256: executableSha256,
    fixture: {
      file_name: basename(sample.path),
      sha256: sample.target.sha256,
      mvid: artifact.module?.mvid ?? null,
      assembly_name: artifact.assembly?.name ?? null,
      method: {
        token: method.token,
        declaring_type: method.declaring_type,
        name: method.name,
        signature_sha256: method.signature.raw_sha256,
        il_size: method.body.il_size,
        normalized_il_sha256: method.body.normalized_il_sha256,
      },
    },
    output: {
      class_listing_sha256: context.sha256(Buffer.from(listOutput)),
      decompiled_csharp_sha256: context.sha256(Buffer.from(csharp)),
      decompiled_csharp_bytes: Buffer.byteLength(csharp),
      imported_evidence_id: reconstruction.evidence_id,
      reconstruction_id: imported.reconstruction_id,
      canonical_observation:
        imported.methods[0]?.validation.canonical_observation ?? null,
      confidence_floor:
        imported.methods[0]?.validation.confidence_floor ?? null,
    },
  };
}

/**
 * Import the ilspycmd output as managed reconstruction Evidence.
 * @param {{
 *   readonly sample: ManagedOracleFixture;
 *   readonly method: ManagedMethod;
 *   readonly members: ManagedMemberInspection;
 *   readonly version: string;
 *   readonly executableSha256: string;
 *   readonly csharp: string;
 * }} input
 * @returns {Evidence}
 */
function importIlspyReconstruction({
  sample,
  method,
  members,
  version,
  executableSha256,
  csharp,
}) {
  const memberEvidence = createEvidence(
    sample.target,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_members",
      parameters: {},
      result: members,
      rawResult: null,
      limitations: members.limitations,
      locations: [{ kind: "artifact-path", path: sample.target.path }],
    },
  );
  const reconstructionImport = importManagedReconstructionEvidence({
    static_members: memberEvidence,
    decompiler: {
      name: "ilspycmd",
      version,
      family: "ilspy",
      executable_sha256: executableSha256,
      options: ["--disable-updatecheck", "--type", "Fixture.Program"],
    },
    methods: [
      {
        token: method.token,
        signature_sha256: method.signature.raw_sha256,
        normalized_il_sha256: method.body.normalized_il_sha256,
        reconstruction: {
          kind: "decompiled-csharp",
          language: "csharp",
          text: csharp,
        },
      },
    ],
    notes: [
      "source-owned real ilspycmd oracle; output is imported as reconstruction inference",
    ],
  });
  ensureIlspy(reconstructionImport.ok, "managed reconstruction import failed");
  const imported = managedReconstructionImportResultSchema.parse(
    reconstructionImport.value.normalized_result,
  );
  ensureIlspy(
    imported.summary.decompiled_csharp_methods === 1,
    "managed reconstruction import did not record one decompiled C# method",
  );
  return reconstructionImport.value;
}

/** @param {string} path */
async function ensureExecutable(path) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`managed ILSpy oracle failed: ${path} is not executable`);
  }
}

/**
 * @param {string} path
 * @param {readonly string[]} args
 * @param {number} maxBuffer
 */
async function runIlspy(path, args, maxBuffer) {
  try {
    const { stdout } = await execFileAsync(path, args, {
      timeout: 30_000,
      maxBuffer,
      env: {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      },
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`managed ILSpy oracle failed: ${message}`);
  }
}

/** @param {string} output */
function ilspyVersion(output) {
  const version = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("ilspycmd:"));
  ensureIlspy(
    version !== undefined,
    "ilspycmd --version did not identify ilspycmd",
  );
  return version;
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function ensureIlspy(condition, message) {
  if (!condition) throw new Error(`managed ILSpy oracle failed: ${message}`);
}
