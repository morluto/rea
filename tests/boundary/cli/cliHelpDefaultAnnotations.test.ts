import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

type CliInstance = ReturnType<typeof createCli>;

const serve = async (
  cli: CliInstance,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

/**
 * Options whose owning field already declares a schema default. The help
 * renderer appends that default, so the description must not restate it.
 */
const singleDefaultOptions: readonly {
  readonly command: string;
  readonly options: readonly string[];
}[] = [
  { command: "inspect-byte-entropy", options: ["--block-size", "--offset"] },
  {
    command: "inspect-devicetree",
    options: [
      "--max-file-bytes",
      "--max-nodes",
      "--max-properties",
      "--max-depth",
    ],
  },
  {
    command: "decode-signal-recording",
    options: ["--line_offset", "--line_limit"],
  },
  {
    command: "inspect-packet-capture",
    options: ["--match_offset", "--match_limit"],
  },
  {
    command: "inspect-packet-fields",
    options: ["--kind", "--offset"],
  },
  { command: "inspect-signal-decoders", options: ["--offset"] },
];

const optionLine = (
  help: string,
  option: string,
): string | undefined => {
  const line = help
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(`${option} `));
  return line?.trim();
};

describe("CLI help default annotations", () => {
  it("states each schema-owned option default exactly once", async () => {
    const cli = createCli({});
    const repeated: string[] = [];
    for (const { command, options } of singleDefaultOptions) {
      const { stdout, exitCode } = await serve(cli, [command, "--help"]);
      expect(exitCode, command).toBe(0);
      for (const option of options) {
        const line = optionLine(stdout, option);
        if (line === undefined) {
          repeated.push(`${command} ${option}: option line missing`);
          continue;
        }
        const statements = line.match(/default/giu)?.length ?? 0;
        if (statements !== 1)
          repeated.push(`${command} ${option}: ${statements} default statements`);
      }
    }
    expect(repeated).toEqual([]);
  });
});
