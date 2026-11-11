import type { BigIntStats } from "node:fs";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { StableArtifactSnapshot } from "../../artifacts/readStableArtifact.js";
import type { MftIndex } from "../../domain/windows/ntfsMft.js";
import { createUsnMftCorrelator } from "../../domain/windows/ntfsJournalCorrelation.js";

export interface NtfsAcquisition {
  readonly path: string;
  readonly snapshot: StableArtifactSnapshot;
  readonly state: BigIntStats;
}
export interface NtfsJournalPair {
  readonly mft: NtfsAcquisition;
  readonly journal: NtfsAcquisition;
  readonly image: MftIndex;
  readonly correlate: ReturnType<typeof createUsnMftCorrelator>;
}

/** One completed digest-bound pair per resource scope; no descriptors or negative entries. */
export class NtfsJournalCache {
  #pair: NtfsJournalPair | undefined;
  #active = false;

  begin(): boolean {
    if (this.#active) return false;
    this.#active = true;
    return true;
  }
  end(): void {
    this.#active = false;
  }
  clear(): void {
    this.#pair = undefined;
  }
  select(mftPath: string, journalPath: string): NtfsJournalPair | undefined {
    if (
      this.#pair?.mft.path !== mftPath ||
      this.#pair.journal.path !== journalPath
    )
      this.clear();
    return this.#pair;
  }
  retain(
    mft: NtfsAcquisition,
    journal: NtfsAcquisition,
    image: MftIndex,
  ): NtfsJournalPair {
    const pair = {
      mft,
      journal,
      image,
      correlate: createUsnMftCorrelator(image.records),
    };
    this.#pair = pair;
    return pair;
  }
}
const scopedCaches = new WeakMap<ArtifactResourceScope, NtfsJournalCache>();

/** Scope shutdown clears retained bytes after admitted operations and cleanup settle. */
export const ntfsJournalCacheFor = (
  resources: ArtifactResourceScope,
): NtfsJournalCache => {
  let cache = scopedCaches.get(resources);
  if (cache === undefined) {
    cache = new NtfsJournalCache();
    const owned = cache;
    resources.addCloseHook(async () => {
      owned.clear();
    });
    scopedCaches.set(resources, cache);
  }
  return cache;
};
