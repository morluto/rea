import { captureOutput } from "../../support/cli/capturedOutput.js";

import { estimateTokenCount } from "tokenx";
import { describe, expect, it } from "vitest";

import { parseCliOutputArguments } from "../../../src/cli/cliOutput.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";

const countFor = async (
  value: unknown,
  format: "toon" | "yaml",
  notice = false,
  tokenCount = true,
): Promise<{ readonly handled: boolean; readonly text: string }> => {
  const { destination, text: readText } = captureOutput();
  const output = createCliResultOutput(
    parseCliOutputArguments([
      "fixture",
      "--format",
      format,
      "--full-output",
      ...(tokenCount ? ["--token-count"] : []),
    ]),
    destination,
  );
  if (output === undefined) throw new Error("Missing output surface");
  const handled = await output.write(value, {
    command: "fixture",
    duration: "0ms",
    ...(notice
      ? {
          cta: {
            description: "Update available",
            commands: [{ command: "rea --update" }],
          },
        }
      : {}),
  });
  return { handled, text: readText() };
};

describe("full-output token counts", () => {
  it.each(
    (["toon", "yaml"] as const).flatMap((format) =>
      [false, true].map((notice) => ({ format, notice })),
    ),
  )(
    "counts the emitted envelope without a terminal notice ($format, notice: $notice)",
    async ({ format, notice }) => {
      const value = { imported: 0, unknowns_added: 0, total: 0 };
      const counted = await countFor(value, format, notice);
      expect(counted.handled).toBe(true);
      const emitted = await countFor(value, format, false, false);
      expect(counted.text).toBe(
        String(estimateTokenCount(emitted.text)) + "\n",
      );
    },
  );

  // The public CLI replay also covers bare counts for these formats.
});
