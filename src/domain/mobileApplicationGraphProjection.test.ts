import { expect, it } from "vitest";

import {
  projectedContentEntries,
  projectedFileComponents,
  projectedUnavailableComponents,
  type ProjectedInventoryEntry,
} from "./mobileApplicationGraphProjection.js";

it("selects file and slice facts without reordering or deduplicating occurrences", () => {
  const file: ProjectedInventoryEntry = {
    path: "member",
    kind: "file",
    unavailable: undefined,
    component: {
      path: "member",
      artifact_id: `art_${"a".repeat(64)}`,
      sha256: "b".repeat(64),
      format: "file",
    },
  };
  const slice: ProjectedInventoryEntry = {
    ...file,
    kind: "slice",
    component: { ...file.component, path: "member/arm64", format: "mach-o" },
    path: "member/arm64",
  };
  const unread: ProjectedInventoryEntry = {
    path: "unread",
    kind: "file",
    component: undefined,
    unavailable: {
      path: "unread",
      artifact_id: null,
      sha256: null,
      format: "file",
      encrypted: false,
      limitations: ["Content was not read."],
    },
  };
  // A link has no content bytes even when the inventory cannot authenticate it.
  const unreadLink: ProjectedInventoryEntry = {
    ...unread,
    path: "unread-link",
    kind: "symlink",
  };
  const entries = Object.freeze([
    { ...file, kind: "directory" as const },
    file,
    { ...file, kind: "symlink" as const },
    unreadLink,
    slice,
    unread,
    file,
  ]);
  expect(projectedContentEntries(entries)).toEqual([file, slice, unread, file]);
  const components = projectedFileComponents(entries);
  expect(components).toEqual([file.component, slice.component, file.component]);
  expect(components[0]).toBe(file.component);
  expect(components[1]).toBe(slice.component);
  expect(projectedUnavailableComponents(entries)).toEqual([unread.unavailable]);
  expect(entries[5]).toBe(unread);
});
