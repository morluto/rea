import { Writable } from "node:stream";

import { estimateTokenCount } from "tokenx";
import { describe, expect, it } from "vitest";

import { formatCliOutput } from "../../../src/cli/cliOutputFormatter.js";
import { parseCliOutputArguments } from "../../../src/cliOutput.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";

const countFor = async (
  value: unknown,
  format: "toon" | "yaml",
  notice = false,
): Promise<{ readonly handled: boolean; readonly text: string }> => {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const output = createCliResultOutput(
    parseCliOutputArguments([
      "fixture",
      "--format",
      format,
      "--full-output",
      "--token-count",
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
  return { handled, text: Buffer.concat(chunks).toString("utf8") };
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
      expect(counted.text).toBe(
        `${estimateTokenCount(
          formatCliOutput(
            {
              ok: true,
              data: value,
              meta: { command: "fixture", duration: "0ms" },
            },
            format,
          ),
        )}\n`,
      );
    },
  );

  // The public CLI replay also covers bare counts for these formats.
});
