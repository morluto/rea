import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import {
  redactSecrets,
  redactSecretsInJson,
  type KnownSecret,
} from "../../domain/desktop/buildSecrets.js";
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
} from "../../desktop/BuildSecretFiles.js";

const ACT = "act_on_build_computer";

/** The secrets one REA server types, kept only in memory so results, logs and records can show their handles instead. */
export class DesktopBuildSecrets {
  readonly #typed = new Map<string, string>();

  constructor(readonly directory: string) {}

  /** A handle's value, read afresh from its file; a refusal names the file, never its text. */
  async resolve(handle: string): Promise<Result<string, string>> {
    const read = await readBuildSecretFile(this.directory, handle);
    if (read.ok) this.#typed.set(handle, read.value);
    return read;
  }

  #known(): KnownSecret[] {
    return [...this.#typed].map(([handle, value]) => ({ handle, value }));
  }

  /** Text with each typed secret's value replaced by its handle. */
  readonly redact = (text: string): string =>
    this.#typed.size === 0 ? text : redactSecrets(text, this.#known());

  /** A JSON value with each typed secret's value replaced by its handle. */
  readonly redactJson = (value: JsonValue): JsonValue =>
    redactSecretsInJson(value, this.#known());

  /** Every secret no bundle may hold: those typed here, then each other one the folder holds now, readable by others or not. */
  async all(): Promise<KnownSecret[]> {
    const others = (await listBuildSecretHandles(this.directory)).filter(
      (handle) => !this.#typed.has(handle),
    );
    const read = await Promise.all(
      others.map(async (handle) => ({
        handle,
        file: await readBuildSecretFile(this.directory, handle, {
          searchOnly: true,
        }),
      })),
    );
    return [
      ...this.#known(),
      ...read.flatMap(({ handle, file }) =>
        file.ok ? [{ handle, value: file.value }] : [],
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

/** Type the secret `handle` names into the focused field; neither the result nor a refusal carries its value or the computer's words. */
export const typeSecret = async (
  secrets: DesktopBuildSecrets,
  computer: Pick<AgentEnvComputer, "callTool">,
  handle: string,
  signal: AbortSignal,
): Promise<{
  readonly outcome: "applied" | "refused" | "failed";
  readonly result: Result<Readonly<Record<string, JsonValue>>, AnalysisError>;
}> => {
  const value = await secrets.resolve(handle);
  if (!value.ok)
    return {
      outcome: "refused",
      result: err(
        new AnalysisInputError(ACT, {
          userMessage: `REA did not type the secret ${handle}: ${value.error}`,
          remediationAction: `Ask the person to write the secret, and nothing else, in ${secrets.directory}/${handle} on this host, readable only by them (chmod 600), then type it again. Never ask for the secret itself.`,
          conformsToInputContract: true,
        }),
      ),
    };
  let answer: DriverResult;
  try {
    answer = await computer.callTool(
      "computer_type",
      { text: value.value },
      signal,
    );
  } catch {
    return { outcome: "failed", result: err(notTyped(handle, signal)) };
  }
  return answer.isError
    ? { outcome: "refused", result: err(notTyped(handle, signal)) }
    : { outcome: "applied", result: ok(delivered(handle, answer.structured)) };
};
