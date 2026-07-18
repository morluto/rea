import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidence } from "../dist/domain/evidence.js";
import { buildManagedPeFixture } from "./lib/managed-pe-fixture.mjs";
import { functionDossier, json, run } from "./lib/verify-package-core.mjs";

const buildManagedFixtures = async (workspace) => {
  const managedPath = join(workspace, "managed-fixture.exe");
  const managedRightPath = join(workspace, "managed-fixture-right.exe");
  await Promise.all([
    writeFile(
      managedPath,
      buildManagedPeFixture({
        pinvoke: {
          moduleName: "user32.dll",
          importName: "MessageBoxW",
          mappingFlags: 0x0345,
        },
      }),
    ),
    writeFile(
      managedRightPath,
      buildManagedPeFixture({
        mvid: Buffer.from([
          0xde, 0xad, 0xbe, 0xef, 0x44, 0x33, 0x66, 0x55, 0xaa, 0xbb, 0xcc,
          0xdd, 0xee, 0xff, 0x11, 0x22,
        ]),
      }),
    ),
  ]);
  return { managedPath, managedRightPath };
};

const verifyManagedArtifact = async ({ cli, managedPath, environment }) => {
  const managedArtifact = json(
    await run(
      cli,
      ["inspect-managed-artifact", managedPath, "--json"],
      environment,
    ),
  );
  if (
    managedArtifact.operation !== "inspect_managed_artifact" ||
    managedArtifact.provider?.id !== "rea-dotnet-static" ||
    managedArtifact.normalized_result?.classification?.status !== "managed"
  )
    throw new Error("packaged managed artifact CLI failed");
  return managedArtifact;
};

const verifyManagedMembers = async ({ cli, managedPath, environment }) => {
  const managedMembers = json(
    await run(
      cli,
      ["inspect-managed-members", managedPath, "--json"],
      environment,
    ),
  );
  if (
    managedMembers.operation !== "inspect_managed_members" ||
    managedMembers.normalized_result?.methods?.total !== 1
  )
    throw new Error("packaged managed member CLI failed");
  return managedMembers;
};

const verifyManagedReconstruction = async ({
  cli,
  managedMembers,
  managedMethod,
  environment,
}) => {
  const managedReconstructionInput = {
    static_members: managedMembers,
    decompiler: {
      name: "ilspycmd",
      version: "9.1.0.7988",
      family: "ilspy",
      executable_sha256: null,
      options: ["--type", "Fixture.Program"],
    },
    methods: [
      {
        token: managedMethod.token,
        signature_sha256: managedMethod.signature.raw_sha256,
        normalized_il_sha256: managedMethod.body.normalized_il_sha256,
        reconstruction: {
          kind: "decompiled-csharp",
          language: "csharp",
          text: "internal static void Main() { }",
        },
      },
    ],
    notes: ["packaged synthetic reconstruction import"],
  };
  const managedReconstruction = json(
    await run(
      cli,
      [
        "import-managed-reconstruction",
        JSON.stringify(managedReconstructionInput),
        "--json",
      ],
      environment,
    ),
  );
  if (
    managedReconstruction.operation !== "import_managed_reconstruction" ||
    managedReconstruction.provider?.id !== "rea-dotnet-workflows" ||
    managedReconstruction.normalized_result?.executed !== false ||
    managedReconstruction.normalized_result?.methods?.[0]?.validation
      ?.canonical_observation !== false
  )
    throw new Error("packaged managed reconstruction import CLI failed");
};

const verifyManagedRuntimePlan = async ({
  cli,
  managedMembers,
  managedMethod,
  workspace,
  environment,
}) => {
  const managedRuntimePlanInput = {
    static_members: managedMembers,
    method: {
      token: managedMethod.token,
      signature_sha256: managedMethod.signature.raw_sha256,
      normalized_il_sha256: managedMethod.body.normalized_il_sha256,
    },
    requested_effect: "attach",
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
  };
  const managedRuntimePlan = json(
    await run(
      cli,
      [
        "plan-managed-runtime-correlation",
        JSON.stringify(managedRuntimePlanInput),
        "--json",
      ],
      {
        ...environment,
        REA_MANAGED_RUNTIME_ENABLED: "true",
        REA_MANAGED_RUNTIME_ROOTS_JSON: JSON.stringify([workspace]),
        REA_MANAGED_RUNTIME_EXECUTABLE_PATH: process.execPath,
      },
    ),
  );
  if (
    managedRuntimePlan.operation !== "plan_managed_runtime_correlation" ||
    managedRuntimePlan.provider?.id !== "rea-dotnet-workflows" ||
    managedRuntimePlan.normalized_result?.executed !== false ||
    managedRuntimePlan.normalized_result?.authority_model?.capability !==
      "managed_runtime" ||
    managedRuntimePlan.normalized_result?.effect_taxonomy?.attaches_process !==
      true ||
    managedRuntimePlan.normalized_result?.effect_taxonomy
      ?.invokes_target_code !== false
  )
    throw new Error("packaged managed runtime-correlation CLI failed");
};

const verifyManagedBoundaries = async ({ cli, managedPath, environment }) => {
  const managedBoundaries = json(
    await run(
      cli,
      ["inspect-managed-native-boundaries", managedPath, "--json"],
      environment,
    ),
  );
  if (
    managedBoundaries.operation !== "inspect_managed_native_boundaries" ||
    managedBoundaries.normalized_result?.pinvoke_imports?.total !== 1 ||
    managedBoundaries.normalized_result?.pinvoke_imports?.items?.[0]
      ?.verification !== "managed-declaration-only"
  )
    throw new Error("packaged managed native-boundary CLI failed");
  return managedBoundaries;
};

const verifyManagedApplicationGraph = async ({
  cli,
  managedArtifact,
  managedMembers,
  managedBoundaries,
  environment,
}) => {
  const managedApplicationGraphInput = {
    managed_artifact: managedArtifact,
    managed_members: managedMembers,
    managed_native_boundaries: managedBoundaries,
    limits: {
      max_types: 100,
      max_methods: 100,
      max_fields: 100,
      max_pinvoke_imports: 100,
      max_native_implementations: 100,
    },
  };
  const managedApplicationGraph = json(
    await run(
      cli,
      [
        "project-managed-application-graph",
        JSON.stringify(managedApplicationGraphInput),
        "--json",
      ],
      environment,
    ),
  );
  if (
    managedApplicationGraph.operation !== "project_managed_application_graph" ||
    managedApplicationGraph.provider?.id !== "rea-dotnet-workflows" ||
    managedApplicationGraph.confidence !== "inferred" ||
    managedApplicationGraph.normalized_result?.summary?.pinvoke_imports !== 1 ||
    managedApplicationGraph.normalized_result?.graph?.schema !==
      "JavaScriptApplicationGraph" ||
    !managedApplicationGraph.normalized_result?.graph?.nodes?.some(
      ({ kind }) => kind === "managed-pinvoke-import",
    )
  )
    throw new Error("packaged managed application-graph CLI failed");
};

const verifyManagedNativeVerification = async ({
  cli,
  managedBoundaries,
  environment,
}) => {
  const managedNativeVerificationInput = {
    managed_boundaries: managedBoundaries,
    native_observations: [
      createEvidence(
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
      ),
    ],
    limits: {
      max_native_observations: 20,
      max_candidates_per_import: 25,
    },
  };
  const managedNativeVerification = json(
    await run(
      cli,
      [
        "verify-managed-native-boundaries",
        JSON.stringify(managedNativeVerificationInput),
        "--json",
      ],
      environment,
    ),
  );
  if (
    managedNativeVerification.operation !==
      "verify_managed_native_boundaries" ||
    managedNativeVerification.provider?.id !== "rea-dotnet-workflows" ||
    managedNativeVerification.normalized_result?.summary?.verified !== 1 ||
    managedNativeVerification.normalized_result?.algorithm
      ?.token_to_address_mapping !== "not-inferred"
  )
    throw new Error("packaged managed/native verification CLI failed");
};

const verifyManagedComparison = async ({
  cli,
  managedPath,
  managedRightPath,
  environment,
}) => {
  const managedComparison = json(
    await run(
      cli,
      ["compare-managed-members", managedPath, managedRightPath, "--json"],
      environment,
    ),
  );
  if (
    managedComparison.operation !== "compare_managed_members" ||
    managedComparison.provider?.id !== "rea-dotnet-workflows" ||
    managedComparison.normalized_result?.algorithm?.name_matching !== "not-used"
  )
    throw new Error("packaged managed comparison CLI failed");
};

/** Exercise all packaged managed static and workflow CLIs. */
export async function verifyManaged({ cli, workspace, environment }) {
  const { managedPath, managedRightPath } =
    await buildManagedFixtures(workspace);
  const managedArtifact = await verifyManagedArtifact({
    cli,
    managedPath,
    environment,
  });
  const managedMembers = await verifyManagedMembers({
    cli,
    managedPath,
    environment,
  });
  const managedMethod = managedMembers.normalized_result.methods.items[0];
  await verifyManagedReconstruction({
    cli,
    managedMembers,
    managedMethod,
    environment,
  });
  await verifyManagedRuntimePlan({
    cli,
    managedMembers,
    managedMethod,
    workspace,
    environment,
  });
  const managedBoundaries = await verifyManagedBoundaries({
    cli,
    managedPath,
    environment,
  });
  await verifyManagedApplicationGraph({
    cli,
    managedArtifact,
    managedMembers,
    managedBoundaries,
    environment,
  });
  await verifyManagedNativeVerification({
    cli,
    managedBoundaries,
    environment,
  });
  await verifyManagedComparison({
    cli,
    managedPath,
    managedRightPath,
    environment,
  });
}
