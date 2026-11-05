import { describe, expect } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

const CLI_INTEGRATION_TIMEOUT_MS = 60_000;

const HELP_COMMANDS = [
  ["inspect-byte-entropy"],
  ["inspect-devicetree"],
  ["decode-signal-recording"],
  ["inspect-packet-capture"],
  ["inspect-packet-fields"],
  ["inspect-signal-decoders"],
] as const;

/**
 * A help line whose description restates the default that the CLI already
 * appends as its automatic `(default: …)` annotation, e.g.
 * `--offset <number>  Window start (default 0) (default: 0)`.
 */
const duplicatedDefaultAnnotation = (line: string): string | undefined => {
  const withoutAutomatic = line.replace(/\s*\(default: [^()]*\)\s*$/u, "");
  if (withoutAutomatic === line) return undefined;
  return /(?:\bdefaults? to \S|\(default [^()]+\)|\bdefault \S)/.exec(
    withoutAutomatic,
  )?.[0];
};

describe("CLI help default annotations", () => {
  workspaceCliTest(
    "presents each option default exactly once",
    async ({ cli }) => {
      for (const command of HELP_COMMANDS) {
        const result = await cli.run({ arguments: [...command, "--help"] });
        expect(result).toMatchObject({ exitCode: 0 });
        expect(result.stderr).toBe("");
        const duplicated = result.stdout
          .split("\n")
          .map((line) => ({ line, match: duplicatedDefaultAnnotation(line) }))
          .filter(({ match }) => match !== undefined);
        expect(duplicated).toEqual([]);
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});
