import { err, ok, type Result } from "../result.js";
import type { AptRepository, DesktopPackage } from "./desktopCapture.js";

const NOBLE_SUITE =
  / noble(?:-updates|-security|-backports)?\/(?:main|restricted|universe|multiverse) /u;
/** Canonical's own archive hosts, for captures made before apt origins were recorded. */
const CANONICAL_ARCHIVE =
  /^https?:\/\/(?:[a-z]{2}\.)?(?:archive|ports|security)\.ubuntu\.com\//u;

/**
 * Whether apt installed the package from the Ubuntu 24.04 archive, which the
 * computer installs from by name: a noble suite whose apt origin is Ubuntu,
 * so mirrors count and PPAs or other repositories do not.
 */
export const fromUbuntuNobleArchive = (
  sources: readonly string[],
  origins: readonly (string | null)[] | undefined,
): boolean =>
  sources.some(
    (source, index) =>
      NOBLE_SUITE.test(source) &&
      (origins === undefined
        ? CANONICAL_ARCHIVE.test(source)
        : origins[index] === "Ubuntu"),
  );

/** A vendor apt repository the bundle declares, with its retained key copied into the environment folder. */
export interface ExportAptSource {
  readonly uri: string;
  readonly suite: string;
  readonly components: readonly string[];
  /** The key file's path in the environment folder. */
  readonly keyFile: string;
  readonly keySha256: string;
}

/** How the computer installs the captured package. */
export interface ExportInstall {
  readonly aptPackage: string;
  readonly libraryPackages: readonly string[];
  /** Empty when the package comes from the Ubuntu 24.04 archive. */
  readonly sources: readonly ExportAptSource[];
  /** Vendor repositories left out, each with why its key was not used. */
  readonly skipped: readonly string[];
}

const describe = (repository: AptRepository): string =>
  repository.uri === null
    ? repository.source
    : `${repository.uri} ${[repository.suite, ...repository.components].join(" ")}`;

/** Why a vendor repository cannot be declared, or undefined when it can. */
const unusable = (repository: AptRepository): string | undefined => {
  if (repository.signing_key === null)
    return repository.signing_key_reason ?? "its signing key was not verified";
  if (repository.uri === null || repository.suite === null)
    return "no apt sources entry configures it";
  return /^https?:\/\//u.test(repository.uri)
    ? undefined
    : "agentenv installs apt repositories over http or https only";
};

/**
 * Install from the Ubuntu 24.04 archive by name, or from each vendor
 * repository listing the installed version whose signing key the capture
 * verified and retained; anything else is refused with the reason.
 */
export const exportInstall = (
  installed: DesktopPackage,
  environment: string,
): Result<ExportInstall, string> => {
  const described = `${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}; sources: ${installed.sources.join(", ") || "none"}; apt origins: ${installed.source_origins?.map((origin) => origin ?? "none").join(", ") ?? "not recorded"}`;
  if (installed.kind !== "deb" || installed.name === null)
    return err(
      `The application is not an apt package (${described}), so the computer cannot install it.`,
    );
  const aptPackage = installed.name.split(":")[0] ?? installed.name;
  // An archive package's declared dependencies are complete; a vendor package's may not be.
  if (fromUbuntuNobleArchive(installed.sources, installed.source_origins))
    return ok({ aptPackage, libraryPackages: [], sources: [], skipped: [] });
  const libraryPackages = installed.library_packages ?? [];
  const repositories = installed.apt_repositories ?? [];
  const refused = repositories.flatMap((repository) => {
    const reason = unusable(repository);
    return reason === undefined ? [] : [`${describe(repository)}: ${reason}`];
  });
  const keyFiles = new Map<string, string>();
  const sources = repositories.flatMap((repository) => {
    const { uri, suite, components, signing_key: key } = repository;
    if (
      unusable(repository) !== undefined ||
      key === null ||
      uri === null ||
      suite === null
    )
      return [];
    const extension = key.format === "armored" ? "asc" : "gpg";
    const keyFile =
      keyFiles.get(key.sha256) ??
      `apt-keys/${environment}${keyFiles.size === 0 ? "" : `-${String(keyFiles.size + 1)}`}.${extension}`;
    keyFiles.set(key.sha256, keyFile);
    return [{ uri, suite, components, keyFile, keySha256: key.sha256 }];
  });
  if (sources.length === 0)
    return err(
      repositories.length === 0
        ? `The application is not installed from the Ubuntu 24.04 package archive or a vendor apt repository the capture recorded (${described}), so the computer cannot install it.`
        : `The application comes from apt repositories whose signing keys the capture did not verify (${refused.join("; ")}), so the computer would not trust them.`,
    );
  return ok({ aptPackage, libraryPackages, sources, skipped: refused });
};

/** Chromium's sandbox needs user namespaces a container does not grant, so an Electron launch runs with `--no-sandbox`. */
export const electronLaunchArguments = (
  argv: readonly string[],
  electron: boolean,
): readonly string[] =>
  !electron || argv.includes("--no-sandbox")
    ? argv
    : [...argv.slice(0, 1), "--no-sandbox", ...argv.slice(1)];

/** What the export says about how the computer installs and starts the application. */
export const installLimitations = (
  install: ExportInstall,
  installed: DesktopPackage,
  electron: boolean,
): readonly string[] => {
  const unmapped = [
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
  ];
  return [
    install.sources.length === 0
      ? "The application is installed from the distribution archive by name, so the computer may install a different version than the one captured."
      : `The application is installed by name from ${install.sources.map((source) => source.uri).join(", ")}, trusting the key that verified it on the capture host, so the computer installs the version that repository offers then, which may differ from the one captured.`,
    ...install.skipped.map(
      (repository) => `The apt repository ${repository} was left out.`,
    ),
    ...(install.sources.length > 0 && installed.library_packages === undefined
      ? [
          "The capture did not record the executable's library packages, so the computer installs only what the package depends on.",
        ]
      : []),
    ...(install.sources.length === 0 || unmapped.length === 0
      ? []
      : [
          `Not every library the executable loads was mapped to a package (${unmapped.join("; ")}), so the computer may lack some.`,
        ]),
    ...(electron
      ? [
          "Chromium's sandbox is off inside the computer (--no-sandbox): it needs user namespaces the computer's container does not grant, and Electron exits without them.",
        ]
      : []),
  ];
};
