import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
import type { DesktopContentStore } from "../../desktop/DesktopContentStore.js";

/** Retain each verified apt key; a key the content budget cannot hold is recorded as unverified. */
export const retainSigningKeys = async (
  inventory: DesktopApplicationInventory,
  keys: ReadonlyMap<string, Buffer>,
  store: Pick<DesktopContentStore, "retainBytes">,
): Promise<DesktopApplicationInventory> => {
  const kept = new Set<string>();
  for (const [sha256, bytes] of keys)
    if ((await store.retainBytes(bytes)).kind === "retained") kept.add(sha256);
  const repositories = inventory.package.apt_repositories;
  if (kept.size === keys.size || repositories === undefined) return inventory;
  return {
    ...inventory,
    package: {
      ...inventory.package,
      apt_repositories: repositories.map(({ signing_key, ...repository }) =>
        signing_key === null || kept.has(signing_key.sha256)
          ? { ...repository, signing_key }
          : {
              ...repository,
              signing_key: null,
              signing_key_reason: `the capture's content budget had no room for the verified key ${signing_key.path}`,
            },
      ),
    },
  };
};
