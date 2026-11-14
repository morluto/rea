import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
import type {
  DesktopContentStore,
  RetainOutcome,
} from "../../desktop/DesktopContentStore.js";

const OMITTED: Readonly<
  Record<Extract<RetainOutcome, { kind: "omitted" }>["reason"], string>
> = {
  too_large: "is larger than the capture's per-file limit (--max-file-bytes)",
  budget_exhausted: "did not fit the capture's content budget",
  changed_since_walk: "changed before it was stored",
  changed_during_read: "changed before it was stored",
  unreadable: "could not be stored",
};

/** Retain each verified apt key; a key the content store refuses is recorded as unverified, with why. */
export const retainSigningKeys = async (
  inventory: DesktopApplicationInventory,
  keys: ReadonlyMap<string, Buffer>,
  store: Pick<DesktopContentStore, "retainBytes">,
): Promise<DesktopApplicationInventory> => {
  const omitted = new Map<string, string>();
  for (const [sha256, bytes] of keys) {
    const stored = await store.retainBytes(bytes);
    if (stored.kind === "omitted") omitted.set(sha256, OMITTED[stored.reason]);
  }
  const repositories = inventory.package.apt_repositories;
  if (omitted.size === 0 || repositories === undefined) return inventory;
  return {
    ...inventory,
    package: {
      ...inventory.package,
      apt_repositories: repositories.map((repository) => {
        const key = repository.signing_key;
        const reason = key === null ? undefined : omitted.get(key.sha256);
        if (key === null || reason === undefined) return repository;
        return {
          ...repository,
          signing_key: null,
          signing_key_reason: `the verified key ${key.path} ${reason}, so it was not retained`,
        };
      }),
    },
  };
};
