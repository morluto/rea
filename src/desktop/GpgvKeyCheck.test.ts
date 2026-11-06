import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
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
});
