import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    });

    const missing = join(tmpdir(), `missing-objdump-${randomUUID()}`);
    const failed = await cli.run({
      arguments: [
        "inspect-with-objdump",
        process.execPath,
        "file_headers",
        "--format",
        "json",
      ],
      environment: { REA_OBJDUMP_COMMAND: missing },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({
      code: "capability_unavailable",
      details: {
        provider_id: "objdump.command",
        diagnostics: { command: missing },
      },
    });
  },
);
