import { Writable } from "node:stream";

import { Formatter } from "incur";
import { estimateTokenCount } from "tokenx";
import { describe, expect, it } from "vitest";

import { parseCliOutputArguments } from "../../../src/cliOutput.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";

const countFor = async (
  value: unknown,
  format: "toon" | "yaml",
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
    format,
  });
  return { handled, text: Buffer.concat(chunks).toString("utf8") };
};

describe("full-output token counts for delegated formats", () => {
  it.each(["toon", "yaml"] as const)(
    "counts the emitted envelope, not just the selected data (%s)",
    async (format) => {
      const value = { imported: 0, unknowns_added: 0, total: 0 };
      const counted = await countFor(value, format);
      expect(counted.handled).toBe(true);
      expect(counted.text).toBe(
        `${estimateTokenCount(
          Formatter.format(
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

  // Bare counts stay delegated to Incur and are covered by the CLI replay
  // (bare toon/yaml report the selected result before and after this fix);
  // this boundary owns only the full-output envelope count.
});
