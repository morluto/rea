import type { ExportInstall, ExportPackageFile } from "./appExportInstall.js";
import type { DesktopPackage } from "./desktopCapture.js";

const unmappedLibraries = (
  installed: DesktopPackage,
  stranded: readonly string[],
): readonly string[] => [
  ...(installed.library_packages_reason === undefined
    ? []
    : [installed.library_packages_reason]),
  ...(installed.missing_libraries?.length
    ? [
        `not found on the capture host: ${installed.missing_libraries.join(", ")}`,
      ]
    : []),
  ...(installed.unpackaged_libraries?.length
    ? [`owned by no package: ${installed.unpackaged_libraries.join(", ")}`]
    : []),
  ...(installed.uninstallable_library_packages?.length
    ? [
        `in packages neither the Ubuntu 24.04 archive nor a declared repository offers: ${installed.uninstallable_library_packages.join(", ")}`,
      ]
    : []),
  ...(stranded.length > 0
    ? [
        `in packages only the apt repositories left out offer: ${stranded.join(", ")}`,
      ]
    : []),
];

/** What the export says about a package file the computer downloads and installs. */
const packageFileLimitations = (
  file: ExportPackageFile,
  installed: DesktopPackage,
): readonly string[] => [
  `The computer downloads the package from ${file.url} once, when the bundle is put, and refuses the download unless its SHA-256 is ${file.sha256}, the captured file's; the bundle does not contain the package. It installs exactly that file's version, ${installed.version ?? "unknown"}, with dpkg after the apt packages it depends on, and the bundle supports only its architecture, ${file.architecture}.`,
  "Vendor sites may refuse automated downloads, so the URL must point at a copy of the file the operator may use, and the package's licence, such as a trial's terms, is the operator's to check.",
  ...(file.unreadDependencies.length === 0
    ? []
    : [
        `REA could not read a package name from these dependencies, so the computer does not install them: ${file.unreadDependencies.join(", ")}.`,
      ]),
];

/** What the export says about how the computer installs and starts the application. */
export const installLimitations = (
  install: ExportInstall,
  installed: DesktopPackage,
  electron: boolean,
): readonly string[] => {
  const unmapped = unmappedLibraries(installed, install.strandedPackages ?? []);
  // Library packages matter for any package the archive does not install by name.
  const vendor = install.sources.length > 0 || install.packageFile !== null;
  return [
    ...(install.packageFile !== null
      ? packageFileLimitations(install.packageFile, installed)
      : [
          install.sources.length > 0
            ? `The application is installed as ${install.aptPackage}${install.release === null ? "" : `/${install.release}`} from ${install.sources.map((source) => source.uri).join(", ")}, trusting the key that verified it on the capture host, so the computer installs the version that repository offers then, which may differ from the one captured; the bundle supports only the capture host's architecture, ${install.architectures.join(", ")}.`
            : "The application is installed from the distribution archive by name, so the computer may install a different version than the one captured.",
        ]),
    ...(install.extraPackages === undefined
      ? []
      : [
          `The computer installs ${install.extraPackages.join(", ")} beside the application because the export was asked for them with --extra-package, as a build computer asks for the packages its request named.`,
        ]),
    ...install.skipped.map(
      (repository) => `The apt repository ${repository} was left out.`,
    ),
    ...(vendor && installed.library_packages === undefined
      ? [
          "The capture did not record the executable's library packages, so the computer installs only what the package depends on.",
        ]
      : []),
    ...(!vendor || unmapped.length === 0
      ? []
      : [
          `Not every library the executable loads is installed with it (${unmapped.join("; ")}), so the computer may lack some.`,
        ]),
    ...(electron
      ? [
          "Chromium's sandbox is off inside the computer (--no-sandbox): it needs user namespaces the computer's container does not grant, and Electron exits without them.",
        ]
      : []),
  ];
};
