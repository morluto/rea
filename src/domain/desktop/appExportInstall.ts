import { err, ok, type Result } from "../result.js";
import { withoutCredentials } from "./aptRepositories.js";
import type { AptRepository, DesktopPackage } from "./desktopCapture.js";
import { unwrapDesktopCommand } from "./desktopEntry.js";

const NOBLE_SUITE =
  / noble(?:-updates|-security|-backports)?\/(?:main|restricted|universe|multiverse) /u;
/** Canonical's own archive hosts, for captures made before apt origins were recorded. */
const CANONICAL_ARCHIVE =
  /^https?:\/\/(?:[a-z]{2}\.)?(?:archive|ports|security)\.ubuntu\.com\//u;
/** The Debian architecture of each Node.js architecture an agentenv computer runs. */
const COMPUTER_ARCHITECTURES: ReadonlyMap<string, string> = new Map([
  ["x64", "amd64"],
  ["arm64", "arm64"],
]);

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
  /** The vendor release the package is taken from as `<package>/<release>`; null to install it by name. */
  readonly release: string | null;
  readonly libraryPackages: readonly string[];
  /** Empty when the package comes from the Ubuntu 24.04 archive. */
  readonly sources: readonly ExportAptSource[];
  /** Vendor repositories left out, each with why. */
  readonly skipped: readonly string[];
  /** The Debian architectures the bundle supports. */
  readonly architectures: readonly string[];
}

const describe = (repository: AptRepository): string =>
  repository.uri === null
    ? repository.source
    : `${withoutCredentials(repository.uri)} ${[repository.suite, ...repository.components].join(" ")}`;

/** Why the computer cannot install from a vendor repository, or undefined when the export can declare it. */
export const repositoryRefusal = (
  repository: AptRepository,
): string | undefined => {
  // A capture written before credentials were removed still holds them in its URI.
  if (
    repository.uri_credentials_removed === true ||
    (repository.uri !== null &&
      withoutCredentials(repository.uri) !== repository.uri)
  )
    return "its sources entry's URI held a user name or password, which REA neither records nor exports";
  if (repository.signing_key === null)
    return repository.signing_key_reason ?? "its signing key was not verified";
  if (repository.uri === null || repository.suite === null)
    return "no apt sources entry configures it";
  return /^https?:\/\//u.test(repository.uri)
    ? undefined
    : "agentenv installs apt repositories over http or https only";
};

/**
 * Why a repository's architecture restriction leaves out the host's. A
 * capture written before restrictions were recorded counts as unrestricted:
 * apt listed the installed version from it on that host.
 */
const architectureRefusal = (
  repository: AptRepository,
  architecture: string,
): string | undefined => {
  const served = repository.architectures ?? [];
  return served.length === 0 || served.includes(architecture)
    ? undefined
    : `it serves only ${served.join(", ")}, not the capture host's ${architecture}`;
};

/**
 * Each usable repository as an apt source, one per URI and suite since apt
 * allows one key for them: entries with the same key merge their
 * components, and one with another key is left out.
 */
const declaredSources = (
  repositories: readonly AptRepository[],
  environment: string,
  architecture: string,
) => {
  const declared = new Map<string, ExportAptSource>();
  const keyFiles = new Map<string, string>();
  const refused: string[] = [];
  let first: AptRepository | undefined;
  for (const repository of repositories) {
    const { uri, suite, components, signing_key: key } = repository;
    const reason =
      repositoryRefusal(repository) ??
      architectureRefusal(repository, architecture);
    if (
      reason !== undefined ||
      key === null ||
      uri === null ||
      suite === null
    ) {
      refused.push(`${describe(repository)}: ${reason ?? "it is unusable"}`);
      continue;
    }
    const id = `${uri}\n${suite}`;
    const existing = declared.get(id);
    if (existing !== undefined && existing.keySha256 !== key.sha256) {
      refused.push(
        `${describe(repository)}: apt takes one key per URI and suite, and ${existing.keyFile} is declared for them`,
      );
      continue;
    }
    const keyFile =
      keyFiles.get(key.sha256) ??
      `apt-keys/${environment}${keyFiles.size === 0 ? "" : `-${String(keyFiles.size + 1)}`}.${key.format === "armored" ? "asc" : "gpg"}`;
    keyFiles.set(key.sha256, keyFile);
    declared.set(id, {
      uri,
      suite,
      components: [
        ...new Set([...(existing?.components ?? []), ...components]),
      ],
      keyFile,
      keySha256: key.sha256,
    });
    first ??= repository;
  }
  return {
    sources: [...declared.values()],
    refused,
    release: first?.release ?? null,
  };
};

/**
 * Install from the Ubuntu 24.04 archive by name, or from each vendor
 * repository listing the installed version whose signing key the capture
 * verified and retained, taking the package from the first one's release
 * for the capture host's architecture; anything else is refused with the
 * reason.
 */
export const exportInstall = (
  installed: DesktopPackage,
  environment: string,
  hostArchitecture: string,
): Result<ExportInstall, string> => {
  const described = `${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}; sources: ${installed.sources.join(", ") || "none"}; apt origins: ${installed.source_origins?.map((origin) => origin ?? "none").join(", ") ?? "not recorded"}`;
  if (installed.kind !== "deb" || installed.name === null)
    return err(
      `The application is not an apt package (${described}), so the computer cannot install it.`,
    );
  const aptPackage = installed.name.split(":")[0] ?? installed.name;
  // An archive package's declared dependencies are complete; a vendor package's may not be.
  if (fromUbuntuNobleArchive(installed.sources, installed.source_origins))
    return ok({
      aptPackage,
      release: null,
      libraryPackages: [],
      sources: [],
      skipped: [],
      architectures: [...COMPUTER_ARCHITECTURES.values()],
    });
  const repositories = installed.apt_repositories ?? [];
  if (repositories.length === 0)
    return err(
      `The application is not installed from the Ubuntu 24.04 package archive or a vendor apt repository the capture recorded (${described}), so the computer cannot install it.`,
    );
  const architecture = COMPUTER_ARCHITECTURES.get(hostArchitecture);
  if (architecture === undefined)
    return err(
      `The capture host's architecture ${hostArchitecture} is not one an agentenv computer runs (${[...COMPUTER_ARCHITECTURES.keys()].join(", ")}), so its vendor packages may not suit the computer.`,
    );
  const { sources, refused, release } = declaredSources(
    repositories,
    environment,
    architecture,
  );
  if (sources.length === 0)
    return err(
      `The application comes from apt repositories the computer cannot use (${refused.join("; ")}).`,
    );
  return ok({
    aptPackage,
    release,
    libraryPackages: installed.library_packages ?? [],
    sources,
    skipped: refused,
    architectures: [architecture],
  });
};

/** Chromium's sandbox needs user namespaces a container does not grant, so an Electron launch runs with `--no-sandbox` right after the program. */
export const electronLaunchArguments = (
  argv: readonly string[],
  electron: boolean,
): readonly string[] => {
  if (!electron || argv.includes("--no-sandbox")) return argv;
  const wrapper = unwrapDesktopCommand(argv);
  const at = wrapper.kind === "direct" ? wrapper.index + 1 : 1;
  return [...argv.slice(0, at), "--no-sandbox", ...argv.slice(at)];
};

const unmappedLibraries = (installed: DesktopPackage): readonly string[] => [
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
];

/** What the export says about how the computer installs and starts the application. */
export const installLimitations = (
  install: ExportInstall,
  installed: DesktopPackage,
  electron: boolean,
): readonly string[] => {
  const unmapped = unmappedLibraries(installed);
  const vendor = install.sources.length > 0;
  return [
    vendor
      ? `The application is installed as ${install.aptPackage}${install.release === null ? "" : `/${install.release}`} from ${install.sources.map((source) => source.uri).join(", ")}, trusting the key that verified it on the capture host, so the computer installs the version that repository offers then, which may differ from the one captured; the bundle supports only the capture host's architecture, ${install.architectures.join(", ")}.`
      : "The application is installed from the distribution archive by name, so the computer may install a different version than the one captured.",
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
