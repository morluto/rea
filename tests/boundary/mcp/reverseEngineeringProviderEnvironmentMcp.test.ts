import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ok } from "../../../src/domain/result.js";

const analysis = {
  execute: async () =>
    ok(
      createAnalysisExecution({}, { id: "test", name: "Test", version: null }),
    ),
};

const writeObjdump = async (
  directory: string,
  output: string,
): Promise<void> => {
  const executable = join(directory, "objdump");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(executable, 0o755);
};

it.skipIf(process.platform === "win32")(
  "uses the server-selected environment unless a provider environment overrides it",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-reverse-env-"));
    const selectedPath = join(directory, "selected");
    const overridePath = join(directory, "override");
    const artifactPath = join(directory, "sample.bin");
    await Promise.all([mkdir(selectedPath), mkdir(overridePath)]);
    await Promise.all([
      writeObjdump(selectedPath, "selected environment"),
      writeObjdump(overridePath, "provider override"),
      writeFile(artifactPath, "fixture"),
    ]);

    try {
      for (const scenario of [
        {
          environment: selectedPath,
          expected: "selected environment",
        },
        {
          environment: selectedPath,
          provider: overridePath,
          expected: "provider override",
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
            name: "inspect_with_objdump",
            arguments: { path: artifactPath, operation: "file_headers" },
          });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            normalized_result: { stdout: `${scenario.expected}\n` },
          });
        } finally {
          await Promise.all([client.close(), server.close()]);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("withholds mutating Rizin from a fixed analysis source without a mutation lifecycle", async () => {
  const server = createServer({ kind: "fixed", analysis });
  const client = new Client({ name: "fixed-mutation-boundary", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toContain("inspect_with_objdump");
    expect(tools.map(({ name }) => name)).not.toContain(
      "execute_rizin_command",
    );
    await expect(
      client.callTool({
        name: "execute_rizin_command",
        arguments: { path: "package.json", command: "iI" },
      }),
    ).rejects.toThrow(
      "The requested MCP tool is not advertised by this REA server.",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
