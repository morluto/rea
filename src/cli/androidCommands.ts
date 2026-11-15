import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import { ANDROID_TOOL_CONTRACTS } from "../contracts/android/androidToolContracts.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
  parseCliAnalysisEvidenceDelivery,
} from "./analysisEvidenceDelivery.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import { parseAnalysisInput } from "../application/AnalysisInput.js";
import { androidJniSelectionSchema } from "../domain/android/androidJniBindings.js";
import { androidJniDeliverySchema } from "../domain/android/androidJniQuery.js";
import { androidInputSchemas } from "../domain/android/androidAnalysis.js";

/** Expose the same explicit APK requests through one-shot CLI commands. */
export const registerAndroidCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const provider = createAndroidAnalysisProvider(environment);
  const service = new AndroidAnalysisService(provider);
  const path = androidInputSchemas.inspect_android_package.shape.path;
  cli.command(CLI_COMMANDS.inspectAndroidJniBindings, {
    description:
      "Link raw DEX native declarations to static JNI export/table candidates without executing the APK",
    args: z.object({ path }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      query: z
        .string()
        .optional()
        .describe(
          "JSON selection: class_name, method_names, descriptors, abis, library_paths; arrays preserve exact names",
        ),
      view: z
        .string()
        .optional()
        .describe(
          "JSON android-jni collection page; requires --detail summary and --evidence_output",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectAndroidJniBindings,
          async () => {
            const operation = "inspect_android_jni_bindings";
            const delivery = parseCliAnalysisEvidenceDelivery(
              operation,
              options,
              androidJniDeliverySchema,
            );
            if (!delivery.ok) return projectAnalysisError(delivery.error);
            const decoded = parseCliJsonOption(
              operation,
              "query",
              options.query,
              "query must be a JSON selection object.",
            );
            if (!decoded.ok) return projectAnalysisError(decoded.error);
            const query = decoded.value === undefined ? {} : decoded.value;
            const selected = parseAnalysisInput(
              operation,
              query,
              androidJniSelectionSchema,
              signal,
            );
            if (!selected.ok) return projectAnalysisError(selected.error);
            return deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                service.execute(
                  operation,
                  { ...selected.value, path: args.path },
                  { signal },
                ),
              service: { close: () => provider.close() },
              providerId: "jadx",
              operation,
              signal,
              detail: delivery.value.detail,
              evidenceOutput: delivery.value.evidenceOutput,
              ...(delivery.value.view === undefined
                ? {}
                : { view: delivery.value.view }),
            });
          },
        ),
      ),
  });
  const contract = <Name extends AndroidOperation>(name: Name) =>
    contractNamed(ANDROID_TOOL_CONTRACTS, name);
  /**
   * Run one operation on the APK the caller selected and record that spelling
   * in Evidence. The contracts admit a relative APK path, which the provider
   * resolves from the working directory, so the CLI passes it on as spelled.
   * A command with Evidence delivery publishes complete Evidence or a summary
   * beside its bundle.
   */
  const run =
    (operation: AndroidOperation) =>
    (
      input: { readonly path: string },
      { signal, delivery }: ContractCommandContext,
    ) => {
      const analyze = () => service.execute(operation, input, { signal });
      const cleanup = { close: () => provider.close() };
      if (delivery === undefined)
        return finishCliEvidenceCommand(
          input.path,
          analyze,
          cleanup,
          "jadx",
          operation,
          signal,
        ).then(projectCliAnalysisResult);
      return deliverCliAnalysisEvidence({
        callerInputPath: input.path,
        run: analyze,
        service: cleanup,
        providerId: "jadx",
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
      });
    };
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_package"),
    {
      command: CLI_COMMANDS.inspectAndroidPackage,
      description:
        "Inspect APK declarations and decoded manifest without executing it",
      positionals: ["path"],
      fields: {
        view: {
          description:
            "JSON android manifest/components/component-summary view; requires --detail summary and --evidence_output",
        },
      },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    run("inspect_android_package"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("search_android_classes"),
    {
      command: CLI_COMMANDS.searchAndroidClasses,
      description:
        "Search APK class names; empty query inventories all classes",
      positionals: ["path", "query"],
    },
    run("search_android_classes"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_class"),
    {
      command: CLI_COMMANDS.inspectAndroidClass,
      description: "Inspect one exact APK class's member inventory",
      positionals: ["path", "class_name"],
      evidenceDelivery: true,
    },
    run("inspect_android_class"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_method"),
    {
      command: CLI_COMMANDS.inspectAndroidMethod,
      description: "Decompile one APK method with explicit overload selection",
      positionals: ["path", "class_name", "method_name"],
      fields: {
        method_name: { description: "Exact declared method name" },
        overload_index: {
          description:
            "Explicit zero-based index among same-name methods; required when ambiguous",
        },
      },
      evidenceDelivery: true,
    },
    run("inspect_android_method"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("trace_android_references"),
    {
      command: CLI_COMMANDS.traceAndroidReferences,
      description:
        "Trace APK using nodes for a defined class/method or an externally invoked DEX method",
      positionals: ["path", "class_name"],
      fields: {
        overload_index: {
          description:
            "Index among defined methods or observed external prototypes listed by an ambiguous query",
        },
      },
    },
    run("trace_android_references"),
  );
};
