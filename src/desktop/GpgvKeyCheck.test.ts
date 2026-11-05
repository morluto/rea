import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  A_ARMORED,
  SIGNED_BY_BOTH,
  VENDOR_A,
  VENDOR_B,
} from "../domain/desktop/aptKeys.fixture.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { withGpgvKeyCheck } from "./GpgvKeyCheck.js";
import { runHostQuery, type QueryRunner } from "./HostQuery.js";

const hasGpgv =
  typeof (await runHostQuery("gpgv", ["--version"], undefined)) === "object";

/** The release both vendor keys signed, and keyring files holding the given keys. */
const files = async (keyrings: Readonly<Record<string, Buffer>>) => {
  const folder = await createTestTempDirectory("desktop-gpgv-");
  const release = join(folder, "InRelease");
  await writeFile(release, SIGNED_BY_BOTH);
  const paths: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(keyrings)) {
    paths[name] = join(folder, name);
    await writeFile(paths[name], bytes);
  }
  return { release, paths };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!hasGpgv)("withGpgvKeyCheck with gpgv", () => {
  it("accepts a key whose signature is good although the release's other signature has no key here", async () => {
    const { release, paths } = await files({ "a.gpg": VENDOR_A.key });

    const verified = await withGpgvKeyCheck(runHostQuery, undefined, (check) =>
      check.firstVerifying([paths["a.gpg"] ?? ""], [release]),
    );

    expect(verified).toMatchObject({
      path: paths["a.gpg"],
      format: "binary",
      fingerprint: VENDOR_A.fingerprint,
    });
  });

  it("retains only the verifying key of a keyring holding several", async () => {
    const { release, paths } = await files({
      "trusted.gpg": Buffer.concat([VENDOR_B.key, VENDOR_A.key]),
    });

    const verified = await withGpgvKeyCheck(runHostQuery, undefined, (check) =>
      check.firstVerifying([paths["trusted.gpg"] ?? ""], [release]),
    );

    if ("reason" in verified) throw new Error(verified.reason);
    expect(verified.fingerprint).toBe(VENDOR_A.fingerprint);
    expect(verified.bytes.equals(VENDOR_A.key)).toBe(true);
  });

  it("verifies the armored key a sources entry holds and retains it as it is, named by the entry's file", async () => {
    const { release } = await files({});
    const sources = "/etc/apt/sources.list.d/a-ubuntu-b-noble.sources";

    const verified = await withGpgvKeyCheck(runHostQuery, undefined, (check) =>
      check.heldVerifying({ path: sources, bytes: Buffer.from(A_ARMORED) }, [
        release,
      ]),
    );

    if ("reason" in verified) throw new Error(verified.reason);
    expect(verified).toMatchObject({
      path: sources,
      format: "armored",
      fingerprint: VENDOR_A.fingerprint,
    });
    expect(verified.bytes.toString()).toBe(A_ARMORED);
  });
});

describe("withGpgvKeyCheck cleanup", () => {
  it("keeps the private keyring folder's owner when its removal fails", async () => {
    const create = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
    let owned: PrivateRuntimeRoot | undefined;
    vi.spyOn(PrivateRuntimeRoot, "create").mockImplementationOnce(
      async (options) => {
        owned = await create(options);
        vi.spyOn(owned, "close").mockRejectedValueOnce(new Error("busy"));
        return owned;
      },
    );
    const { release, paths } = await files({ "a.gpg": VENDOR_A.key });
    const runQuery: QueryRunner = async () => ({ stdout: "", exitCode: 2 });

    const failure = await withGpgvKeyCheck(runQuery, undefined, (check) =>
      check.firstVerifying([paths["a.gpg"] ?? ""], [release]),
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    if (!(failure instanceof ArtifactReaderFailure) || owned === undefined)
      throw new Error("expected a cleanup failure");
    expect(failure.cleanup?.resources).toEqual([owned.path]);
    await access(owned.path);
    await Promise.all(
      failure.cleanupLeases?.map((lease) => lease.release()) ?? [],
    );
    await expect(access(owned.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a held key's keyring into the private folder and removes it, saying why the key does not verify", async () => {
    const { release } = await files({});
    const keyrings: string[] = [];
    const runQuery: QueryRunner = async (_command, argv) => {
      keyrings.push(argv[argv.indexOf("--keyring") + 1] ?? "");
      return { stdout: "[GNUPG:] NEWSIG\n", exitCode: 2 };
    };
    const sources = "/etc/apt/sources.list.d/a-ubuntu-b-noble.sources";

    const verified = await withGpgvKeyCheck(runQuery, undefined, (check) =>
      check.heldVerifying({ path: sources, bytes: Buffer.from(A_ARMORED) }, [
        release,
      ]),
    );

    if (!("reason" in verified)) throw new Error("expected a refusal");
    expect(verified.reason).toContain(sources);
    expect(verified.reason).toContain(release);
    expect(verified.reason).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//iu);
    expect(keyrings).toHaveLength(1);
    await expect(access(keyrings[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
