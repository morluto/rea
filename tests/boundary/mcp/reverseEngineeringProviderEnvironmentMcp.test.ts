import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ok } from "../../../src/domain/result.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const analysis = {
  execute: async () =>
    ok(
      createAnalysisExecution({}, { id: "test", name: "Test", version: null }),
    ),
};

/** A fake tool on PATH that answers REA's -v probe with `banner`. */
const writeRizin = async (
  directory: string,
  output: string,
  banner: string,
): Promise<void> => {
  const executable = join(directory, "rizin");
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "-v" ]; then printf '%s\\n' '${banner}'; exit 0; fi\nprintf '%s\\n' '${output}'\n`,
  );
  await chmod(executable, 0o755);
};

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

it("uses the server-selected environment unless a provider environment overrides it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-env-"));
  const selectedPath = join(directory, "selected");
  const overridePath = join(directory, "override");
  const artifactPath = join(directory, "sample.bin");
  await Promise.all([mkdir(selectedPath), mkdir(overridePath)]);
  await Promise.all([
    writeRizin(
      selectedPath,
      "selected environment",
      "rizin 0.9.1 @ linux-x86-64",
    ),
    writeRizin(
      overridePath,
      "provider override",
      "radare2 6.1.8 +0 abi:110 @ darwin-arm_64",
    ),
    writeFile(artifactPath, "fixture"),
  ]);

  try {
    for (const scenario of [
      {
        environment: selectedPath,
        expected: "selected environment",
        tool: { name: "Rizin", version: "0.9.1" },
        banner: "rizin 0.9.1 @ linux-x86-64",
        executable: join(selectedPath, "rizin"),
      },
      {
        environment: selectedPath,
        provider: overridePath,
        expected: "provider override",
        tool: { name: "radare2", version: "6.1.8" },
        banner: "radare2 6.1.8 +0 abi:110 @ darwin-arm_64",
        executable: join(overridePath, "rizin"),
      },
    ]) {
      const server = createServer(
        { kind: "fixed", analysis },
        {
          environment: { ...process.env, PATH: scenario.environment },
          ...(scenario.provider === undefined
            ? {}
            : {
                providerEnvironment: {
                  ...process.env,
                  PATH: scenario.provider,
                },
              }),
        },
      );
      const client = new Client({ name: "reverse-env-test", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "execute_rizin_command",
          arguments: { path: artifactPath, command: "iI" },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          raw_result: { stdout: `${scenario.expected}\n` },
          provider: { id: "rizin", ...scenario.tool },
          parameters: {
            provider_executable: "rizin",
            provider_executable_path: scenario.executable,
            provider_executable_sha256: await sha256(scenario.executable),
            provider_version_banner: scenario.banner,
          },
        });
        const notRizin = expect.arrayContaining([
          expect.stringContaining("REA_RIZIN_COMMAND selected radare2 6.1.8"),
        ]);
        if (scenario.tool.name === "Rizin")
          expect(result.structuredContent).not.toMatchObject({
            limitations: notRizin,
          });
        else
          expect(result.structuredContent).toMatchObject({
            limitations: notRizin,
          });
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the probe's identification when the command then fails to start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-launch-"));
  const executable = join(directory, "rizin");
  const artifactPath = join(directory, "sample.bin");
  await writeFile(artifactPath, "fixture");
  const artifactDigest = await sha256(artifactPath);
  const server = createServer(
    { kind: "fixed", analysis },
    { environment: { ...process.env, PATH: directory } },
  );
  const client = new Client({ name: "reverse-launch-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const scenario of [
      {
        // One argument past macOS's 1 MiB ARG_MAX and Linux's 128 KiB
        // single-argument limit: the host refuses the launch with E2BIG.
        command: "x".repeat(2 * 1024 * 1024),
        probe: "",
        banner: "rizin 0.9.1 @ linux-x86-64",
        code: "resource_constraint",
        diagnostics: {
          provider: { id: "rizin", name: "Rizin", version: "0.9.1" },
          provider_identity: "banner",
        },
      },
      {
        // The probe removes the executable, so the launch finds nothing.
        // PATH holds only the fake tool, so rm is named by its path. The
        // banner identifies no tool, so the identity is assumed.
        command: "iI",
        probe: '/bin/rm -f "$0"; ',
        banner: "Warning: 123 plugins could not be loaded",
        code: "capability_unavailable",
        diagnostics: {
          boundary: "provider-launch",
          command: "rizin",
          system_code: "ENOENT",
          provider: { id: "rizin", name: "Rizin", version: null },
          provider_identity: "assumed",
          provider_version_probe: {
            exit_code: 0,
            stdout: "Warning: 123 plugins could not be loaded\n",
          },
        },
      },
    ]) {
      await writeFile(
        executable,
        `#!/bin/sh\nif [ "$1" = "-v" ]; then ${scenario.probe}printf '%s\\n' '${scenario.banner}'; exit 0; fi\nprintf 'command ran\\n'\n`,
      );
      await chmod(executable, 0o755);
      const digest = await sha256(executable);
      const { error } = parseMcpToolError(
        await client.callTool({
          name: "execute_rizin_command",
          arguments: { path: artifactPath, command: scenario.command },
        }),
      );
      expect(error).toMatchObject({
        code: scenario.code,
        details: {
          diagnostics: {
            ...scenario.diagnostics,
            provider_executable: "rizin",
            artifact_path: artifactPath,
            artifact_sha256: artifactDigest,
            provider_executable_path: executable,
            provider_executable_sha256: digest,
            provider_version_banner: scenario.banner,
            provider_version_banner_truncated: false,
          },
        },
      });
      // Nothing describes command output that was never produced.
      expect(error.details).not.toHaveProperty("partial_observation");
      expect(error.details).not.toHaveProperty("captured_output");
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
