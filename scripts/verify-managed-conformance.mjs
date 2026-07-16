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
      verified: 7,
      managedSurfaces: [
        "inspect_managed_artifact",
        "inspect_managed_members",
        "inspect_managed_native_boundaries",
        "compare_managed_members",
      ],
      coverage: [
        "modern-dotnet-anycpu",
        "dotnet-framework-x86-pinvoke",
        "x64-ready-to-run-native-body",
        "unicode-obfuscated-identifiers",
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
