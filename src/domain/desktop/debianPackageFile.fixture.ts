import type { DesktopPackage, DesktopPackageFile } from "./desktopCapture.js";

/**
 * `dpkg-deb --field FILE Package Version Architecture Depends Pre-Depends`
 * from dpkg 1.22.6 on Ubuntu 24.04, for a package built with alternatives,
 * version constraints and a `:any` qualifier in its Depends.
 */
export const DPKG_DEB_OUTPUT = [
  "Package: varicad2026-en",
  "Version: 1:2.03-1",
  "Architecture: amd64",
  "Depends: libc6 (>= 2.34), libgl1 | libgl1-mesa-glx, libstdc++6:any (>= 12), libx11-6, libfontconfig1 (>= 2.12.6)",
  "Pre-Depends: dpkg (>= 1.15.6)",
  "",
].join("\n");

export const VARICAD_URL =
  "https://mirror.example.com/varicad/varicad2026-en_2.03_amd64.deb";

/** The .deb VariCAD was installed from, as the capture records it. */
export const VARICAD_FILE: DesktopPackageFile = {
  name: "varicad2026-en_2.03_amd64.deb",
  sha256: "d".repeat(64),
  size: 312_000_000,
  package: "varicad2026-en",
  version: "2.03",
  architecture: "amd64",
  depends: [
    "libc6 (>= 2.34)",
    "libgl1 | libgl1-mesa-glx",
    "libstdc++6:any (>= 12)",
  ],
  pre_depends: ["dpkg (>= 1.15.6)"],
};

/** VariCAD installed from its downloaded .deb, which no apt source lists. */
export const varicadPackage = (
  overrides: Partial<DesktopPackage> = {},
): DesktopPackage => ({
  kind: "deb",
  name: "varicad2026-en",
  version: "2.03",
  architecture: "amd64",
  sources: [],
  source_origins: [],
  package_lists_present: true,
  apt_repositories: [],
  library_packages: ["libgl1", "libxt6t64"],
  uninstallable_library_packages: [],
  missing_libraries: [],
  unpackaged_libraries: [],
  package_file: VARICAD_FILE,
  ...overrides,
});
