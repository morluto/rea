import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type {
  ApktoolRequest,
  ApktoolOperation,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import { createApktoolResourceAnalysisService } from "../application/ProviderOperationServices.js";
import { createApktoolResourceAnalysisProvider } from "../composition/apktool.js";
import { APKTOOL_TOOL_CONTRACTS } from "../contracts/apktool/apktoolToolContracts.js";
import type { Logger } from "pino";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  analyzeWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import type { CliInstance } from "./types.js";

/** Expose the same explicit Apktool requests through one-shot CLI commands. */
export const registerApktoolCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: RequestAnalysisPort<ApktoolRequest> = createApktoolResourceAnalysisProvider(
    environment,
  ),
): void => {
  const service = createApktoolResourceAnalysisService(provider);
  const run =
    (operation: ApktoolOperation) => (): EvidenceInspectionService => ({
      inspect: (input, { signal }) =>
        service.execute(operation, input, { signal }),
      close: () => provider.close(),
    });

  registerContractCommand(
    cli,
    logger,
    contractNamed(APKTOOL_TOOL_CONTRACTS, "inspect_apktool_client"),
    {
      description:
        "Inspect the caller-selected apktool launcher without decoding anything",
    },
    analyzeWithService(run("inspect_apktool_client"), "apktool"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(APKTOOL_TOOL_CONTRACTS, "decode_android_resources"),
    {
      description:
        "Decode one APK's manifest, metadata, and string resources with apktool",
      // The contract admits a relative path, resolved by the provider from
      // the working directory, so the CLI passes it on as spelled.
      positionals: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        include_strings: {
          name: "strings",
          description:
            "Include string resources; use --no-strings to skip projecting them",
        },
        locales: {
          description:
            "Repeat to project multiple localized string tables, e.g. --locales de --locales pt-BR",
        },
        view: {
          description:
            "JSON android-resources strings or manifest view; requires --detail summary and --evidence_output",
        },
      },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    (input, { operation, signal, delivery }) => {
      // Delivery fields select the reply; the decode takes the rest.
      const owned = run("decode_android_resources")();
      const analyze = () => owned.inspect(input, { signal });
      if (delivery === undefined)
        return finishCliEvidenceCommand(
          input.path,
          analyze,
          owned,
          "apktool",
          operation,
          signal,
        ).then(projectCliAnalysisResult);
      return deliverCliAnalysisEvidence({
        callerInputPath: input.path,
        run: analyze,
        service: owned,
        providerId: "apktool",
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
      });
    },
  );
};
