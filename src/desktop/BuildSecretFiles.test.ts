import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  buildSecretsDirectory,
  listBuildSecretHandles,
  readBuildSecretFile,
} from "./BuildSecretFiles.js";

// A made-up value, never a real credential.
const VALUE = "e-Plum7-Kite-Throwaway-42";

/** A secrets folder holding `files` by handle, each written with its mode. */
const folder = async (
  files: Readonly<Record<string, { text: string; mode: number }>>,
) => {
  const directory = join(await createTestTempDirectory("secrets-"), "s");
  await mkdir(directory, { mode: 0o700 });
  for (const [name, { text, mode }] of Object.entries(files)) {
    await writeFile(join(directory, name), text);
    await chmod(join(directory, name), mode);
  }
  return directory;
};

const refusal = async (directory: string, handle: string) => {
  const read = await readBuildSecretFile(directory, handle);
  if (read.ok) throw new Error(`${handle} was read`);
  expect(read.error).not.toContain(VALUE);
  return read.error;
};

describe("build secret files", () => {
  it("keeps secrets under the XDG config folder, or ~/.config without one", () => {
    expect(buildSecretsDirectory({ XDG_CONFIG_HOME: "/cfg", HOME: "/h" })).toBe(
      "/cfg/rea/build-secrets",
    );
    expect(buildSecretsDirectory({ XDG_CONFIG_HOME: "cfg", HOME: "/h" })).toBe(
      "/h/.config/rea/build-secrets",
    );
    expect(buildSecretsDirectory({ HOME: "/h" })).toBe(
      "/h/.config/rea/build-secrets",
    );
    // An absolute XDG_CONFIG_HOME decides the folder without consulting the
    // host account, which a Unix UID without a passwd entry cannot answer.
    expect(buildSecretsDirectory({ XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(
      "/cfg/rea/build-secrets",
    );
  });

  it("reads a file only its owner can read, without its final line break", async () => {
    const directory = await folder({
      master: { text: `${VALUE}\n`, mode: 0o600 },
      crlf: { text: `${VALUE}\r\n`, mode: 0o400 },
    });
    expect(await readBuildSecretFile(directory, "master")).toEqual({
      ok: true,
      value: VALUE,
    });
    expect(await readBuildSecretFile(directory, "crlf")).toEqual({
      ok: true,
      value: VALUE,
    });
  });

  it("refuses a file others can read, a link, a missing file and a value it cannot type, never quoting the value", async () => {
    const directory = await folder({
      shared: { text: VALUE, mode: 0o640 },
      short: { text: "e-1234\n", mode: 0o600 },
      lines: { text: `${VALUE}\nmore\n`, mode: 0o600 },
      master: { text: VALUE, mode: 0o600 },
    });
    await symlink(join(directory, "master"), join(directory, "linked"));
    expect(await refusal(directory, "shared")).toContain("chmod 600");
    expect(await refusal(directory, "linked")).toContain("symbolic link");
    expect(await refusal(directory, "absent")).toContain(
      join(directory, "absent"),
    );
    expect(await refusal(directory, "short")).toContain("8");
    expect(await refusal(directory, "lines")).toContain("control");
    const linkedFolder = join(directory, "..", "linked-folder");
    await symlink(directory, linkedFolder);
    expect(await refusal(linkedFolder, "master")).toContain("symbolic link");
  });

  it("lists the handles the folder holds, and none when it is missing", async () => {
    const directory = await folder({
      master: { text: VALUE, mode: 0o600 },
      "Not A Handle": { text: VALUE, mode: 0o600 },
    });
    expect(await listBuildSecretHandles(directory)).toEqual(["master"]);
    expect(await listBuildSecretHandles(join(directory, "none"))).toEqual([]);
  });
});
