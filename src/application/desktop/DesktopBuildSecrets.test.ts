import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { DesktopBuildSecrets } from "./DesktopBuildSecrets.js";

// Made-up values, never real credentials.
const FIRST = "e-Plum7-Kite-Throwaway-42";
const SECOND = "e-Quince3-Lantern-Throwaway-77";

const folder = async () => {
  const directory = join(await createTestTempDirectory("secrets-"), "s");
  await mkdir(directory, { mode: 0o700 });
  return directory;
};

const writeSecret = async (directory: string, handle: string, text: string) => {
  await writeFile(join(directory, handle), text);
  await chmod(join(directory, handle), 0o600);
};

describe("build secrets of one server", () => {
  it("keeps every value a handle held, after the person changes it", async () => {
    const directory = await folder();
    const secrets = new DesktopBuildSecrets(directory);
    await writeSecret(directory, "master", FIRST);
    expect((await secrets.resolve("master")).ok).toBe(true);
    await writeSecret(directory, "master", SECOND);
    expect((await secrets.resolve("master")).ok).toBe(true);
    expect(secrets.redact(`${FIRST} then ${SECOND}`)).toBe(
      "<secret:master> then <secret:master>",
    );
    await writeSecret(directory, "master", `${SECOND}-next`);
    expect((await secrets.all()).map(({ value }) => value).sort()).toEqual(
      [FIRST, SECOND, `${SECOND}-next`].sort(),
    );
  });

  it("keeps an empty or tiny withheld file without making every text match it", async () => {
    const directory = await folder();
    const secrets = new DesktopBuildSecrets(directory);
    await secrets.keep("rea-app-empty", Buffer.alloc(0));
    await secrets.keep("rea-app-tiny", Buffer.from("ab"));
    expect(secrets.redact("plain text")).toBe("plain text");
    expect(await secrets.all()).toEqual([]);
    expect(await secrets.resolve("rea-app-empty", "setting")).toEqual({
      ok: true,
      value: "",
    });
    expect(await secrets.resolve("rea-app-tiny", "setting")).toEqual({
      ok: true,
      value: Buffer.from("ab").toString("base64"),
    });
  });

  it("keeps a withheld file only under a handle, never at a path a computer's answer names", async () => {
    const directory = await folder();
    const secrets = new DesktopBuildSecrets(directory);
    await expect(
      secrets.keep("../escaped", Buffer.from(FIRST)),
    ).rejects.toThrow();
    expect(await readdir(dirname(directory))).toEqual(["s"]);
  });
});
