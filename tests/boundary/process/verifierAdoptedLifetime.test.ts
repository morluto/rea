import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { withArtifactMcp } from "../../../scripts/lib/artifact-e2e.mjs";
import { createVerifierCommands } from "../../../scripts/lib/verify-commands.mjs";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps the shared owner's real MCP connection open across an unrelated command", async () => {
  const root = await createTestTempDirectory("rea-verifier-adopted-mcp-");
  const target = join(root, "fixture.plist");
  await writeFile(
    target,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>name</key><string>fixture</string></dict></plist>',
  );
  const commands = await createVerifierCommands();
  try {
    await withArtifactMcp(
      target,
      async (client) => {
        await client.ping();
        expect(
          (
            await commands.exec(
              process.execPath,
              ["-e", "process.stdout.write('ok')"],
              { timeout: 5_000 },
            )
          ).stdout,
        ).toBe("ok");
        // The helper adopted this exact transport before entering the callback.
        // A new protocol request must still work after command supervision.
        await client.ping();
      },
      { commands },
    );
  } finally {
    await commands.close();
  }
});

it.skipIf(process.platform === "win32")(
  "retries failed command cleanup before another launch without closing live adopted files",
  async () => {
    const root = await createTestTempDirectory("rea-verifier-adopted-pending-");
    const path = join(root, "evidence.txt");
    await writeFile(path, "retained evidence");
    const handle = await open(path, "r");
    let deny = true;
    let launches = 0;
    let releases = 0;
    const commands = await createVerifierCommands({
      launcher: async (input) => {
        launches++;
        const owned = await spawnOwnedProviderProcess(input);
        return {
          ...owned,
          cleanup: () =>
            deny
              ? Promise.resolve({
                  cleaned: false as const,
                  reason: "authored cleanup denial",
                })
              : owned.cleanup === undefined
                ? cleanupOwnedProcessGroup(owned.ownership)
                : owned.cleanup(),
        };
      },
    });
    commands.adopt(
      {
        async close() {
          releases++;
          await handle.close();
        },
      },
      path,
    );
    const execute = () =>
      commands.exec(process.execPath, ["-e", "process.stdout.write('ok')"], {
        timeout: 5_000,
      });
    try {
      await expect(execute()).rejects.toBeInstanceOf(Error);
      expect(launches).toBe(1);
      expect(releases).toBe(0);
      await expect(execute()).rejects.toBeInstanceOf(Error);
      expect(launches).toBe(1);
      expect((await handle.stat()).size).toBe(
        Buffer.byteLength("retained evidence"),
      );
      expect(commands.cleanupResources).toContain(path);
      deny = false;
      expect((await execute()).stdout).toBe("ok");
      expect(launches).toBe(2);
      expect(releases).toBe(0);
    } finally {
      deny = false;
      await commands.close();
    }
    expect(releases).toBe(1);
    expect(handle.fd).toBe(-1);
    expect(commands.cleanupResources).toEqual([]);
  },
);
