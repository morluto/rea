import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactResourceRetryFailure } from "../../artifacts/ArtifactResourceScope.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import type { BuildSource } from "../../domain/desktop/appBuild.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import {
  isScannableSecret,
  MAX_SETTING_CHARACTERS,
  redactSecrets,
  redactSecretsInJson,
  type KnownSecret,
} from "../../domain/desktop/buildSecrets.js";
import {
  redactCredentials,
  redactCredentialsInJson,
} from "../../domain/desktop/credentialPatterns.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AgentEnvComputer,
  DriverResult,
} from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  listBuildSecretHandles,
  readBuildSecretFile,
  writeBuildSecretFile,
} from "../../desktop/BuildSecretFiles.js";

const ACT = "act_on_build_computer";

/** The secrets one REA server types, kept only in memory so results, logs and records can show their handles instead. */
export class DesktopBuildSecrets {
  /** Every value each handle named while this server ran, an earlier one still held by the app after the person changed it. */
  readonly #seen = new Map<string, Set<string>>();
  readonly #resources = new ArtifactResourceScope();

  constructor(readonly directory: string) {}

  #cleanupFailure(cause: ArtifactResourceRetryFailure): AnalysisError {
    const error = new ProviderAdapterError(
      AGENTENV_PROVIDER,
      "build_secret_file",
      {
        userMessage: "Could not close retained build secret files.",
        cleanup: {
          reason: "Secret file close failed.",
          resources: cause.cleanup?.resources ?? [],
        },
      },
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.#resources.run(operation);
    } catch (cause: unknown) {
      if (cause instanceof ArtifactResourceRetryFailure)
        throw this.#cleanupFailure(cause);
      throw cause;
    }
  }

  /** A handle's value, read afresh from its file, a setting's up to a withheld file's size, even empty; a refusal names the file, never its text. */
  async resolve(
    handle: string,
    use: "typed" | "setting" = "typed",
  ): Promise<Result<string, string | AnalysisError>> {
    let read: Result<string, string>;
    try {
      read = await this.#run(() =>
        readBuildSecretFile(this.directory, handle, {
          ...(use === "setting"
            ? { maxCharacters: MAX_SETTING_CHARACTERS, minCharacters: 0 }
            : {}),
          resources: this.#resources,
          onCloseFailureValue: (value) => this.#remember(handle, value),
        }),
      );
    } catch (cause: unknown) {
      if (cause instanceof AnalysisError) return err(cause);
      throw cause;
    }
    if (read.ok) this.#remember(handle, read.value);
    return read;
  }

  /** Keep a withheld file's bytes, in base64, as the secret `handle` names, for a witness to supply. */
  async keep(handle: string, bytes: Buffer): Promise<void> {
    const value = bytes.toString("base64");
    this.#remember(handle, value);
    await this.#run(() =>
      writeBuildSecretFile(this.directory, handle, value, this.#resources),
    );
  }

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (cause instanceof ArtifactResourceRetryFailure)
        throw this.#cleanupFailure(cause);
      throw cause;
    }
  }

  #remember(handle: string, value: string): void {
    if (!isScannableSecret(value)) return;
    const values = this.#seen.get(handle) ?? new Set<string>();
    values.add(value);
    this.#seen.set(handle, values);
  }

  #known(): KnownSecret[] {
    return [...this.#seen].flatMap(([handle, values]) =>
      [...values].map((value) => ({ handle, value })),
    );
  }

  /** Text with each typed secret's value replaced by its handle, and each credential found by its shape by its kind. */
  readonly redact = (text: string): string =>
    redactCredentials(
      this.#seen.size === 0 ? text : redactSecrets(text, this.#known()),
    );

  /** A JSON value redacted as `redact` redacts text. */
  readonly redactJson = (value: JsonValue): JsonValue =>
    redactCredentialsInJson(redactSecretsInJson(value, this.#known()));

  /** Every secret no bundle may hold: each value typed or kept here, then each the folder holds now, readable by others or not. */
  async all(): Promise<KnownSecret[]> {
    const handles = await listBuildSecretHandles(this.directory);
    const read: { handle: string; file: Result<string, string> }[] = [];
    for (const handle of handles)
      read.push({
        handle,
        file: await this.#run(() =>
          readBuildSecretFile(this.directory, handle, {
            searchOnly: true,
            maxCharacters: MAX_SETTING_CHARACTERS,
            resources: this.#resources,
            onCloseFailureValue: (value) => this.#remember(handle, value),
          }),
        ),
      });
    const known = this.#known();
    const held = new Set(
      known.map(({ handle, value }) => `${handle}\0${value}`),
    );
    return [
      ...known,
      ...read.flatMap(({ handle, file }) =>
        file.ok && !held.has(`${handle}\0${file.value}`)
          ? [{ handle, value: file.value }]
          : [],
      ),
    ];
  }
}

/** Why a secret was not typed, in REA's words and without its cause: the computer's own could quote the secret. */
const notTyped = (handle: string, signal: AbortSignal): AnalysisError =>
  signal.aborted
    ? new AnalysisCancelledError(ACT, { cause: signal.reason })
    : new ProviderAdapterError(AGENTENV_PROVIDER, ACT, {
        userMessage: `The computer did not type the secret ${handle}; REA does not show its answer, which could quote the secret.`,
        remediationAction:
          "Take a screenshot to see where the focus is, click into the field, and type the secret again; if it fails again, ask the person to check that the secret's file holds only characters a keyboard types.",
      });

/** What a driver's answer to a typed secret may show: whether and how it was delivered, never its own words. */
const delivered = (
  handle: string,
  structured: DriverResult["structured"],
): Readonly<Record<string, JsonValue>> => ({
  summary: `Typed the secret ${handle}`,
  ...Object.fromEntries(
    ["applied", "delivery", "others_since_frame"].flatMap((field) => {
      const value = structured?.[field];
      return value === undefined ? [] : [[field, value]];
    }),
  ),
});

/** What a typed secret's action answers: its place in the log and REA's own result, never the driver's words. */
interface TypedSecret {
  readonly value: {
    readonly computer_id: string;
    readonly action: "type_secret";
    readonly action_index: number;
    readonly result: Readonly<Record<string, JsonValue>>;
  };
  readonly content: DriverResult["content"];
}

/** Type the secret `handle` names into the focused field; neither the result nor a refusal carries its value or the computer's words. */
export const typeSecret = async (
  secrets: DesktopBuildSecrets,
  computer: Pick<AgentEnvComputer, "callTool">,
  handle: string,
  signal: AbortSignal,
): Promise<{
  readonly outcome: "applied" | "refused" | "failed";
  readonly answer: (
    computerId: string,
    actionIndex: number,
  ) => Result<TypedSecret, AnalysisError>;
}> => {
  const refusal = (outcome: "refused" | "failed", error: AnalysisError) => ({
    outcome,
    answer: () => err(error),
  });
  const value = await secrets.resolve(handle);
  if (!value.ok)
    return refusal(
      "refused",
      value.error instanceof AnalysisError
        ? value.error
        : new AnalysisInputError(ACT, {
            userMessage: `REA did not type the secret ${handle}: ${value.error}`,
            remediationAction: `Ask the person to write the secret, and nothing else, in ${secrets.directory}/${handle} on this host, readable only by them (chmod 600), then type it again. Never ask for the secret itself.`,
            conformsToInputContract: true,
          }),
    );
  let answer: DriverResult;
  try {
    answer = await computer.callTool(
      "computer_type",
      { text: value.value },
      signal,
    );
  } catch {
    return refusal("failed", notTyped(handle, signal));
  }
  if (answer.isError) return refusal("refused", notTyped(handle, signal));
  const result = delivered(handle, answer.structured);
  return {
    outcome: "applied",
    answer: (computerId, actionIndex) =>
      ok({
        value: {
          computer_id: computerId,
          action: "type_secret",
          action_index: actionIndex,
          result,
        },
        content: [{ type: "text", text: `${String(result.summary)}.` }],
      }),
  };
};

/** Each variable a bundle's withheld settings read, from the secret its handle names; refused, naming the variable, when one cannot be read. */
export const settingsEnvironment = async (
  secrets: DesktopBuildSecrets,
  source: BuildSource,
): Promise<Result<Record<string, string>, AnalysisError>> => {
  const values: Record<string, string> = {};
  const named = source.kind === "bundle" ? (source.settings ?? {}) : {};
  for (const [variable, handle] of Object.entries(named)) {
    const value = await secrets.resolve(handle, "setting");
    if (!value.ok)
      return err(
        value.error instanceof AnalysisError
          ? value.error
          : new AnalysisInputError("start_build_computer", {
              userMessage: `REA cannot supply ${variable}: ${value.error}`,
              remediationAction:
                "Name the handle the export's withheld_files gives, or ask the person to write the value, the file's bytes in base64, in that secret's file.",
              conformsToInputContract: true,
            }),
      );
    values[variable] = value.value;
  }
  return ok(values);
};
