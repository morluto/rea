import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PRODUCT_IDENTITY } from "../identity.js";

/**
 * The code that produced a cached or committed result: the REA release that
 * ran it and the packaged scripts it handed to an engine. A cache key or
 * analysis profile that includes this identity is invalidated by any REA
 * release or script edit, so producers do not hand-maintain revision markers
 * for their own behaviour. Markers remain only for runtime-selected semantics.
 */
export type ProducerIdentity = Readonly<{
  rea_version: string;
  sources_sha256: string;
}>;

/**
 * SHA-256 over the named packaged sources in `directory`, in name order, each
 * framed by its name and byte length. A missing source throws: a producer
 * whose scripts are not packaged cannot run, so it has no identity either.
 */
export const packagedSourcesDigest = (
  directory: URL,
  names: readonly string[],
): string => {
  const hash = createHash("sha256");
  for (const name of [...names].sort()) {
    const bytes = readFileSync(new URL(name, directory));
    hash.update(JSON.stringify([name, bytes.byteLength])).update(bytes);
  }
  return hash.digest("hex");
};

/**
 * One identity per packaged producer, computed on first use. Packaged sources
 * do not change while REA runs, so the digest is read once per process.
 */
export const packagedProducerIdentity = (
  directory: URL,
  names: readonly string[],
): (() => ProducerIdentity) => {
  let identity: ProducerIdentity | undefined;
  return () =>
    (identity ??= Object.freeze({
      rea_version: PRODUCT_IDENTITY.packageVersion,
      sources_sha256: packagedSourcesDigest(directory, names),
    }));
};
