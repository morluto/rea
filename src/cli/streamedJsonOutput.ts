import { type Writable } from "node:stream";

import { Filter } from "incur";

import { parseCliOutputArguments } from "../cliOutput.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { writeJsonOutput } from "./jsonOutput.js";

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
  write(value: JsonValue, metadata: CliResultOutputMetadata): Promise<boolean>;
}

/** Selected command output context, independent of application workflows. */
export interface CliCommandOutput {
  readonly output: CliResultOutput;
  readonly command: string;
  readonly format: string;
}

/** Preserve Incur's JSON controls while streaming the complete result. */
export const createStreamedCliJsonOutput = (
  arguments_: readonly string[],
  destination: Writable,
): CliResultOutput | undefined => {
  const options = parseCliOutputArguments(arguments_);
  if (
    options.parseError ||
    options.tokenCount ||
    options.tokenWindow ||
    (options.format !== "json" && options.format !== "jsonl")
  )
    return undefined;
  const format = options.format;
  let handled = false;
  let failed = false;
  return {
    get handled() {
      return handled;
    },
    get failed() {
      return failed;
    },
    async write(value, metadata) {
      if (metadata.format !== format) return false;
      const filtered: unknown = options.filterOutput
        ? Filter.apply(value, Filter.parse(options.filterOutput))
        : value;
      const meta = {
        command: metadata.command,
        duration: metadata.duration,
      };
      const document = options.fullOutput
        ? filtered === undefined
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
        await writeJsonOutput(document, destination, format);
      } catch (cause: unknown) {
        failed = true;
        throw cause;
      }
      return true;
    },
  };
};
