import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { closeAgentEvaluation } from "../../scripts/lib/agent-evaluation-cleanup.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.each([false, true])(
  "removes copied auth after command cleanup failure and retains independent failures (auth fails=%s)",
  async (authFails) => {
    const root = await createTestTempDirectory("rea-evaluation-auth-cleanup-");
    const ordinary = join(root, "retained-observation.txt");
    const auth = join(root, "auth.json");
    await writeFile(ordinary, "retained observation");
    // A directory at the file path gives a real, portable independent rm failure.
    if (authFails) await mkdir(auth);
    else await writeFile(auth, "inert copied authentication");
    const commandFailure = new Error("owned command did not release");
    const failure = await closeAgentEvaluation({
      commands: {
        close: async () => {
          throw commandFailure;
        },
      },
      authPath: auth,
      evaluationRoot: root,
      keepFixtures: false,
    }).catch((cause: unknown) => cause);
    if (!authFails)
      await expect(stat(auth)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors[0]).toBe(commandFailure);
    expect(errors).toHaveLength(authFails ? 2 : 1);
    if (authFails) {
      expect(errors[1]).toMatchObject({ code: "ERR_FS_EISDIR", path: auth });
      expect((await stat(auth)).isDirectory()).toBe(true);
    }
    expect(await readFile(ordinary, "utf8")).toBe("retained observation");
  },
);
