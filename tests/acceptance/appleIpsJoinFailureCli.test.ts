import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { appleIpsBytes } from "../fixtures/binaryDiagnostics/appleIps.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains a completed IPS report when the selected join cannot be read",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ips-join-cli-");
    const path = join(root, "report.ips");
    const bytes = appleIpsBytes();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-apple-ips",
        path,
        "--join-path",
        join(root, "missing.bin"),
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [expect.objectContaining({ path: ["join_path"] })],
        partial_observation: {
          artifact: {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
        },
      },
    });
  },
);
