import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";
import { javaScriptSourcePathsSchema } from "../../../src/domain/javascript/javascriptSourceSelection.js";

/** The help line of one option, with its description. */
const optionLine = (text: string, option: string): string | undefined =>
  text.split("\n").find((line) => line.trimStart().startsWith(`${option} `));

// `source_paths` is `javaScriptSourcePathsSchema.optional()`; zod keeps the
// description on the wrapped schema only. A projection description replaces
// the contract's (`format` is shown as "Application artifact format").
it.each(["analyze-javascript-application", "analyze"])(
  "%s --help describes a wrapped contract field and keeps the projection's override",
  async (command) => {
    const { stdout: text } = await serveInProcessCli(createCli({}), [
      command,
      "--help",
    ]);
    const description = javaScriptSourcePathsSchema.description!;
    expect(optionLine(text, "--source-path")).toContain(
      description.slice(0, 60),
    );
    expect(optionLine(text, "--artifact-format")).toContain(
      "Application artifact format",
    );
  },
);
