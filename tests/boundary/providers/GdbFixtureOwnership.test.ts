import { randomUUID } from "node:crypto";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { OwnedDebuggerCleanupError } from "../../../src/process/ownedDebuggerCleanupError.js";
import { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import { createGdbFixtureOwner } from "./gdbTestHelpers.js";

it.skipIf(process.platform === "win32")(
  "retains an uncertain fake GDB child and files for independent cleanup retry",
  async () => {
    const root = await createTestTempDirectory("rea-gdb-fixture-owner-");
    const provider = join(root, "fake-gdb.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}\nprocess.stdout.write("ready\\n"); process.stdin.resume(); setInterval(() => {}, 1000);\n`,
    );
    await chmod(provider, 0o700);
    let refused = true;
    const fixture = createGdbFixtureOwner({
      stopOwnedProcess: (supervisor) =>
        refused
          ? Promise.resolve({
              status: "incomplete",
              reason: "injected physical cleanup refusal",
            })
          : supervisor.stop(),
    });
    const launched = await fixture.spawnProcess({
      command: provider,
      arguments: [],
      runId: randomUUID(),
      stdin: "pipe",
    });
    const managers = [
      {
        closeAll: async () => {
          throw new OwnedDebuggerCleanupError(
            [new Error("inferior state intentionally unknown")],
            "controlled debugger refusal",
            [launched.process.pid!],
          );
        },
      },
    ];
    const remove = () => rm(root, { recursive: true, force: true });
    try {
      await waitForProviderProcessReady(launched.process);
      await expect(fixture.cleanup(managers, remove)).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining(
              "injected physical cleanup refusal",
            ),
          }),
        ],
      });
      expect(managers).toHaveLength(1);
      expect(launched.process.exitCode).toBeNull();
      expect(launched.process.signalCode).toBeNull();
      await access(provider);
      refused = false;
      await fixture.cleanup(managers, remove);
      expect(managers).toHaveLength(0);
      expect(
        launched.process.exitCode !== null ||
          launched.process.signalCode !== null,
      ).toBe(true);
      await expect(access(provider)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      refused = false;
      // Independent backstop keeps a broken ownership mutation from leaking its child.
      const safety = new ProviderProcessSupervisor(
        { ...launched, ownsProcessLifetime: true },
        { captureStdout: false, maxDiagnosticBytes: 0 },
      );
      expect((await safety.stop()).status).not.toBe("incomplete");
      await fixture.cleanup(managers, remove);
    }
  },
);
