import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  dearmorPublicKeys,
  isArmoredKey,
  validSignature,
  type ValidSignature,
} from "../domain/desktop/aptRepositories.js";
import { verifyingKey } from "../domain/desktop/openPgpKeys.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { readHostFile } from "./HostFileRead.js";
import type { QueryRunner } from "./HostQuery.js";

const FILE_MAX_BYTES = 1024 * 1024;

/** A candidate key file that verified a release, and the bytes of it to retain. */
export interface VerifiedKey {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly format: "armored" | "binary";
  /** The verifying primary key's fingerprint. */
  readonly fingerprint: string;
}

/** Runs gpgv on one candidate keyring at a time, written into a private folder it owns. */
class GpgvKeyCheck {
  #root: PrivateRuntimeRoot | undefined;
  #keyrings = 0;
  readonly #reads = new Map<string, Buffer | "missing" | "unreadable">();

  constructor(
    private readonly runQuery: QueryRunner,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** The private folder, once a keyring was written into it. */
  get root(): PrivateRuntimeRoot | undefined {
    return this.#root;
  }

  async #read(path: string): Promise<Buffer | "missing" | "unreadable"> {
    const read =
      this.#reads.get(path) ??
      (await readHostFile(path, FILE_MAX_BYTES, this.signal));
    this.#reads.set(path, read);
    return read;
  }

  /** The first candidate key that verifies the release, or why none did. */
  async firstVerifying(
    candidates: readonly string[],
    release: readonly string[],
  ): Promise<VerifiedKey | { readonly reason: string }> {
    const released = release[0] ?? "its release file";
    const unreadable: string[] = [];
    for (const path of candidates) {
      const bytes = await this.#read(path);
      if (bytes === "unreadable") unreadable.push(path);
      if (typeof bytes === "string") continue;
      const signature = await this.#verify(bytes, release);
      if (signature === "missing")
        return {
          reason:
            "gpgv is not installed, so no key could be checked against the repository's signature",
        };
      if (signature === undefined) continue;
      const kept = verifyingKey(bytes, signature.primary);
      if (!kept.ok)
        return { reason: `${path} verifies ${released}, but ${kept.error}` };
      return {
        path,
        ...kept.value,
        sha256: createHash("sha256").update(kept.value.bytes).digest("hex"),
        fingerprint: signature.primary,
      };
    }
    return {
      reason: `no candidate key (${candidates.join(", ")}) verifies ${released}${unreadable.length === 0 ? "" : `; unreadable: ${unreadable.join(", ")}`}`,
    };
  }

  /** The good signature gpgv reports with the key, whatever its exit status; `missing` without gpgv. */
  async #verify(
    key: Buffer,
    release: readonly string[],
  ): Promise<ValidSignature | "missing" | undefined> {
    const keyring = isArmoredKey(key) ? dearmorPublicKeys(key) : key;
    if (keyring === undefined) return undefined;
    this.#root ??= await PrivateRuntimeRoot.create({ prefix: "rea-apt-keys-" });
    const path = join(this.#root.path, `keyring-${String(this.#keyrings)}.gpg`);
    this.#keyrings += 1;
    await writeFile(path, keyring, { mode: 0o600, flag: "wx" });
    const outcome = await this.runQuery(
      "gpgv",
      [
        "--homedir",
        this.#root.path,
        "--status-fd",
        "1",
        "--keyring",
        path,
        ...release,
      ],
      this.signal,
    );
    if (outcome === "missing") return "missing";
    return typeof outcome === "object"
      ? validSignature(outcome.stdout)
      : undefined;
  }
}

/** Use a gpgv key check, then remove its private folder; a failed removal keeps the folder's owner in the thrown cleanup failure. */
export const withGpgvKeyCheck = async <Value>(
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
  use: (check: Pick<GpgvKeyCheck, "firstVerifying">) => Promise<Value>,
): Promise<Value> => {
  const check = new GpgvKeyCheck(runQuery, signal);
  let outcome:
    | { readonly kind: "completed"; readonly value: Value }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    outcome = { kind: "completed", value: await use(check) };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const root = check.root;
  if (root !== undefined) {
    const resources = new ArtifactResourceScope();
    const removed = await resources.release({
      kind: "private-runtime-root",
      resource: root.path,
      root,
    });
    if (removed.kind === "failed")
      throw resources.cleanupFailure(outcome, [removed]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};
