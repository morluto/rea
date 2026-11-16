import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const state = vi.hoisted(() => ({
  marker: "",
  calls: 0,
  /** Run until stopped; otherwise exit at once. */
  hang: true,
  /** Withhold owned cleanup until the test allows it. */
  cleanupAllowed: true,
  /** When set, exit 1 at once with this hdiutil diagnostic on stderr. */
  diagnostic: undefined as string | undefined,
}));
// Stand in for hdiutil at the launch boundary, under production supervision.
vi.mock("../../src/process/ProviderProcess.js", async (importOriginal) => {
  const { cleanupOwnedProcessGroup } =
    await import("../../src/process/ProcessOwnership.js");
  const actual =
    await importOriginal<
      typeof import("../../src/process/ProviderProcess.js")
    >();
  return {
    ...actual,
    spawnOwnedProviderProcess: async (
      options: Parameters<typeof actual.spawnOwnedProviderProcess>[0],
    ) => {
      if (
        options.command !== "/usr/bin/hdiutil" ||
        options.arguments[0] !== "verify"
      )
        throw new Error("Unexpected native command");
      state.calls += 1;
      const launched = await actual.spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        expectedCommand: process.execPath,
        arguments: [
          "-e",
          state.diagnostic !== undefined
            ? `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.stderr.write(${JSON.stringify(state.diagnostic)}); process.exitCode = 1`
            : state.hang
              ? 'const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(process.argv[1] + ".term", "rolled back"); process.exit(0); }); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)'
              : 'require("node:fs").writeFileSync(process.argv[1], String(process.pid))',
          state.marker,
        ],
      });
      return {
        ...launched,
        cleanup: async () =>
          state.cleanupAllowed
            ? cleanupOwnedProcessGroup(launched.ownership)
            : { cleaned: false, reason: "cleanup withheld by the test" },
      };
    },
  };
});
import { NativeDmgArtifactReader } from "../../src/artifacts/NativeDmgArtifactReader.js";
import { ArtifactReaderFailure } from "../../src/resources/ArtifactReader.js";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import { translateArtifactFailure } from "../../src/resources/index.js";

it.skipIf(process.platform !== "darwin").each([false, true])(
  "preserves exact DMG caller reason and settles the command before return (pre-aborted: %s)",
  async (preAborted) => {
    const root = await createTestTempDirectory("rea-dmg-cancellation-reason-");
    state.marker = join(root, "ready");
    state.calls = 0;
    state.hang = true;
    state.cleanupAllowed = true;
    const reason = { requested: "stop verify" };
    const controller = new AbortController();
    if (preAborted) controller.abort(reason);
    const reader = new NativeDmgArtifactReader("fixture.dmg", {});
    const result = (async () => {
      for await (const _entry of reader.entries(controller.signal)) {
        /* consume */
      }
    })().catch((cause: unknown) => cause);
    try {
      if (!preAborted) {
        const deadline = Date.now() + 5_000;
        while (
          !(await access(state.marker).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline)
            throw new Error("Child readiness marker absent");
          await delay(10);
        }
        controller.abort(reason);
      }
      const failure = await result;
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected cancellation");
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
      expect(translateArtifactFailure("inspect_artifact", failure).cause).toBe(
        reason,
      );
      expect(state.calls).toBe(preAborted ? 0 : 1);
      if (!preAborted) {
        expect(failure.cause).toBeInstanceOf(OwnedCommandFailure);
        expect(
          (failure.cause as OwnedCommandFailure).cancellation?.reason,
        ).toBe(reason);
        const pid = Number(await readFile(state.marker, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        // hdiutil is asked to stop with SIGTERM before owned cleanup kills it.
        expect(await readFile(`${state.marker}.term`, "utf8")).toBe(
          "rolled back",
        );
      }
    } finally {
      controller.abort(reason);
      await result;
      await reader.close();
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "retains an hdiutil whose cleanup failed until reader close releases it",
  async () => {
    const root = await createTestTempDirectory("rea-dmg-retained-cleanup-");
    state.marker = join(root, "ran");
    state.calls = 0;
    state.hang = false;
    state.cleanupAllowed = false;
    const reader = new NativeDmgArtifactReader("fixture.dmg", {});
    try {
      const failure = await (async () => {
        for await (const _entry of reader.entries()) {
          /* consume */
        }
      })().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect((failure as ArtifactReaderFailure).cause).toMatchObject({
        cleanupFailure: "cleanup withheld by the test",
      });
      expect(state.calls).toBe(1);
      const pid = Number(await readFile(state.marker, "utf8"));

      // The retained process blocks close and names its owned identities.
      const refused = await reader.close().catch((cause: unknown) => cause);
      expect(refused).toBeInstanceOf(ArtifactReaderFailure);
      expect((refused as ArtifactReaderFailure).cleanup?.resources).toEqual(
        expect.arrayContaining([`pid:${String(pid)}`]),
      );

      state.cleanupAllowed = true;
      await reader.close();
      expect(state.calls).toBe(1);
    } finally {
      state.cleanupAllowed = true;
      await reader.close().catch(() => undefined);
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "admits no further hdiutil command while an earlier command's cleanup stays unresolved",
  async () => {
    const root = await createTestTempDirectory("rea-dmg-cleanup-admission-");
    state.marker = join(root, "ran");
    state.calls = 0;
    state.hang = false;
    state.cleanupAllowed = false;
    // A transient refusal is retried; its exit status survives failed cleanup.
    state.diagnostic =
      "hdiutil: verify failed - Resource temporarily unavailable\n";
    const reader = new NativeDmgArtifactReader("fixture.dmg", {});
    try {
      const failure = await (async () => {
        for await (const _entry of reader.entries()) {
          /* consume */
        }
      })().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      // The retry waited for the retained cleanup, which is still withheld.
      expect(state.calls).toBe(1);
      expect((failure as ArtifactReaderFailure).cleanup?.resources).toEqual(
        expect.arrayContaining([`pid:${await readFile(state.marker, "utf8")}`]),
      );
    } finally {
      state.diagnostic = undefined;
      state.cleanupAllowed = true;
      await reader.close().catch(() => undefined);
    }
  },
);
