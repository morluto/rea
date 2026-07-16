import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";
import { inspectManagedArtifactBytes } from "../dist/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../dist/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../dist/dotnet/ManagedNativeBoundaryInspector.js";
import { compareManagedMemberPaths } from "../dist/application/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesEvidence } from "../dist/application/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../dist/application/ManagedReconstructionService.js";
import { planManagedRuntimeCorrelationEvidence } from "../dist/application/ManagedRuntimeCorrelationService.js";
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

  process.stdout.write(
    `${JSON.stringify({
      verified: 10,
      managedSurfaces: [
        "inspect_managed_artifact",
        "inspect_managed_members",
        "inspect_managed_native_boundaries",
        "compare_managed_members",
        "verify_managed_native_boundaries",
        "import_managed_reconstruction",
        "plan_managed_runtime_correlation",
      ],
      coverage: [
        "modern-dotnet-anycpu",
        "dotnet-framework-x86-pinvoke",
        "x64-ready-to-run-native-body",
        "managed-native-verification",
        "unicode-obfuscated-identifiers",
        "decompiler-reconstruction-import",
        "runtime-correlation-admission-plan",
        "mvid-and-token-drift",
        "not-managed",
        "malformed-metadata",
      ],
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
