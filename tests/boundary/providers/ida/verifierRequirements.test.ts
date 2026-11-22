import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runOwnedCommand } from "../../../../src/process/OwnedCommand.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["native", "modern"] as const)(
  "checks the %s verifier's admission without switching options",
  async (protocol) => {
    const root = await createTestTempDirectory("rea-ida-verifier-options-");
    const config = join(root, "ida.json");
    await writeFile(
      config,
      JSON.stringify({
        url: "http://127.0.0.1:13337/mcp",
        mode: protocol === "modern" ? "headless" : "attached",
        ...(protocol === "modern" ? {} : { protocol }),
      }),
    );
    // The absent target stops admitted options before the provider is called.
    const result = await runOwnedCommand(
      {
        command: process.execPath,
        arguments: [
          "scripts/verify-real-ida.mjs",
          "--target",
          join(root, "absent"),
        ],
        runId: `rea-ida-verifier-options-${randomUUID()}`,
        cwd: process.cwd(),
        hostEnvironment: process.env,
        env: { REA_IDA_MCP_CONFIG: config },
      },
      { timeoutMs: 10_000, diagnosticBytes: 16_384, acceptNonZeroExit: true },
    );
    expect(result.exitCode).toBe(1);
    expect({
      stdout: result.stdout.text,
      stderr: result.stderr.text,
    }).toMatchObject(
      protocol === "native"
        ? {
            stdout: "",
            stderr: expect.stringContaining(
              "Native IDA verification requires --second-procedure and --second-marker",
            ),
          }
        : {
            stderr: "",
            stdout: expect.stringContaining(
              '"failed_phase": "target admission"',
            ),
          },
    );
  },
);
