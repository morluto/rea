import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it.each([
  { protocol: "native", flags: [], required: true },
  {
    protocol: "native",
    flags: ["--second-procedure", "other", "--second-marker", "unique"],
    required: false,
  },
  { protocol: "modern", flags: [], required: false },
])(
  "enforces native switching requirements for $protocol with $flags",
  async ({ protocol, flags, required }) => {
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
    // The absent target stops accepted option sets at admission, before any provider call.
    await expect(
      execute(
        process.execPath,
        [
          "scripts/verify-real-ida.mjs",
          "--target",
          join(root, "absent"),
          ...flags,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, REA_IDA_MCP_CONFIG: config },
          timeout: 10_000,
        },
      ),
    ).rejects.toMatchObject(
      required
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
