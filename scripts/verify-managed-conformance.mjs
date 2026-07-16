import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import assert from "node:assert/strict";

import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";
import { inspectManagedArtifactBytes } from "../dist/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../dist/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../dist/dotnet/ManagedNativeBoundaryInspector.js";
import { compareManagedMemberPaths } from "../dist/application/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesEvidence } from "../dist/application/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../dist/application/ManagedReconstructionService.js";
import { planManagedRuntimeCorrelationEvidence } from "../dist/application/ManagedRuntimeCorrelationService.js";
import { projectManagedApplicationGraphEvidence } from "../dist/application/ManagedApplicationGraphService.js";
import { traceApplicationFeatureEvidence } from "../dist/application/JavaScriptApplicationWorkflowService.js";
import { createPermissionAuthority } from "../dist/application/PermissionAuthority.js";
import { MANAGED_STATIC_PROVIDER } from "../dist/application/InvestigationProviders.js";
import { createEvidence } from "../dist/domain/evidence.js";
import {
  alternateMvid,
  buildManagedPeFixture,
  buildNativePeFixture,
} from "./lib/managed-pe-fixture.mjs";

const inspectionLimits = {
  referenceOffset: 0,
  referenceLimit: 100,
  resourceOffset: 0,
  resourceLimit: 100,
  attributeOffset: 0,
  attributeLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

const memberLimits = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

const nativeBoundaryLimits = {
  moduleRefOffset: 0,
  moduleRefLimit: 100,
  importOffset: 0,
  importLimit: 100,
  implementationOffset: 0,
  implementationLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

const appManifestInspectionLimits = {
  ...inspectionLimits,
  maxMetadataBytes: 64 * 1024 * 1024,
  maxTableRows: 250_000,
  maxHeapItemBytes: 16 * 1024 * 1024,
};

const appManifestMemberLimits = {
  ...memberLimits,
  typeLimit: 1,
  methodLimit: 1,
  fieldLimit: 1,
  memberRefLimit: 1,
  edgeLimit: 1,
  maxMetadataBytes: 64 * 1024 * 1024,
  maxTableRows: 250_000,
  maxHeapItemBytes: 16 * 1024 * 1024,
  maxMethodBodyBytes: 4 * 1024 * 1024,
  maxMethodInstructions: 20_000,
};

const comparisonLimits = {
  max_method_matches: 100,
  max_field_matches: 100,
  max_candidates: 20,
};

const defaultIlBody = Buffer.from([
  0x32, 0x02, 0x7b, 0x01, 0x00, 0x00, 0x04, 0x28, 0x01, 0x00, 0x00, 0x0a, 0x2a,
]);

const workspace = await mkdtemp(join(tmpdir(), "rea-managed-conformance-"));

try {
  const modern = await fixture("modern-anycpu.exe", {
    references: ["System.Runtime"],
    resourceData: Buffer.from("source-owned managed resource"),
  });
  const modernArtifact = inspectManagedArtifactBytes(
    modern.bytes,
    modern.target,
    inspectionLimits,
  );
  assert.equal(modernArtifact.classification.status, "managed");
  assert.equal(modernArtifact.classification.runtime_family, "modern-dotnet");
  assert.equal(modernArtifact.classification.managed_architecture, "anycpu");
  assert.deepEqual(modernArtifact.target_frameworks, [
    ".NETCoreApp,Version=v8.0",
  ]);
  assert.equal(
    modernArtifact.resources.items[0]?.data_sha256,
    sha256(Buffer.from("source-owned managed resource")),
  );

  const framework = await fixture("framework-x86-pinvoke.exe", {
    cliFlags: 0x0000_0003,
    targetFramework: ".NETFramework,Version=v4.8",
    pinvoke: {
      moduleName: "user32.dll",
      importName: "MessageBoxW",
      mappingFlags: 0x0345,
    },
  });
  const frameworkArtifact = inspectManagedArtifactBytes(
    framework.bytes,
    framework.target,
    inspectionLimits,
  );
  assert.equal(
    frameworkArtifact.classification.runtime_family,
    "dotnet-framework",
  );
  assert.equal(frameworkArtifact.classification.managed_architecture, "x86");
  const frameworkBoundaries = inspectManagedNativeBoundariesBytes(
    framework.bytes,
    framework.target,
    nativeBoundaryLimits,
  );
  assert.equal(frameworkBoundaries.pinvoke_imports.total, 1);
  assert.equal(
    frameworkBoundaries.pinvoke_imports.items[0]?.verification,
    "managed-declaration-only",
  );
  assert.equal(
    frameworkBoundaries.pinvoke_imports.items[0]?.char_set,
    "unicode",
  );
  assert.equal(
    frameworkBoundaries.pinvoke_imports.items[0]?.call_convention,
    "stdcall",
  );
  const frameworkMembers = inspectManagedMembersBytes(
    framework.bytes,
    framework.target,
    memberLimits,
  );
  const frameworkArtifactEvidence = createEvidence(
    framework.target,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_artifact",
      parameters: inspectionLimits,
      result: frameworkArtifact,
      rawResult: null,
      limitations: frameworkArtifact.limitations,
      locations: [{ kind: "artifact-path", path: framework.target.path }],
    },
  );
  const frameworkMemberEvidence = createEvidence(
    framework.target,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_members",
      parameters: memberLimits,
      result: frameworkMembers,
      rawResult: null,
      limitations: frameworkMembers.limitations,
      locations: [{ kind: "artifact-path", path: framework.target.path }],
    },
  );
  const frameworkBoundaryEvidence = createEvidence(
    framework.target,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_native_boundaries",
      parameters: nativeBoundaryLimits,
      result: frameworkBoundaries,
      rawResult: null,
      limitations: frameworkBoundaries.limitations,
      locations: [{ kind: "artifact-path", path: framework.target.path }],
    },
  );
  const nativeFunctionEvidence = createEvidence(
    {
      path: "/system/user32.dll",
      sha256: "9".repeat(64),
      format: "pe",
      architecture: "x86",
    },
    {
      id: "ghidra",
      name: "Ghidra",
      version: "12.1.2",
    },
    {
      operation: "analyze_function",
      parameters: { procedure: "MessageBoxW" },
      result: functionDossier("MessageBoxW"),
      rawResult: null,
      limitations: [],
      locations: [{ kind: "address", address: "0x401000" }],
    },
  );
  const nativeVerification = verifyManagedNativeBoundariesEvidence({
    managed_boundaries: frameworkBoundaryEvidence,
    native_observations: [nativeFunctionEvidence],
    limits: {
      max_native_observations: 20,
      max_candidates_per_import: 25,
    },
  });
  assert.equal(nativeVerification.ok, true);
  assert.equal(nativeVerification.value.normalized_result.summary.verified, 1);
  const applicationGraph = projectManagedApplicationGraphEvidence({
    managed_artifact: frameworkArtifactEvidence,
    managed_members: frameworkMemberEvidence,
    managed_native_boundaries: frameworkBoundaryEvidence,
    limits: {
      max_types: 100,
      max_methods: 100,
      max_fields: 100,
      max_pinvoke_imports: 100,
      max_native_implementations: 100,
    },
  });
  assert.equal(applicationGraph.ok, true);
  assert.equal(
    applicationGraph.value.normalized_result.summary.pinvoke_imports,
    1,
  );
  assert.equal(
    applicationGraph.value.normalized_result.graph.nodes.some(
      ({ kind }) => kind === "managed-pinvoke-import",
    ),
    true,
  );
  const applicationTrace = traceApplicationFeatureEvidence({
    application: applicationGraph.value,
    native_observations: [],
    seed: {
      kind: "string",
      value: "MessageBoxW",
      match: "exact",
      case_sensitive: true,
    },
    direction: "incoming",
    limits: {
      max_seed_matches: 5,
      max_depth: 4,
      max_nodes: 50,
      max_edges: 100,
      max_paths: 10,
    },
  });
  assert.equal(applicationTrace.ok, true);
  assert.equal(
    applicationTrace.value.normalized_result.summary.matched_seeds,
    1,
  );

  const readyToRun = await fixture("r2r-x64.exe", {
    machine: 0x8664,
    readyToRun: true,
    methods: [
      {
        name: "NativeBody",
        implFlags: 0x0001,
        body: Buffer.from([0x2a]),
      },
    ],
  });
  const r2rArtifact = inspectManagedArtifactBytes(
    readyToRun.bytes,
    readyToRun.target,
    inspectionLimits,
  );
  assert.equal(r2rArtifact.pe.architecture, "x86_64");
  assert.equal(
    r2rArtifact.classification.implementation,
    "cil-and-ready-to-run",
  );
  const r2rBoundaries = inspectManagedNativeBoundariesBytes(
    readyToRun.bytes,
    readyToRun.target,
    nativeBoundaryLimits,
  );
  assert.equal(r2rBoundaries.summary.ready_to_run, true);
  assert.equal(
    r2rBoundaries.native_implementations.items[0]?.code_type,
    "native",
  );
  assert.equal(
    r2rBoundaries.native_implementations.items[0]?.boundary_kind,
    "native-body",
  );

  const obfuscated = await fixture("obfuscated.exe", {
    typeName: "ꙮType",
    methodName: "λ⛧",
    fieldName: "字段",
  });
  const obfuscatedMembers = inspectManagedMembersBytes(
    obfuscated.bytes,
    obfuscated.target,
    memberLimits,
  );
  assert.equal(obfuscatedMembers.types.items[0]?.full_name, "Fixture.ꙮType");
  assert.equal(obfuscatedMembers.methods.items[0]?.name, "λ⛧");
  assert.equal(obfuscatedMembers.fields.items[0]?.name, "字段");
  const runtimeExecutable = join(workspace, "dotnet");
  await writeFile(runtimeExecutable, "#!/bin/sh\n");
  const runtimeCeiling = {
    capability: "managed_runtime",
    roots: [workspace],
    executables: [runtimeExecutable],
    environment_names: [],
    network: "none",
    mount: false,
  };
  const runtimeAuthority = await createPermissionAuthority(
    [runtimeCeiling],
    [
      {
        ...runtimeCeiling,
        grant_id: "administrator:managed_runtime",
        lifetime: "administrator",
        operation_identity: null,
        expires_at: null,
      },
    ],
  );
  assert.equal(runtimeAuthority.ok, true);
  const runtimeMethod = obfuscatedMembers.methods.items[0];
  assert.ok(runtimeMethod);
  const obfuscatedMembersEvidence = createEvidence(
    undefined,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_members",
      parameters: { path: obfuscated.path },
      result: obfuscatedMembers,
      rawResult: null,
      limitations: obfuscatedMembers.limitations,
    },
  );
  const reconstructionImport = importManagedReconstructionEvidence({
    static_members: obfuscatedMembersEvidence,
    decompiler: {
      name: "ilspycmd",
      version: "9.1.0.7988",
      family: "ilspy",
      executable_sha256: null,
      options: ["--type", "Fixture.ꙮType"],
    },
    methods: [
      {
        token: runtimeMethod.token,
        signature_sha256: runtimeMethod.signature.raw_sha256,
        normalized_il_sha256: runtimeMethod.body.normalized_il_sha256,
        reconstruction: {
          kind: "decompiled-csharp",
          language: "csharp",
          text: "internal static void λ⛧() { /* synthetic fixture */ }",
        },
      },
    ],
    notes: ["source-owned synthetic decompiler reconstruction"],
  });
  assert.equal(reconstructionImport.ok, true);
  assert.equal(
    reconstructionImport.value.normalized_result.methods[0].validation
      .canonical_observation,
    false,
  );
  assert.equal(reconstructionImport.value.confidence, "inferred");
  const runtimePlan = await planManagedRuntimeCorrelationEvidence(
    {
      policy: {
        enabled: true,
        roots: [workspace],
        executablePath: runtimeExecutable,
      },
      authority: runtimeAuthority.value,
    },
    {
      static_members: obfuscatedMembersEvidence,
      method: {
        token: runtimeMethod.token,
        signature_sha256: runtimeMethod.signature.raw_sha256,
        normalized_il_sha256: runtimeMethod.body.normalized_il_sha256,
      },
      requested_effect: "debugger",
      host: {
        os: "linux",
        clr_family: "dotnet",
        architecture: "x86_64",
      },
      bounds: {
        timeout_ms: 5_000,
        max_threads: 32,
        max_output_bytes: 65_536,
        allow_network: false,
        allow_ui: false,
      },
    },
  );
  assert.equal(runtimePlan.ok, true);
  assert.equal(runtimePlan.value.normalized_result.executed, false);
  assert.equal(
    runtimePlan.value.normalized_result.authority_model.capability,
    "managed_runtime",
  );
  assert.equal(
    runtimePlan.value.normalized_result.effect_taxonomy.uses_debugger,
    true,
  );

  const left = await fixture("token-drift-left.exe", {
    methodName: "StableSemanticSlice",
  });
  const right = await fixture("token-drift-right.exe", {
    mvid: alternateMvid,
    methods: [
      { name: "InsertedHelper", body: Buffer.from([0x2a]) },
      { name: "RenamedSemanticSlice", body: defaultIlBody },
    ],
  });
  const comparison = await compareManagedMemberPaths({
    leftPath: left.path,
    rightPath: right.path,
    memberLimits: {
      maxFileBytes: 1024 * 1024,
      ...memberLimits,
    },
    comparisonLimits,
  });
  assert.equal(comparison.ok, true);
  const comparisonResult = comparison.value.normalized_result;
  assert.equal(comparisonResult.algorithm.name_matching, "not-used");
  assert.equal(comparisonResult.matching.exact_il_signature, 1);
  assert.equal(
    comparisonResult.methods.some(
      ({ left, right, match }) =>
        left.token === "0x06000001" &&
        right?.token === "0x06000002" &&
        match.basis === "exact-il-signature",
    ),
    true,
  );

  const nativeOnly = await fixtureBytes(
    "native-only.exe",
    buildNativePeFixture(),
  );
  const nativeResult = inspectManagedArtifactBytes(
    nativeOnly.bytes,
    nativeOnly.target,
    inspectionLimits,
  );
  assert.equal(nativeResult.classification.status, "not-managed");

  const malformed = await fixture("malformed-metadata.exe", {
    corruptMetadataSignature: true,
  });
  const malformedResult = inspectManagedArtifactBytes(
    malformed.bytes,
    malformed.target,
    inspectionLimits,
  );
  assert.equal(malformedResult.classification.status, "malformed");

  const manifestSelfTest = await runManagedAppManifestSelfTest();
  const operatorManifest = await runOptionalManagedAppManifest();

  process.stdout.write(
    `${JSON.stringify({
      verified: 12 + (operatorManifest === null ? 0 : 1),
      managedSurfaces: [
        "inspect_managed_artifact",
        "inspect_managed_members",
        "inspect_managed_native_boundaries",
        "compare_managed_members",
        "verify_managed_native_boundaries",
        "import_managed_reconstruction",
        "plan_managed_runtime_correlation",
        "project_managed_application_graph",
      ],
      coverage: [
        "modern-dotnet-anycpu",
        "dotnet-framework-x86-pinvoke",
        "x64-ready-to-run-native-body",
        "managed-native-verification",
        "managed-application-graph-projection",
        "unicode-obfuscated-identifiers",
        "decompiler-reconstruction-import",
        "runtime-correlation-admission-plan",
        "mvid-and-token-drift",
        "not-managed",
        "malformed-metadata",
        "operator-local-managed-manifest",
      ],
      managedAppManifest: {
        env: "REA_MANAGED_APP_MANIFEST_PATH",
        selfTest: manifestSelfTest,
        operator: operatorManifest ?? { configured: false },
      },
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function fixture(name, options) {
  return fixtureBytes(name, buildManagedPeFixture(options));
}

async function fixtureBytes(name, bytes) {
  const path = join(workspace, name);
  await writeFile(path, bytes);
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  return { bytes, path, target: parsed.value };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runManagedAppManifestSelfTest() {
  const sample = await fixture("manifest-self-test.exe", {
    methodName: "PinnedSemanticSlice",
    ilBody: defaultIlBody,
  });
  const artifact = inspectManagedArtifactBytes(
    sample.bytes,
    sample.target,
    inspectionLimits,
  );
  const members = inspectManagedMembersBytes(
    sample.bytes,
    sample.target,
    memberLimits,
  );
  const method = members.methods.items[0];
  assert.ok(method);
  const summary = await verifyManagedAppManifest(
    {
      schema_version: 1,
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
          normalized_il_sha256: method.body.normalized_il_sha256,
        },
      ],
    },
    join(workspace, "source-owned-managed-app-manifest.json"),
  );
  return {
    verified: true,
    assertions: summary.assertions,
    methods: summary.methods.length,
    target: summary.target,
  };
}

async function runOptionalManagedAppManifest() {
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
    ...(await verifyManagedAppManifest(manifest, resolvedManifestPath)),
  };
}

async function verifyManagedAppManifest(rawManifest, manifestPath) {
  const manifest = parseManagedAppManifest(rawManifest);
  const targetPath = isAbsolute(manifest.target.path)
    ? manifest.target.path
    : resolve(dirname(manifestPath), manifest.target.path);
  const parsedTarget = await parseBinaryTarget(targetPath);
  ensure(
    parsedTarget.ok,
    `target ${targetPath} could not be parsed as a binary target`,
  );
  const target = parsedTarget.value;
  ensure(
    target.sha256 === manifest.target.sha256,
    `target sha256 mismatch: expected ${manifest.target.sha256}, observed ${target.sha256}`,
  );
  const bytes = await readFile(targetPath);
  const artifact = inspectManagedArtifactBytes(
    bytes,
    target,
    appManifestInspectionLimits,
  );
  ensure(
    artifact.classification.status === "managed",
    `target is ${artifact.classification.status}, expected managed`,
  );
  if (manifest.target.mvid !== undefined)
    ensure(
      artifact.module?.mvid === manifest.target.mvid,
      `target MVID mismatch: expected ${manifest.target.mvid}, observed ${artifact.module?.mvid ?? "null"}`,
    );
  if (manifest.target.assembly_name !== undefined)
    ensure(
      artifact.assembly?.name === manifest.target.assembly_name,
      `assembly name mismatch: expected ${manifest.target.assembly_name}, observed ${artifact.assembly?.name ?? "null"}`,
    );
  if (manifest.target.runtime_family !== undefined)
    ensure(
      artifact.classification.runtime_family === manifest.target.runtime_family,
      `runtime family mismatch: expected ${manifest.target.runtime_family}, observed ${artifact.classification.runtime_family}`,
    );
  if (manifest.target.managed_architecture !== undefined)
    ensure(
      artifact.classification.managed_architecture ===
        manifest.target.managed_architecture,
      `managed architecture mismatch: expected ${manifest.target.managed_architecture}, observed ${artifact.classification.managed_architecture}`,
    );

  const methods = [];
  let assertions = 1;
  for (const expectedMethod of manifest.methods) {
    const method = inspectManagedMethodByToken(bytes, target, expectedMethod);
    ensure(
      method.signature.raw_sha256 === expectedMethod.signature_sha256,
      `method ${expectedMethod.token} signature sha256 mismatch: expected ${expectedMethod.signature_sha256}, observed ${method.signature.raw_sha256}`,
    );
    ensure(
      method.body.il_size === expectedMethod.il_size,
      `method ${expectedMethod.token} IL size mismatch: expected ${String(expectedMethod.il_size)}, observed ${String(method.body.il_size)}`,
    );
    ensure(
      method.body.normalized_il_sha256 === expectedMethod.normalized_il_sha256,
      `method ${expectedMethod.token} normalized IL sha256 mismatch: expected ${expectedMethod.normalized_il_sha256}, observed ${method.body.normalized_il_sha256 ?? "null"}`,
    );
    assertions += 4;
    methods.push({
      label: expectedMethod.label ?? null,
      token: method.token,
      declaring_type: method.declaring_type,
      name: method.name,
      signature_sha256: method.signature.raw_sha256,
      il_size: method.body.il_size,
      normalized_il_sha256: method.body.normalized_il_sha256,
    });
  }
  return {
    label: manifest.label ?? null,
    assertions,
    target: {
      file_name: basename(targetPath),
      sha256: target.sha256,
      mvid: artifact.module?.mvid ?? null,
      assembly_name: artifact.assembly?.name ?? null,
      runtime_family: artifact.classification.runtime_family,
      managed_architecture: artifact.classification.managed_architecture,
    },
    methods,
  };
}

function inspectManagedMethodByToken(bytes, target, expectedMethod) {
  const row = methodTokenRow(expectedMethod.token);
  const members = inspectManagedMembersBytes(bytes, target, {
    ...appManifestMemberLimits,
    methodOffset: row - 1,
  });
  const method = members.methods.items.find(
    ({ token }) => token === expectedMethod.token,
  );
  ensure(
    method !== undefined,
    `method ${expectedMethod.token} was not returned by the member inspector`,
  );
  ensure(
    method.body.status === "present",
    `method ${expectedMethod.token} body status is ${method.body.status}, expected present`,
  );
  return method;
}

function parseManagedAppManifest(rawManifest) {
  const manifest = object(rawManifest, "manifest");
  ensure(
    manifest.schema_version === 1,
    "manifest.schema_version must be exactly 1",
  );
  const target = object(manifest.target, "manifest.target");
  const methods = array(manifest.methods, "manifest.methods");
  ensure(manifest.methods.length > 0, "manifest.methods must not be empty");
  return {
    schema_version: 1,
    label: optionalString(manifest.label, "manifest.label"),
    target: {
      path: string(target.path, "manifest.target.path"),
      sha256: digest(target.sha256, "manifest.target.sha256"),
      mvid: optionalUuid(target.mvid, "manifest.target.mvid"),
      assembly_name: optionalString(
        target.assembly_name,
        "manifest.target.assembly_name",
      ),
      runtime_family: optionalString(
        target.runtime_family,
        "manifest.target.runtime_family",
      ),
      managed_architecture: optionalString(
        target.managed_architecture,
        "manifest.target.managed_architecture",
      ),
    },
    methods: methods.map((method, index) =>
      parseManagedAppManifestMethod(method, index),
    ),
  };
}

function parseManagedAppManifestMethod(rawMethod, index) {
  const prefix = `manifest.methods[${String(index)}]`;
  const method = object(rawMethod, prefix);
  const token = metadataToken(method.token, `${prefix}.token`);
  ensure(
    token.startsWith("0x06"),
    `${prefix}.token must be a MethodDef token beginning with 0x06`,
  );
  return {
    label: optionalString(method.label, `${prefix}.label`),
    token,
    signature_sha256: digest(
      method.signature_sha256,
      `${prefix}.signature_sha256`,
    ),
    il_size: ilSize(method, prefix),
    normalized_il_sha256: digest(
      method.normalized_il_sha256,
      `${prefix}.normalized_il_sha256`,
    ),
  };
}

function ilSize(method, prefix) {
  const hasIlSize = method.il_size !== undefined;
  const hasIlLength = method.il_length !== undefined;
  ensure(
    hasIlSize || hasIlLength,
    `${prefix}.il_size is required; il_length is accepted as a legacy alias`,
  );
  if (hasIlSize && hasIlLength)
    ensure(
      method.il_size === method.il_length,
      `${prefix}.il_size and ${prefix}.il_length disagree`,
    );
  const value = hasIlSize ? method.il_size : method.il_length;
  ensure(
    Number.isInteger(value) && value >= 0,
    `${prefix}.il_size must be a non-negative integer`,
  );
  return value;
}

function object(value, name) {
  ensure(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  return value;
}

function array(value, name) {
  ensure(Array.isArray(value), `${name} must be an array`);
  return value;
}

function string(value, name) {
  ensure(
    typeof value === "string" && value.length > 0,
    `${name} must be a non-empty string`,
  );
  return value;
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  return string(value, name);
}

function digest(value, name) {
  const text = string(value, name);
  ensure(/^[a-f0-9]{64}$/u.test(text), `${name} must be a lowercase sha256`);
  return text;
}

function optionalUuid(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = string(value, name);
  ensure(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      text,
    ),
    `${name} must be a lowercase GUID`,
  );
  return text;
}

function metadataToken(value, name) {
  const text = string(value, name);
  ensure(/^0x[0-9a-f]{8}$/u.test(text), `${name} must be a metadata token`);
  return text;
}

function methodTokenRow(token) {
  const row = Number.parseInt(token.slice(4), 16);
  ensure(row > 0, `method token ${token} has an invalid row id`);
  return row;
}

function ensure(condition, message) {
  if (!condition)
    throw new Error(`managed app manifest verification failed: ${message}`);
}

function functionDossier(name) {
  const emptyPage = {
    items: [],
    total: 0,
    returned: 0,
    truncated: false,
    next_offset: null,
  };
  return {
    procedure: {
      address: "0x401000",
      name,
      classification: {
        external: false,
        thunk: false,
        thunk_target: null,
        provenance: "synthetic-provider",
      },
      signature: null,
      locals: [],
    },
    pseudocode: {
      text: "",
      total_chars: 0,
      returned_chars: 0,
      truncated: false,
      next_offset: null,
    },
    assembly: emptyPage,
    comments: emptyPage,
    callers: emptyPage,
    callees: emptyPage,
    incoming_references: emptyPage,
    outgoing_references: emptyPage,
    referenced_strings: emptyPage,
    referenced_names: emptyPage,
    basic_blocks: emptyPage,
    instruction_scan: { scanned: 0, truncated: false },
    limitations: [],
  };
}
