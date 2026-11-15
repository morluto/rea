import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { closeAgentEvaluation } from "../../scripts/lib/agent-evaluation-cleanup.mjs";
import { VerifierFixture } from "../../scripts/lib/verifier-fixture.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const evaluationFixture = async () => {
  const root = await createTestTempDirectory("rea-evaluation-auth-cleanup-");
  const fixture = new VerifierFixture({
    path: root,
    close: () => rm(root, { recursive: true, force: true }),
  });
  const auth = join(root, "auth.json");
  const ordinary = join(root, "retained-observation.txt");
  await writeFile(ordinary, "retained observation");
  return { root, fixture, auth, ordinary };
};

it.each([false, true])(
  "removes copied auth after command cleanup failure and retains the run root (auth fails=%s)",
  async (authFails) => {
    const { root, fixture, auth, ordinary } = await evaluationFixture();
    // A directory at the file path gives a real, portable independent rm failure.
    if (authFails) await mkdir(auth);
    else await writeFile(auth, "inert copied authentication");
    const commandFailure = new Error("owned command did not release");
    const failure = await closeAgentEvaluation({
      fixture,
      commands: {
        close: async () => {
          throw commandFailure;
        },
      },
      authPath: auth,
      keepFixtures: false,
    }).catch((cause: unknown) => cause);
    if (!authFails)
      await expect(stat(auth)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toHaveLength(authFails ? 2 : 1);
    // The retained root is named and carries its fixture for a retry.
    expect(errors[0]).toMatchObject({ cleanupLeases: [fixture] });
    const retained = (errors[0] as AggregateError).errors;
    expect(retained[0]).toBe(commandFailure);
    expect(String(retained.at(-1))).toContain(root);
    if (authFails) {
      expect(errors[1]).toMatchObject({ code: "ERR_FS_EISDIR", path: auth });
      expect((await stat(auth)).isDirectory()).toBe(true);
    }
    expect(await readFile(ordinary, "utf8")).toBe("retained observation");
  },
);

it.each([false, true])(
  "removes copied auth and releases the run root unless kept (keep=%s)",
  async (keepFixtures) => {
    const { root, fixture, auth, ordinary } = await evaluationFixture();
    await writeFile(auth, "inert copied authentication");
    let commandsClosed = false;
    await closeAgentEvaluation({
      fixture,
      commands: {
        close: async () => {
          commandsClosed = true;
        },
      },
      authPath: auth,
      keepFixtures,
    });
    expect(commandsClosed).toBe(true);
    await expect(stat(auth)).rejects.toMatchObject({ code: "ENOENT" });
    if (keepFixtures) {
      expect(await readFile(ordinary, "utf8")).toBe("retained observation");
      expect(fixture.released).toBe(false);
      await rm(root, { recursive: true, force: true });
    } else {
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.released).toBe(true);
    }
  },
);
