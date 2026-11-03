import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "does not attribute a caller-selected command to GNU objdump",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "inspect-with-objdump",
        process.execPath,
        "file_headers",
        "--format",
        "json",
      ],
      environment: { REA_OBJDUMP_COMMAND: process.execPath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      provider: {
        id: "objdump.command",
        name: "objdump command",
        version: null,
      },
      parameters: { provider_executable: process.execPath },
      normalized_result: {
        exit_code: expect.any(Number),
        completion_status: "complete",
      },
      limitations: expect.arrayContaining([
        expect.stringContaining(
          "executable implementation, version and supported formats are unknown",
        ),
      ]),
    });

    const architectures = await cli.run({
      arguments: ["list-objdump-architectures", "--format", "json"],
      environment: { REA_OBJDUMP_COMMAND: process.execPath },
      input: "",
    });
    expect(architectures.exitCode).toBe(0);
    expect(architectures.json).toMatchObject({
      provider: {
        id: "objdump.command",
        name: "objdump command",
        version: null,
      },
      subject: null,
      limitations: expect.arrayContaining([
        expect.stringContaining("implementation and version are unknown"),
      ]),
    });
    expect(JSON.stringify(architectures.json)).not.toContain(
      "lists BFD targets",
    );
  },
);
