import {
  instrumentJavaScriptExport,
  type JavaScriptExportInstrumentation,
} from "../domain/javascriptExportInstrumentation.js";
import type { NodeCharacterizationPreparationInput } from "../domain/nodeRuntimeCharacterization.js";
import type {
  JavaScriptReplayHost,
  ReplayExecutableIdentity,
  ReplayRuntimeFileIdentity,
  ReplaySourceBytes,
} from "./JavaScriptReplayPlanning.js";

/** Decorate one exact replay source with deterministic in-memory instrumentation. */
export class InstrumentedJavaScriptReplayHost implements JavaScriptReplayHost {
  instrumentation: JavaScriptExportInstrumentation | null = null;

  constructor(
    private readonly delegate: JavaScriptReplayHost,
    private readonly input: NodeCharacterizationPreparationInput["instrumentation"],
  ) {}

  async readSource(
    path: string,
    maximumBytes: number,
  ): Promise<ReplaySourceBytes> {
    const source = await this.delegate.readSource(path, maximumBytes);
    if (path !== this.input.artifact_path) return source;
    const instrumented = instrumentJavaScriptExport(source.bytes, this.input);
    if (instrumented.bytes.byteLength > maximumBytes)
      throw new RangeError(
        "Instrumented JavaScript exceeds the replay module byte limit",
      );
    this.instrumentation = instrumented;
    return { canonicalPath: source.canonicalPath, bytes: instrumented.bytes };
  }

  identifyExecutable(
    path: string,
    versionArguments: readonly string[],
  ): Promise<ReplayExecutableIdentity> {
    return this.delegate.identifyExecutable(path, versionArguments);
  }

  identifyWorker(): Promise<ReplayExecutableIdentity> {
    return this.delegate.identifyWorker();
  }

  identifyRuntimeClosure(
    nodePath: string,
  ): Promise<readonly ReplayRuntimeFileIdentity[]> {
    return this.delegate.identifyRuntimeClosure(nodePath);
  }

  seccompDigest(): string {
    return this.delegate.seccompDigest();
  }

  probe(policy: Parameters<JavaScriptReplayHost["probe"]>[0]): Promise<void> {
    return this.delegate.probe(policy);
  }
}
