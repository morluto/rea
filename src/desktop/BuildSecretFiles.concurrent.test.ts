import { constants } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { DesktopBuildSecrets } from "../application/desktop/DesktopBuildSecrets.js";
import {
  phaseGate,
  type PhaseGate,
} from "../../tests/support/lifecycleHarness.js";

// A made-up value, never a real credential.
const FIRST = "e-Plum7-Kite-Throwaway-42";

/** The next secret file opened to be written holds this gate once its bytes are due. */
const hold = vi.hoisted(() => ({
  next: undefined as PhaseGate | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      const held = hold.next;
      if (
        held !== undefined &&
        typeof args[1] === "number" &&
        (args[1] & constants.O_CREAT) !== 0
      ) {
        hold.next = undefined;
        const write = file.writeFile.bind(file);
        file.writeFile = async (...written: Parameters<typeof write>) => {
          await held.hold();
          await write(...written);
        };
      }
      return file;
    },
  };
});

it("never gives one export's handle to another whose bytes differ while the first is still writing them", async () => {
  const directory = join(await createTestTempDirectory("secrets-"), "s");
  await mkdir(directory, { mode: 0o700 });
  const secrets = new DesktopBuildSecrets(directory);
  const firstWrite = phaseGate();
  hold.next = firstWrite;
  const first = secrets.keep("rea-app", Buffer.from(FIRST));
  try {
    await firstWrite.reached(first, "first secret write");
    const second = await secrets.keep("rea-app", Buffer.alloc(0));
    firstWrite.release();
    const kept = await first;
    expect(kept).not.toBe(second);
    expect(await secrets.resolve(second, "setting")).toEqual({
      ok: true,
      value: "",
    });
    expect(await secrets.resolve(kept, "setting")).toEqual({
      ok: true,
      value: Buffer.from(FIRST).toString("base64"),
    });
    expect((await readdir(directory)).sort()).toEqual([kept, second].sort());
  } finally {
    firstWrite.release();
    await Promise.allSettled([first]);
    await secrets.close();
  }
});
