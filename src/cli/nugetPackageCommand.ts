import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { NUGET_PACKAGE_TOOL_CONTRACTS } from "../contracts/nugetPackageToolContracts.js";
import {
  NUGET_PACKAGE_OPERATION as operation,
  NUGET_PACKAGE_PROVIDER,
} from "../domain/nugetPackage/nugetPackage.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerNugetPackageCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(NUGET_PACKAGE_TOOL_CONTRACTS, operation),
    {
      description:
        "Inspect the contents and .nuspec declarations of a local NuGet package (.nupkg) offline",
      positionals: ["path"],
      callerPaths: ["path"],
      // The contract fixes `format` to `nupkg`, and argv has no projection for
      // a literal, so the command leaves it to the contract's own value.
      omit: {
        format:
          "The contract fixes the package format; .nupkg is the only one admitted",
      },
      fields: { path: { description: "Local .nupkg path" } },
      // The command publishes the complete inventory or a summary beside its bundle.
      evidenceDelivery: true,
    },
    deliverWithService(createNugetPackageService, NUGET_PACKAGE_PROVIDER.id),
  );

/** One-shot package inspection that owns the file it opens. */
const createNugetPackageService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectNugetPackageEvidence } =
        await import("../application/nugetPackage/NugetPackageService.js");
      const inspected = await inspectNugetPackageEvidence(input, resources, {
        signal,
      });
      return inspected.ok
        ? { ok: true, value: inspected.value.evidence }
        : inspected;
    },
    close: () =>
      resources.close().catch((cause: unknown) => {
        throw projectArtifactCloseFailure(
          cause,
          NUGET_PACKAGE_PROVIDER.id,
          operation,
        );
      }),
  };
};
