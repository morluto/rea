import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import writeFileAtomic from "write-file-atomic";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "metadata/completion-manifest.json");
const check = process.argv.slice(2).includes("--check");
const unexpected = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check");
if (unexpected.length > 0)
  throw new Error(`Unknown argument: ${unexpected.join(" ")}`);

const artifactPaths = [
  "bridge/hopper_bridge.py",
  "package-lock.json",
  "scripts/verify-conformance-fixtures.mjs",
  "scripts/verify-package.mjs",
  "scripts/verify-real-hopper.mjs",
  "skills/rea-analysis/SKILL.md",
  "src/application/AnalysisProvider.ts",
  "src/application/ArtifactExtraction.ts",
  "src/application/ArtifactGraphConstruction.ts",
  "src/application/ArtifactInventory.ts",
  "src/application/CompositeProvider.ts",
  "src/application/EvidenceLedger.ts",
  "src/application/DirectAnalysis.ts",
  "src/application/ProcessSampling.ts",
  "src/application/ReferenceSourceImport.ts",
  "src/application/ReferenceSourceImportEntries.ts",
  "src/application/ReferenceSourceImportPolicy.ts",
  "src/application/ReferenceSourceImportTypes.ts",
  "src/application/ReferenceSourceVcsAdapter.ts",
  "src/application/RealHopperAssertions.ts",
  "src/application/runtime.ts",
  "src/contracts/nativeToolContracts.ts",
  "src/contracts/artifactToolContracts.ts",
  "src/contracts/artifactComparisonExample.ts",
  "src/contracts/functionComparisonExample.ts",
  "src/contracts/investigationExamples.ts",
  "src/contracts/toolContractExamples.ts",
  "src/contracts/processCaptureExample.ts",
  "src/contracts/enhancedInputs.ts",
  "src/contracts/toolContracts.ts",
  "src/contracts/toolOutputSchemas.ts",
  "src/contracts/unknownContractExamples.ts",
  "src/domain/evidence.ts",
  "src/domain/artifactGraph.ts",
  "src/domain/artifactComparison.ts",
  "src/domain/artifactInventoryEvidence.ts",
  "src/domain/functionComparison.ts",
  "src/domain/functionComparisonNormalization.ts",
  "src/domain/functionComparisonResults.ts",
  "src/domain/functionComparisonSchemas.ts",
  "src/domain/bundleComparison.ts",
  "src/domain/changedBehavior.ts",
  "src/domain/callPath.ts",
  "src/domain/staticRuntimeCorrelation.ts",
  "src/domain/reconstructionVerification.ts",
  "src/domain/reconstructionVerificationSchemas.ts",
  "src/domain/reconstructionUnknowns.ts",
  "src/domain/referenceSourceGraph.ts",
  "src/domain/referenceSourceClassification.ts",
  "src/domain/referenceSourceImportParsing.ts",
  "src/domain/referenceSourcePolicy.ts",
  "src/domain/functionDossierEvidence.ts",
  "src/domain/evidenceBundle.ts",
  "src/domain/nativeInspection.ts",
  "src/domain/processCapture.ts",
  "src/domain/residualUnknown.ts",
  "src/server/sessionToolPolicies.ts",
  "src/server/registerEnhancedTools.ts",
  "src/server/registerEvidenceTools.ts",
  "src/server/registerArtifactTools.ts",
  "src/server/registerArtifactComparisonTool.ts",
  "src/server/registerFunctionComparisonTool.ts",
  "src/server/registerBundleComparisonTool.ts",
  "src/server/registerInvestigationTools.ts",
  "src/server/recordDerivedEvidence.ts",
  "src/server/registerNativeTools.ts",
  "src/server/registerProcessComparisonTool.ts",
  "src/server/registerSessionTools.ts",
  "src/native/CommandRunner.ts",
  "src/native/NativeMacOSProvider.ts",
  "src/native/NativeMachoInspection.ts",
  "src/native/parsers/codesign.ts",
  "src/native/parsers/demangle.ts",
  "src/native/parsers/dyldInfo.ts",
  "src/native/parsers/lipo.ts",
  "src/native/parsers/otool.ts",
  "src/native/parsers/plist.ts",
  "src/artifacts/ArtifactPaths.ts",
  "src/artifacts/ArtifactProvider.ts",
  "src/artifacts/ArtifactReader.ts",
  "src/artifacts/AsarArtifactReader.ts",
  "src/artifacts/DirectoryArtifactReader.ts",
  "src/artifacts/MachOSliceArtifactReader.ts",
  "src/artifacts/SafeOutputTree.ts",
  "src/artifacts/StreamBytes.ts",
  "src/artifacts/ZipArtifactReader.ts",
  "src/reference/ReferenceSourceReaderEntries.ts",
  "src/reference/ReferenceSourceReaderErrors.ts",
  "src/reference/ReferenceSourceReaderFile.ts",
  "src/reference/ReferenceSourceReaderPaths.ts",
  "src/reference/ReferenceSourceReaderTypes.ts",
  "src/reference/ReferenceSourceReaderValidate.ts",
  "src/reference/ReferenceSourceReader.ts",
];

const artifacts = await Promise.all(
  artifactPaths.map(async (path) => ({
    path,
    sha256: sha256(await readFile(resolve(root, path))),
  })),
);
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const toolSource = await readFile(
  resolve(root, "src/contracts/toolContracts.ts"),
  "utf8",
);
const nativeToolSource = await readFile(
  resolve(root, "src/contracts/nativeToolContracts.ts"),
  "utf8",
);
const artifactToolSource = await readFile(
  resolve(root, "src/contracts/artifactToolContracts.ts"),
  "utf8",
);
const skillSource = await readFile(
  resolve(root, "skills/rea-analysis/SKILL.md"),
  "utf8",
);
const toolCount =
  countContracts(toolSource) +
  countProviderContracts(nativeToolSource, "NATIVE", "native") +
  countProviderContracts(artifactToolSource, "ARTIFACT", "artifact");
const skillToolCount = Number(/tool_count:\s*(\d+)/u.exec(skillSource)?.[1]);
if (!Number.isSafeInteger(skillToolCount) || skillToolCount !== toolCount)
  throw new Error(
    `Skill tool_count drift: skill=${String(skillToolCount)} contracts=${toolCount}`,
  );

const manifest = {
  schema_version: 1,
  inputs: {
    artifacts,
    package: { name: packageJson.name, version: packageJson.version },
    providers: [
      {
        id: "hopper",
        version: null,
        authority: "shipped-artifact",
      },
      {
        id: "native-macos",
        version: null,
        authority: "shipped-artifact",
      },
      {
        id: "rea-artifact-graph",
        version: "1",
        authority: "shipped-artifact",
      },
    ],
    environments: [
      { id: "package-isolation", isolation: "process" },
      { id: "real-hopper-macos", isolation: "process" },
    ],
    scenarios: [
      { id: "conformance-fixtures", version: 1 },
      { id: "package-install", version: 1 },
      { id: "real-hopper-two-binary", version: 2 },
    ],
    schemas: { evidence: 2, evidence_bundle: 2, completion: 1 },
    tool_count: toolCount,
  },
  evidence_index: [],
  outcomes: {
    pass: [],
    fail: [],
    unsupported: [
      {
        claim_id: "real-hopper-verification",
        reason:
          "Generated repository metadata contains no checked-in real-Hopper capture.",
        evidence_ids: [],
      },
    ],
    truncated: [],
    unknown: [
      {
        claim_id: "semantic-conformance-complete",
        reason:
          "Completion requires external verifier evidence and cannot be inferred from test counts.",
        evidence_ids: [],
      },
    ],
  },
};
validateOutcomeEvidence(manifest);
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  let existing;
  try {
    existing = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(
        `Missing generated manifest: ${relative(root, outputPath)}`,
      );
    throw error;
  }
  if (existing !== serialized)
    throw new Error(
      `Generated completion metadata is stale or tampered: run npm run completion:generate`,
    );
} else {
  await writeFileAtomic(outputPath, serialized, { encoding: "utf8" });
}

process.stdout.write(
  `${JSON.stringify({ mode: check ? "check" : "generate", path: relative(root, outputPath), toolCount })}\n`,
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countContracts(source) {
  const sections = [
    ["OFFICIAL", "official"],
    ["ENHANCED", "enhanced"],
    ["SESSION", "session"],
  ];
  return sections.reduce((total, [section, constructor]) => {
    const match = new RegExp(
      `export const ${section}_TOOL_CONTRACTS = \\[([\\s\\S]*?)\\n\\] as const satisfies`,
      "u",
    ).exec(source);
    if (match?.[1] === undefined)
      throw new Error(`Cannot derive ${section.toLowerCase()} tool contracts`);
    return (
      total +
      [...match[1].matchAll(new RegExp(`^  ${constructor}\\($`, "gmu"))].length
    );
  }, 0);
}

function countProviderContracts(source, section, constructor) {
  const match = new RegExp(
    `export const ${section}_TOOL_CONTRACTS = \\[([\\s\\S]*?)\\n\\] as const satisfies`,
    "u",
  ).exec(source);
  if (match?.[1] === undefined)
    throw new Error(`Cannot derive ${section.toLowerCase()} tool contracts`);
  return [...match[1].matchAll(new RegExp(`^  ${constructor}\\($`, "gmu"))]
    .length;
}

function validateOutcomeEvidence(value) {
  const evidenceIds = new Set(
    value.evidence_index.map(({ evidence_id }) => evidence_id),
  );
  for (const status of ["pass", "fail"]) {
    for (const outcome of value.outcomes[status]) {
      if (outcome.evidence_ids.length === 0)
        throw new Error(
          `${status} outcome ${outcome.claim_id} has no evidence`,
        );
      for (const evidenceId of outcome.evidence_ids)
        if (!evidenceIds.has(evidenceId))
          throw new Error(
            `${status} outcome ${outcome.claim_id} references missing evidence ${evidenceId}`,
          );
    }
  }
}
