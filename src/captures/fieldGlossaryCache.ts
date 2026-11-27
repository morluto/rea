import { createHash } from "node:crypto";

import type { ParsedFieldGlossaryRecord } from "./parseFieldDiscovery.js";

/**
 * Identity of the TShark installation a cached glossary describes. The
 * glossary depends only on the installation, never on capture traffic, so
 * these facts fully determine the parsed records — including the installed
 * dissector plugins, which can add, remove, or rename registrations without
 * changing the executable or its version banner.
 */
export interface FieldGlossaryIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly versionBanner: string;
  /** SHA-256 of the installed plugin list; see {@link pluginListDigest}. */
  readonly pluginsDigest: string;
}

/**
 * Digest a `tshark -G plugins` report into one stable value. Lines are
 * sorted before hashing so plugin load order never invalidates the snapshot;
 * any installed, removed, upgraded, or relocated plugin changes the digest.
 * A plugin file replaced in place without a version change is not detected —
 * the session boundary (provider close) is the refresh point for that case.
 */
export const pluginListDigest = (pluginsReport: string): string =>
  createHash("sha256")
    .update(
      pluginsReport
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
        .filter((line) => line.length > 0)
        .sort()
        .join("\n"),
      "utf8",
    )
    .digest("hex");

/**
 * Upper bound on the retained glossary source bytes for one cached identity.
 * Retained heap is a small constant multiple of source bytes (one small
 * detached record object per line), so this also bounds memory; a larger
 * installation simply skips caching and keeps per-request behavior.
 */
export const FIELD_GLOSSARY_CACHE_BUDGET = 64 * 1024 * 1024;

/** Maximum retained records for one cached identity. */
export const FIELD_GLOSSARY_CACHE_MAX_RECORDS = 1_000_000;

export interface FieldGlossaryCache {
  /** Parsed records for this exact tool identity, or undefined on a miss. */
  readonly lookup: (
    identity: FieldGlossaryIdentity,
  ) => readonly ParsedFieldGlossaryRecord[] | undefined;
  /**
   * Retain parsed records under this identity. Returns false (and retains
   * nothing) when the glossary exceeds the cache budget.
   */
  readonly store: (
    identity: FieldGlossaryIdentity,
    records: readonly ParsedFieldGlossaryRecord[],
  ) => boolean;
  /** Drop any retained glossary, for example when the provider closes. */
  readonly clear: () => void;
}

/**
 * Single-entry, session-scoped cache for one parsed TShark field glossary.
 * A new tool identity replaces the previous entry; there is no cross-session
 * or cross-tool sharing.
 */
export const createFieldGlossaryCache = (): FieldGlossaryCache => {
  let entry:
    | {
        readonly identity: FieldGlossaryIdentity;
        readonly records: readonly ParsedFieldGlossaryRecord[];
      }
    | undefined;
  return {
    lookup(identity) {
      if (entry === undefined) return undefined;
      const current = entry.identity;
      return current.path === identity.path &&
        current.sha256 === identity.sha256 &&
        current.versionBanner === identity.versionBanner &&
        current.pluginsDigest === identity.pluginsDigest
        ? entry.records
        : undefined;
    },
    store(identity, records) {
      let sourceBytes = 0;
      for (const record of records) sourceBytes += record.sourceByteLength;
      if (
        sourceBytes > FIELD_GLOSSARY_CACHE_BUDGET ||
        records.length > FIELD_GLOSSARY_CACHE_MAX_RECORDS
      )
        return false;
      entry = { identity, records: [...records] };
      return true;
    },
    clear() {
      entry = undefined;
    },
  };
};
