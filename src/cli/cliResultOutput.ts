import { constants } from "node:buffer";
import type { Writable } from "node:stream";

import { Cli, Filter, Formatter } from "incur";
import { estimateTokenCount, sliceByTokens } from "tokenx";

import {
  parseCliOutputArguments,
  validateCliOutputArguments,
} from "../cliOutput.js";
import { cliOperationFailurePayload } from "../cliLogging.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import {
  jsonOutputParts,
  writeJsonOutput,
  writeOutputText,
} from "./jsonOutput.js";
import type { CliInstance } from "./types.js";

/** Result metadata supplied by the command that actually ran. */
export interface CliResultOutputMetadata {
  readonly command: string;
  readonly duration: string;
  readonly format: string;
}

/** Optional executable-owned result surface for one CLI invocation. */
export interface CliResultOutput {
  readonly handled: boolean;
  readonly failed: boolean;
  readonly error: AnalysisErrorProjection | undefined;
  write(value: unknown, metadata: CliResultOutputMetadata): Promise<boolean>;
}

type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;
type CommandDefinition = Extract<
  CommandMap extends Map<string, infer Entry> ? Entry : never,
  { run: unknown }
>;
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

/** Install formatting once, after registration, for every ordinary CLI result. */
export const streamCliCommandResults = (
  cli: CliInstance,
  output: CliResultOutput,
): void => {
  const commands = registeredCommands.get(cli);
  if (commands !== undefined) wrapCommands(commands, [], output);
};

const wrapCommands = (
  commands: CommandMap,
  parents: readonly string[],
  output: CliResultOutput,
): void => {
  for (const [name, entry] of commands) {
    const path = [...parents, name];
    if ("_group" in entry) {
      wrapCommands(entry.commands, path, output);
      if (entry.root !== undefined)
        wrapCommand(entry.root, path.join(" "), output);
    } else if (!("_alias" in entry) && !("_fetch" in entry))
      wrapCommand(entry, path.join(" "), output);
  }
};

const wrapCommand = (
  command: Pick<CommandDefinition, "run">,
  name: string,
  output: CliResultOutput,
): void => {
  const run = command.run;
  command.run = (context) => {
    const started = performance.now();
    const result: unknown = run(context);
    // Generator results and Incur's sentinel responses retain their own protocol.
    if (
      typeof result === "object" &&
      result !== null &&
      Symbol.asyncIterator in result
    )
      return result;
    return Promise.resolve(result).then(async (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Symbol.for("incur.sentinel") in value
      )
        return value;
      if (
        !(await output.write(value, {
          command: name,
          format: context.format,
          duration: `${Math.round(performance.now() - started)}ms`,
        }))
      )
        return value;
      if (output.error !== undefined)
        return context.error({
          code: output.error.code,
          message: output.error.message,
        });
      return undefined;
    });
  };
};

/** Preserve Incur output controls and stream JSON while framing failures. */
export const createCliResultOutput = (
  arguments_: readonly string[],
  destination: Writable,
): CliResultOutput | undefined => {
  const options = parseCliOutputArguments(arguments_);
  if (options.parseError || !validateCliOutputArguments(arguments_).ok)
    return undefined;
  const format = options.format as "json" | "jsonl" | "yaml" | "toon" | "md";
  let handled = false;
  let failed = false;
  let error: AnalysisErrorProjection | undefined;
  return {
    get handled() {
      return handled;
    },
    get failed() {
      return failed;
    },
    get error() {
      return error;
    },
    async write(value, metadata) {
      if (metadata.format !== format) return false;
      const failure = options.fullOutput
        ? cliOperationFailurePayload(value)
        : undefined;
      const filtered: unknown = options.filterOutput
        ? Filter.apply(value, Filter.parse(options.filterOutput))
        : value;
      // Leave successful YAML and bare YAML rendering to Incur. The custom
      // boundary is needed only for a full failure envelope, whose error
      // sentinel otherwise drops category, remediation, and details.
      if (format !== "json" && format !== "jsonl" && failure === undefined)
        return false;
      if (options.tokenCount) {
        // Incur/tokenx materialize JSON. Measure its UTF-16 expansion before
        // allowing that allocation, independently of UTF-8 bytes. Other formats
        // retain Incur's materializing behavior.
        const tokenValue = failure ?? filtered;
        let characters = 0;
        if (
          tokenValue !== undefined &&
          tokenValue !== null &&
          typeof tokenValue !== "function" &&
          typeof tokenValue !== "symbol"
        ) {
          if (format === "json" || format === "jsonl") {
            for (const part of jsonOutputParts(
              tokenValue,
              format,
              format === "json",
            ))
              characters += part.length;
            characters = Math.max(0, characters - 1);
          }
        }
        if (characters <= constants.MAX_STRING_LENGTH) {
          if (failure === undefined) return false;
          handled = true;
          try {
            await writeOutputText(
              destination,
              `${estimateTokenCount(Formatter.format(failure, format))}\n`,
            );
            return true;
          } catch (cause: unknown) {
            failed = true;
            throw cause;
          }
        }
        error = projectAnalysisError(
          new AnalysisResourceConstraintError(
            metadata.command,
            "memory",
            "Token counting requires a formatted string larger than the runtime permits.",
            {
              formatted_characters: characters,
              max_string_characters: constants.MAX_STRING_LENGTH,
            },
            {
              remediationAction:
                "Remove --token-count to stream the complete JSON result, or narrow it with --filter-output.",
            },
          ),
        );
      }
      const meta = {
        command: metadata.command,
        duration: metadata.duration,
      };
      const errorDocument =
        options.fullOutput && failure !== undefined
          ? fullFailureEnvelope(
              failure,
              meta,
              format,
              options.tokenLimit,
              options.tokenOffset,
            )
          : undefined;
      const document = options.fullOutput
        ? failure !== undefined
          ? errorDocument
          : filtered === undefined
            ? { ok: true, meta }
            : { ok: true, data: filtered, meta }
        : filtered === undefined ||
            filtered === null ||
            typeof filtered === "function" ||
            typeof filtered === "symbol"
          ? {}
          : filtered;
      // Once writing starts, a failed destination must not receive a second
      // document from Incur's error formatter.
      handled = true;
      try {
        if (failure !== undefined && format !== "json" && format !== "jsonl") {
          // Incur's error sentinel only carries code/message/retryable. Render
          // the full caller-visible failure at this output boundary.
          await writeOutputText(
            destination,
            `${Formatter.format(document, format)}\n`,
          );
        } else {
          await writeJsonOutput(
            error === undefined
              ? document
              : options.fullOutput
                ? { ok: false, error, meta }
                : error,
            destination,
            format as "json" | "jsonl",
          );
        }
      } catch (cause: unknown) {
        failed = true;
        throw cause;
      }
      return true;
    },
  };
};

const fullFailureEnvelope = (
  failure: unknown,
  meta: Readonly<Record<string, unknown>>,
  format: "json" | "jsonl" | "yaml" | "toon" | "md",
  tokenLimit: number | undefined,
  tokenOffset: number | undefined,
): Readonly<Record<string, unknown>> => {
  if (tokenLimit === undefined && tokenOffset === undefined)
    return { ok: false, error: failure, meta };
  const formatted = Formatter.format(failure, format);
  const total = estimateTokenCount(formatted);
  const offset = tokenOffset ?? 0;
  const end = tokenLimit === undefined ? total : offset + tokenLimit;
  if (offset === 0 && end >= total) return { ok: false, error: failure, meta };
  const actualEnd = Math.min(end, total);
  const nextOffset = actualEnd < total ? actualEnd : undefined;
  return {
    ok: false,
    error: `${sliceByTokens(formatted, offset, end)}\n[truncated: showing tokens ${offset}–${actualEnd} of ${total}]`,
    meta: { ...meta, ...(nextOffset === undefined ? {} : { nextOffset }) },
  };
};
