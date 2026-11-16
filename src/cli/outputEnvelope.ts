/*
 * The failure envelope, its terminal rendering and the token window of
 * dispatcher-written documents are adapted from Incur's CLI output.
 * Copyright (c) 2025-present weth, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { estimateTokenCount, sliceByTokens } from "tokenx";

import type { CliOutputFormat } from "../cliOutput.js";
import { formatCliOutput } from "./cliOutputFormatter.js";

/** Suggested commands that follow a document. */
export interface CallToAction {
  readonly description: string;
  readonly commands: readonly {
    readonly command: string;
    readonly description?: string;
  }[];
}

export interface CliFailure {
  readonly code: string;
  readonly message: string;
}

/** How the caller asked for a dispatcher-written document. */
export interface EnvelopePresentation {
  readonly format: Exclude<CliOutputFormat, "csv" | "tsv">;
  /** A terminal without an explicit format: plain text for a person. */
  readonly human: boolean;
  readonly fullOutput: boolean;
  readonly tokenCount: boolean;
  readonly tokenLimit: number | undefined;
  readonly tokenOffset: number | undefined;
}

/** `Error: message`, or `Error (CODE): message` for codes other than lookup failures. */
const humanError = ({ code, message }: CliFailure): string =>
  `${code === "UNKNOWN" || code === "COMMAND_NOT_FOUND" ? "Error" : `Error (${code})`}: ${message}`;

/** A blank line, the description, then each command with its aligned comment. */
const humanCallToAction = ({ description, commands }: CallToAction): string => {
  const width = Math.max(...commands.map(({ command }) => command.length));
  return [
    "",
    description,
    ...commands.map(
      ({ command, description: comment }) =>
        `  ${command}${comment === undefined ? "" : `  ${"".padEnd(width - command.length)}# ${comment}`}`,
    ),
  ].join("\n");
};

/** One line of output: a trailing newline unless the text already ends with one. */
const line = (text: string): string =>
  text.endsWith("\n") ? text : `${text}\n`;

const tokenWindow = (
  text: string,
  { tokenLimit, tokenOffset }: EnvelopePresentation,
):
  | { readonly truncated: false; readonly text: string }
  | {
      readonly truncated: true;
      readonly text: string;
      readonly nextOffset: number | undefined;
    } => {
  if (tokenLimit === undefined && tokenOffset === undefined)
    return { truncated: false, text };
  const total = estimateTokenCount(text);
  const offset = tokenOffset ?? 0;
  const end = tokenLimit === undefined ? total : offset + tokenLimit;
  if (offset === 0 && end >= total) return { truncated: false, text };
  const shown = Math.min(end, total);
  return {
    truncated: true,
    text: `${sliceByTokens(text, offset, end)}\n[truncated: showing tokens ${offset}–${shown} of ${total}]`,
    nextOffset: shown < total ? shown : undefined,
  };
};

/**
 * Render a failure the dispatcher reports itself, such as an unknown command.
 * A person on a terminal reads the error and the suggested commands as text;
 * otherwise the error and its suggestions form one document, or the
 * `--full-output` envelope, in the chosen format and token window.
 */
export const renderFailure = (
  failure: CliFailure,
  {
    command,
    duration,
  }: { readonly command: string; readonly duration: string },
  cta: CallToAction,
  presentation: EnvelopePresentation,
): string => {
  const { format } = presentation;
  const meta = { command, cta, duration };
  if (presentation.tokenCount) {
    const document = presentation.fullOutput
      ? { ok: false, error: failure, meta }
      : { ...failure, cta };
    return line(String(estimateTokenCount(formatCliOutput(document, format))));
  }
  if (
    presentation.human &&
    !presentation.fullOutput &&
    presentation.tokenLimit === undefined &&
    presentation.tokenOffset === undefined
  )
    return line(humanError(failure)) + line(humanCallToAction(cta));
  if (presentation.fullOutput) {
    const window = tokenWindow(formatCliOutput(failure, format), presentation);
    return line(
      formatCliOutput(
        window.truncated
          ? {
              ok: false,
              error: window.text,
              meta: {
                ...meta,
                ...(window.nextOffset === undefined
                  ? {}
                  : { nextOffset: window.nextOffset }),
              },
            }
          : { ok: false, error: failure, meta },
        format,
      ),
    );
  }
  return line(
    tokenWindow(formatCliOutput({ ...failure, cta }, format), presentation)
      .text,
  );
};
