import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../src/contracts/reverseEngineeringToolContracts.js";
import { rizinCommandLimitations } from "../../src/rizin/RizinCommand.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

const outcomes = [
  {
    command: "axffj",
    stdout: "",
    stderr: "ERROR: Command 'axffj' does not exist.\n",
    // The refusal line on stderr is classified; process facts stay as observed.
    completion: "rejected",
  },
  { command: "q", stdout: "", stderr: "", completion: "complete" },
  {
    command: "echo diagnostic",
    stdout: "ERROR: Command 'axffj' does not exist.\n",
    stderr: "WARNING: fixture warning\n",
    // Refusal text on stdout is command output, not a Rizin diagnostic.
    completion: "complete",
  },
] as const;

cliTest.skipIf(process.platform === "win32").for(outcomes)(
  "preserves process facts and exposes command-validity uncertainty: $command",
  async (outcome, { cli }) => {
    const root = await createTestTempDirectory("rea-rizin-command-outcomes-");
    const provider = join(root, "rizin-fixture");
    const artifact = join(root, "artifact.bin");
    const content = "caller-selected inert artifact";
    await writeFile(artifact, content);
    // Real Node subprocesses simulate producer output; they are not Rizin.
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
    const response = await cli.run({
      arguments: ["execute-rizin-command", artifact, outcome.command, "--json"],
      environment,
    });
    expect(response.exitCode, `${response.stdout}\n${response.stderr}`).toBe(0);
    const { client, call } = await connectLocalToolsMcp(environment);
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "execute_rizin_command",
    );
    const mcp = await call("execute_rizin_command", {
      path: artifact,
      command: outcome.command,
    });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    const contract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
      ({ name }) => name === "execute_rizin_command",
    );
    if (!contract) throw new Error("Missing execute_rizin_command contract");
    const limitations = rizinCommandLimitations({
      path: artifact,
      command: outcome.command,
    });
    // Even unqualified commands must disclose the provider validity gap.
    expect(limitations).not.toHaveLength(0);
    for (const raw of [response.json, mcp.structuredContent]) {
      const evidence = contract.outputSchema.parse(raw);
      expect(evidence.normalized_result).toMatchObject({
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exit_code: 0,
        completion_status: outcome.completion,
        output_truncated: false,
        artifact_changed: false,
      });
      expect(evidence.raw_result).toEqual(evidence.normalized_result);
      expect(evidence.subject?.digest.sha256).toBe(
        createHash("sha256").update(content).digest("hex"),
      );
      expect(evidence.parameters.command).toBe(outcome.command);
      expect(evidence.limitations).toEqual(
        expect.arrayContaining([...limitations]),
      );
    }
    expect(definition?.description).toBe(contract.description);
  },
);
