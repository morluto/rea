import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armor,
  createMessage,
  enums,
  generateKey,
  readKey,
  readKeys,
  sign,
} from "openpgp";

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

describe.skipIf(!hasGpgv)("retained signing-key versions", () => {
  it.each(["file", "held"] as const)(
    "keeps the verifying primary's key versions without trusting another primary: %s",
    async (source) => {
      const { privateKey } = await generateKey({
        type: "ecc",
        curve: "curve25519Legacy",
        userIDs: [{ name: "Versioned repository fixture" }],
        subkeys: [{ sign: true }, { sign: true }, { sign: true }],
        date: new Date("2024-01-01T00:00:00Z"),
        format: "object",
      });
      const primary = privateKey.getFingerprint().toUpperCase();
      const versions = await Promise.all(
        privateKey.subkeys.map(async (_, index) => {
          const key = await readKey({
            binaryKey: privateKey.toPublic().write(),
          });
          key.subkeys = key.subkeys.slice(index, index + 1);
          return Buffer.from(key.write());
        }),
      );
      // The signing subkey is in neither the first nor last version, in either order.
      const ordered = source === "file" ? versions : versions.toReversed();
      const keyring = Buffer.concat([
        ordered[0]!,
        VENDOR_B.key,
        ordered[1]!,
        ordered[2]!,
      ]);
      const folder = await createTestTempDirectory("desktop-gpgv-versions-");
      const release = join(folder, "Release");
      const signature = `${release}.gpg`;
      const bytes = Buffer.from(
        "Origin: Versioned repository fixture\nSuite: stable\n",
      );
      await writeFile(release, bytes);
      await writeFile(
        signature,
        await sign({
          message: await createMessage({ binary: bytes }),
          signingKeys: privateKey,
          signingKeyIDs: [privateKey.subkeys[1]!.getKeyID()],
          detached: true,
          format: "binary",
        }),
      );
      const path = join(
        folder,
        source === "file" ? "vendor.gpg" : "vendor.sources",
      );
      if (source === "file") await writeFile(path, keyring);
      const verified = await withGpgvKeyCheck(
        runHostQuery,
        undefined,
        (check) =>
          source === "file"
            ? check.firstVerifying([path], [signature, release])
            : check.heldVerifying(
                {
                  path,
                  bytes: Buffer.from(armor(enums.armor.publicKey, keyring)),
                },
                [signature, release],
              ),
      );
      if ("reason" in verified) throw new Error(verified.reason);
      expect(verified.fingerprint).toBe(primary);
      // Keeping the complete input would make this pass crypto but broaden trust.
      const retainedKeys = await readKeys({ binaryKeys: verified.bytes });
      expect(
        new Set(retainedKeys.map((key) => key.getFingerprint().toUpperCase())),
      ).toEqual(new Set([primary]));
      const retained = join(folder, "retained.gpg");
      await writeFile(retained, verified.bytes);
      const replay = await runHostQuery(
        "gpgv",
        [
          "--homedir",
          folder,
          "--status-fd",
          "1",
          "--keyring",
          retained,
          signature,
          release,
        ],
        undefined,
      );
      expect(replay).toMatchObject({ exitCode: 0 });
      if (typeof replay === "object")
        expect(replay.stdout).toContain("[GNUPG:] VALIDSIG ");
    },
  );
});

describe("withGpgvKeyCheck cleanup", () => {
  it.each(["completed", "failed"])(
    "observes cancellation during final keyring cleanup after %s work",
    async (completion) => {
      const cancel = new AbortController();
      const reason = new Error("cancelled during keyring cleanup");
      const primary = new Error("verification failed");
      const create = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
      let path: string | undefined;
      vi.spyOn(PrivateRuntimeRoot, "create").mockImplementationOnce(
        async (options) => {
          const root = await create(options);
          path = root.path;
          const close = root.close.bind(root);
          vi.spyOn(root, "close").mockImplementationOnce(async () => {
            cancel.abort(reason);
            await close();
          });
          return root;
        },
      );
      const { release, paths } = await files({ "a.gpg": VENDOR_A.key });
      const result = withGpgvKeyCheck(
        async () => ({ stdout: "", exitCode: 2 }),
        cancel.signal,
        async (check) => {
          const verified = await check.firstVerifying(
            [paths["a.gpg"] ?? ""],
            [release],
          );
          if (completion === "failed") throw primary;
          return verified;
        },
      );
      if (completion === "failed") await expect(result).rejects.toBe(primary);
      else {
        const failure = await result.catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        if (!(failure instanceof ArtifactReaderFailure))
          throw new Error("Expected typed keyring cleanup cancellation");
        expect(failure.reason).toBe("cancelled");
        expect(failure.cause).toBe(reason);
      }
      expect(path).toBeDefined();
      await expect(access(path ?? "")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

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
