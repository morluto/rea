import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHostQuery } from "./HostQuery.js";
import { inspectLibraryPackages } from "./LibraryPackageInventory.js";

describe.skipIf(
  process.platform !== "linux" || !existsSync("/var/lib/dpkg/status"),
)("inspectLibraryPackages on a Debian host", () => {
  it("maps the running node binary's libraries to their packages", async () => {
    const executable = await realpath(process.execPath);

    const libraries = await inspectLibraryPackages(
      executable,
      "nodejs",
      runHostQuery,
      undefined,
    );

    expect(libraries).not.toHaveProperty("library_packages_reason");
    expect(libraries.library_packages).toContain("libc6");
    expect(libraries.missing_libraries).toEqual([]);
  });

  it("explains a launcher script instead of reading it as ELF", async () => {
    const libraries = await inspectLibraryPackages(
      "/usr/bin/ldd",
      "libc-bin",
      runHostQuery,
      undefined,
    );

    expect(libraries).toEqual({
      library_packages: [],
      missing_libraries: [],
      unpackaged_libraries: [],
      library_packages_reason:
        "the libraries of /usr/bin/ldd were not read: not an ELF image",
    });
  });
});
