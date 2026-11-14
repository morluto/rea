import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../src/contracts/reverseEngineeringToolContracts.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
  ({ name }) => name === "execute_rizin_command",
);
if (contract === undefined)
  throw new Error("execute_rizin_command contract is missing");

interface Outcome {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Expected completion and the refusal the limitation must name. */
  readonly refused?: RegExp;
}

// Captured from the official Rizin 0.9.1 static Linux build on /usr/bin/true.
const outcomes: readonly Outcome[] = [
  {
    command: "axffj",
    stdout: "",
    stderr:
      "ERROR: Command 'axffj' does not exist.\nERROR: Displaying the help of command 'axf'.\n\nERROR: Usage: axf[jq]   # List xrefs from current seek\n",
    refused: /unknown command "axffj"/u,
  },
  {
    // Rizin runs the statements before a refusal and skips the rest.
    command: "%v 1; zz; %v 2",
    stdout: "0x1\n",
    stderr: "ERROR: Command 'zz' does not exist.\n",
    refused: /unknown command "zz"/u,
  },
  {
    command: "%v 1; afl 1 2; %v 2",
    stdout: "0x1\n",
    stderr:
      "ERROR: Wrong number of arguments passed to `afl`, see its help with `afl?`\n\nERROR: Usage: afl[?]   # List functions\n",
    refused: /wrong argument count for "afl"/u,
  },
  {
    command: "pd 1 @ nosuch",
    stdout: "",
    stderr:
      "ERROR: core: Invalid address (nosuch)\nERROR: core: Error while executing command: pd 1 @ nosuch\n",
    refused: /an invalid statement/u,
  },
  {
    command: "?e",
    stdout: "",
    stderr: "ERROR: core: Error while parsing command: `?e`\n",
    refused: /input that failed to parse/u,
  },
  // A command that ran and reported its own failure is not a shell refusal.
  {
    command: "afxj",
    stdout: "",
    stderr: "ERROR: No function found in 0x000023d0.\n",
  },
  // Refusal text on stdout is command output, not a Rizin diagnostic.
  {
    command: "echo refusal",
    stdout: "ERROR: Command 'axffj' does not exist.\n",
    stderr: "",
  },
];

const expectClassified = (raw: unknown, outcome: Outcome): void => {
  const evidence = contract.outputSchema.parse(raw);
  expect(evidence.normalized_result).toMatchObject({
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: 0,
    completion_status: outcome.refused === undefined ? "complete" : "rejected",
  });
  expect(evidence.raw_result).toEqual(evidence.normalized_result);
  const refusals = evidence.limitations.filter((limitation) =>
    limitation.startsWith("Rizin refused "),
  );
  if (outcome.refused === undefined) expect(refusals).toEqual([]);
  else {
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(outcome.refused);
    expect(refusals[0]).toMatch(/empty stdout is not an empty result/u);
  }
};

cliTest.skipIf(process.platform === "win32")(
  "reports Rizin shell refusals as rejected through CLI and MCP (simulated Rizin)",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rizin-rejection-");
    const provider = join(root, "rizin-fixture");
    const artifact = join(root, "artifact.bin");
    await writeFile(artifact, "caller-selected inert artifact");
    // A Node script replays recorded Rizin output; it is not Rizin.
    await writeFile(
      provider,
      `#!${process.execPath}\n` +
        `const cases=${JSON.stringify(outcomes)};\n` +
        "const selected=cases.find(item=>item.command===process.argv[process.argv.indexOf('-c')+1]);\n" +
        "if(!selected)process.exit(99);\n" +
        "process.stdout.write(selected.stdout);process.stderr.write(selected.stderr);\n",
    );
    await chmod(provider, 0o755);
    const environment = { REA_RIZIN_COMMAND: provider };
    const { call } = await connectLocalToolsMcp(environment);
    // Both adapters share the service's classification; the CLI checks one
    // refusal and one command diagnostic.
    for (const outcome of [outcomes[0]!, outcomes[5]!]) {
      const response = await cli.sharedCliRun!({
        arguments: [
          "execute-rizin-command",
          artifact,
          outcome.command,
          "--json",
        ],
        environment,
      });
      expect(response.exitCode, `${response.stdout}\n${response.stderr}`).toBe(
        0,
      );
      expectClassified(response.json, outcome);
    }
    for (const outcome of outcomes) {
      const mcp = await call("execute_rizin_command", {
        path: artifact,
        command: outcome.command,
      });
      expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
      expectClassified(mcp.structuredContent, outcome);
    }
  },
);

// Real-provider gate: runs the Rizin found on PATH and skips without one.
const rizin = (() => {
  try {
    const path = execFileSync("which", ["rizin"], { encoding: "utf8" }).trim();
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
})();

cliTest.skipIf(rizin === undefined)(
  "classifies real Rizin refusals and command diagnostics",
  async () => {
    const root = await createTestTempDirectory("rea-real-rizin-rejection-");
    const artifact = join(root, "artifact.bin");
    await writeFile(artifact, Buffer.from([0x90, 0xc3]));
    const { call } = await connectLocalToolsMcp({ REA_RIZIN_COMMAND: rizin! });
    const expected = [
      ["axffj", "rejected"],
      ["%v 1; zz; %v 2", "rejected"],
      ["%v 1; afl 1 2; %v 2", "rejected"],
      ["pd 1 @ nosuch", "rejected"],
      ["s nosuch", "complete"],
      ["%v 1; %v 2", "complete"],
    ] as const;
    for (const [command, status] of expected) {
      const response = await call("execute_rizin_command", {
        path: artifact,
        command,
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = contract.outputSchema.parse(response.structuredContent);
      expect(evidence.normalized_result, command).toMatchObject({
        exit_code: 0,
        completion_status: status,
      });
    }
  },
);
