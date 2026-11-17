import { expect, it } from "vitest";

import { InternalInvariantError } from "../domain/internalInvariant.js";
import { hashManagedSource, readManagedSnapshot } from "./ManagedSnapshot.js";

// The input schema admits only positive integer snapshot allowances, so any
// other allowance is a REA defect, refused before the file is opened.
it.each([
  ["read", readManagedSnapshot],
  ["hash", hashManagedSource],
] as const)(
  "reports a nonpositive snapshot allowance to %s as a broken internal assumption",
  async (_name, read) => {
    await expect(
      read("/nonexistent/rea-managed-snapshot", "inspect_managed_artifact", {
        maxBytes: 0,
      }),
    ).rejects.toBeInstanceOf(InternalInvariantError);
  },
);
