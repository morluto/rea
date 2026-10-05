import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectClients } from "./SetupHost.js";

describe("setup client discovery", () => {
  let temporaryHome: string | undefined;

  afterEach(async () => {
    if (temporaryHome !== undefined)
      await rm(temporaryHome, { recursive: true, force: true });
    temporaryHome = undefined;
  });

  it("detects an existing config even when the marker directory is absent", async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "rea-setup-discovery-"));
    await writeFile(join(temporaryHome, ".claude.json"), "{}\n");

    expect(
      (await detectClients(temporaryHome)).map(({ name }) => name),
    ).toContain("claude_code");
  });
});
