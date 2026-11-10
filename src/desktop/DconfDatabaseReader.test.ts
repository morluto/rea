import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { dumpDconfDatabase } from "./DconfDatabaseReader.js";

describe.skipIf(process.platform === "win32")("dumpDconfDatabase", () => {
  it("names the staged database in a profile written beside it", async () => {
    const tools = await createTestTempDirectory("dconf-tool-");
    const command = join(tools, "dconf");
    await writeFile(command, '#!/bin/sh\ncat "$DCONF_PROFILE"\n', {
      mode: 0o755,
    });
    const staged = await createTestTempDirectory("dconf-staged-");
    const database = join(staged, "user");
    await writeFile(database, "GVariant");

    const dump = await dumpDconfDatabase(database, {
      PATH: process.env.PATH,
      REA_DCONF_COMMAND: command,
    });

    expect(dump).toEqual({ ok: true, text: `file-db:${database}\n` });
    expect((await readdir(staged)).sort()).toEqual(["profile", "user"]);
  });
});
