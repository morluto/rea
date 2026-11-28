import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import { ANDROID_TOOL_CONTRACTS } from "../contracts/android/androidToolContracts.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";

/** Expose the same explicit APK requests through one-shot CLI commands. */
export const registerAndroidCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const provider = createAndroidAnalysisProvider(environment);
  const service = new AndroidAnalysisService(provider);
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
        rerunRecoversResult: delivery.rerunRecoversResult,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
      });
    };
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_jni_bindings"),
    {
      description:
        "Link raw DEX native declarations to static JNI export/table candidates without executing the APK",
      positionals: ["path"],
      fieldGroups: {
        query: {
          fields: [
            "class_name",
            "method_names",
            "descriptors",
            "abis",
            "library_paths",
          ],
          description:
            "JSON selection: class_name, method_names, descriptors, abis, library_paths; arrays preserve exact names",
          invalidJson: "query must be a JSON selection object.",
        },
      },
      fields: {
        view: {
          description:
            "JSON android-jni collection page; requires --detail summary and --evidence_output",
        },
      },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    run("inspect_android_jni_bindings"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_package"),
    {
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
      description: "Inspect one exact APK class's member inventory",
      positionals: ["path", "class_name"],
      fields: {
        view: {
          description:
            "JSON android-class methods, fields, inner-classes or mapping-symbols view; requires --detail summary and --evidence_output",
        },
      },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    run("inspect_android_class"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_android_method"),
    {
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
      description:
        "Trace APK using nodes for a defined class/method or an externally invoked DEX method",
      positionals: ["path", "class_name"],
      fields: {
        overload_index: {
          description:
            "Index among defined methods or observed external prototypes listed by an ambiguous query",
        },
        view: {
          description:
            "JSON android-references top-classes or references view; requires --detail summary and --evidence_output",
        },
      },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    run("trace_android_references"),
  );
};
