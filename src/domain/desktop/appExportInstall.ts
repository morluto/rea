import { err, ok, type Result } from "../result.js";
import { withoutCredentials, withoutCredentialsIn } from "./aptRepositories.js";
import { dependencyPackages } from "./debianPackageFile.js";
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

/** A captured package file the computer downloads when the bundle is put and installs with dpkg. */
export interface ExportPackageFile {
  readonly url: string;
  readonly sha256: string;
  /** Where the download is put, in the environment folder. */
  readonly path: string;
  readonly architecture: string;
  /** apt packages installed before it: the first alternative of each of its Depends and Pre-Depends entries. */
  readonly dependencies: readonly string[];
  /** Relationship entries that name no package REA could read. */
  readonly unreadDependencies: readonly string[];
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
  /** The package file installed in place of an apt package; null when apt installs the package. */
  readonly packageFile: ExportPackageFile | null;
  /** The package of the program the desktop entry runs, installed by name beside the app's; absent when the app's package owns it. */
  readonly executablePackage?: string;
  /** Packages the capture found only in repositories the export leaves out, which the computer cannot install. */
  readonly strandedPackages?: readonly string[];
}

/** Why the computer cannot install the captured package: the input to change, and how. */
export interface InstallRefusal {
  readonly field: "capture" | "package_url";
  readonly reason: string;
  readonly remediation: string;
}

/** The run script that installs a downloaded package file. */
export const INSTALL_SCRIPT = "install-package.sh";

const CAPTURE_REMEDIATION =
  "Capture an application installed with apt from the Ubuntu 24.04 archive, or from a vendor repository reached over http or https on an amd64 or arm64 host where apt trusts its key and gpgv is installed. For one installed from a downloaded .deb file, capture it with --package-file and export it with --package-url.";

const refusal = (
  reason: string,
  field: InstallRefusal["field"] = "capture",
  remediation = CAPTURE_REMEDIATION,
): InstallRefusal => ({ field, reason, remediation });

const describe = (repository: AptRepository): string =>
  repository.uri === null
    ? withoutCredentialsIn(repository.source)
    : `${withoutCredentials(repository.uri)} ${[repository.suite, ...repository.components].join(" ")}`;

/** A repository from a capture written before credentials were removed whose URI still holds them. */
const heldCredentials = (repository: AptRepository): boolean =>
  repository.uri !== null &&
  withoutCredentials(repository.uri) !== repository.uri;

/** Why the computer cannot install from a vendor repository, or undefined when the export can declare it. */
export const repositoryRefusal = (
  repository: AptRepository,
): string | undefined => {
  if (
    repository.uri_credentials_removed === true ||
    heldCredentials(repository)
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
  const kept: AptRepository[] = [];
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
    kept.push(repository);
  }
  return {
    sources: [...declared.values()],
    refused,
    release: kept[0]?.release ?? null,
    kept,
  };
};

/**
 * The library packages the computer installs given the repositories the
 * export declares, and the packages it cannot: those only repositories it
 * leaves out supply, such as one whose key the capture could not retain.
 */
const suppliedLibraries = (
  installed: DesktopPackage,
  kept: readonly AptRepository[],
): Pick<ExportInstall, "libraryPackages" | "strandedPackages"> => {
  const repositories = installed.apt_repositories ?? [];
  const supplied = new Set(
    kept.flatMap((repository) => repository.supplies ?? []),
  );
  const stranded = [
    ...new Set(
      repositories
        .filter((repository) => !kept.includes(repository))
        .flatMap((repository) => repository.supplies ?? []),
    ),
  ]
    .filter((name) => !supplied.has(name))
    .sort();
  return {
    libraryPackages: (installed.library_packages ?? []).filter(
      (name) => !stranded.includes(name),
    ),
    ...(stranded.length === 0 ? {} : { strandedPackages: stranded }),
  };
};

const describePackage = (installed: DesktopPackage): string =>
  `${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}; sources: ${installed.sources.map(withoutCredentialsIn).join(", ") || "none"}; apt origins: ${installed.source_origins === undefined ? "not recorded" : installed.source_origins.map((origin) => origin ?? "none").join(", ") || "none"}`;

/** A package no apt source the capture recorded lists: from its recorded package file, or else with how to record one. */
const localInstallRefusal = (installed: DesktopPackage): InstallRefusal => {
  const file = installed.package_file;
  if (file !== undefined)
    return refusal(
      `The application was installed from ${file.name}, which no apt repository the capture recorded lists (${describePackage(installed)}), so the computer can install it only from a copy of that file.`,
      "package_url",
      `Pass --package-url with an http or https URL the computer may download ${file.name} from, byte for byte the captured file.`,
    );
  const reason = installed.package_file_reason;
  return refusal(
    `The application is not installed from the Ubuntu 24.04 package archive or a vendor apt repository the capture recorded (${describePackage(installed)}), so the computer cannot install it by name. An application installed from a downloaded .deb file is exported with --package-url once it was captured with --package-file${reason === undefined ? "" : `, which this capture could not record: ${reason}`}.`,
    "capture",
    "Capture again with --package-file naming the .deb file the application was installed from, then export with --package-url naming where the computer may download that file.",
  );
};

/** Each usable vendor repository as an apt source, or why the computer cannot install from them, with the repositories left out. */
const vendorInstall = (
  installed: DesktopPackage,
  aptPackage: string,
  environment: string,
  hostArchitecture: string,
): Result<
  ExportInstall,
  { readonly refusal: InstallRefusal; readonly skipped: readonly string[] }
> => {
  const repositories = installed.apt_repositories ?? [];
  if (repositories.length === 0)
    return err({ refusal: localInstallRefusal(installed), skipped: [] });
  // Such a capture counted that repository's libraries as installable.
  if (repositories.some(heldCredentials))
    return err({
      refusal: refusal(
        "The capture recorded a user name or password in an apt repository's URI, from before REA removed them, so it cannot tell which library packages only that repository offers.",
        "capture",
        "Capture the application again.",
      ),
      skipped: [],
    });
  const architecture = COMPUTER_ARCHITECTURES.get(hostArchitecture);
  if (architecture === undefined)
    return err({
      refusal: refusal(
        `The capture host's architecture ${hostArchitecture} is not one an agentenv computer runs (${[...COMPUTER_ARCHITECTURES.keys()].join(", ")}), so its vendor packages may not suit the computer.`,
      ),
      skipped: [],
    });
  const { sources, refused, release, kept } = declaredSources(
    repositories,
    environment,
    architecture,
  );
  if (sources.length === 0)
    return err({
      refusal: refusal(
        `The application comes from apt repositories the computer cannot use (${refused.join("; ")}).`,
      ),
      skipped: refused,
    });
  return ok({
    aptPackage,
    release,
    ...suppliedLibraries(installed, kept),
    sources,
    skipped: refused,
    architectures: [architecture],
    packageFile: null,
  });
};

/** Why agentenv cannot download from a URL, or undefined when it can: http or https, spelled so, without a user name or password. */
const packageUrlRefusal = (url: string): string | undefined => {
  // No refusal repeats the URL, and credentials are checked first, so a password in it is never echoed.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "--package-url is not a URL";
  }
  if (parsed.username !== "" || parsed.password !== "")
    return "--package-url holds a user name or password, which the bundle would keep in plain text";
  return /^https?:\/\//u.test(url) &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
    ? undefined
    : "--package-url does not start with http:// or https:// in lowercase, the only URLs the computer downloads";
};

/** The captured package file from the caller's URL, after its dependencies and library packages, for the file's architecture. */
const packageFileInstall = (
  installed: DesktopPackage,
  named: Pick<ExportInstall, "aptPackage" | "skipped">,
  packageUrl: string,
  hostArchitecture: string,
): Result<ExportInstall, InstallRefusal> => {
  const file = installed.package_file;
  const recordFile =
    "Capture again with --package-file naming the .deb file the installed version came from.";
  if (file === undefined)
    return err(
      refusal(
        installed.package_file_reason === undefined
          ? `--package-url was given, but the capture recorded no package file for ${named.aptPackage}.`
          : `--package-url was given, but the capture did not record its package file: ${installed.package_file_reason}.`,
        "capture",
        recordFile,
      ),
    );
  const url = packageUrlRefusal(packageUrl);
  if (url !== undefined)
    return err(
      refusal(
        url,
        "package_url",
        "Pass --package-url with an http:// or https:// URL that holds no user name or password.",
      ),
    );
  // A package for all architectures installs on the capture host's.
  const architecture =
    file.architecture === "all"
      ? COMPUTER_ARCHITECTURES.get(hostArchitecture)
      : [...COMPUTER_ARCHITECTURES.values()].find(
          (name) => name === file.architecture,
        );
  if (architecture === undefined)
    return err(
      refusal(
        `${file.name} is built for ${file.architecture === "all" ? `all architectures, and the capture host's is ${hostArchitecture}` : file.architecture}, which an agentenv computer does not run (amd64, arm64).`,
      ),
    );
  const { names, unread } = dependencyPackages(file);
  return ok({
    ...named,
    release: null,
    ...suppliedLibraries(installed, []),
    sources: [],
    architectures: [architecture],
    packageFile: {
      url: packageUrl,
      sha256: file.sha256,
      path: `vendor/${file.name}`,
      architecture,
      dependencies: names,
      unreadDependencies: unread,
    },
  });
};

/**
 * Install a Debian package by name from the Ubuntu 24.04 archive, or from
 * each vendor repository listing the installed version whose signing key the
 * capture verified and retained, taking the package from the first one's
 * release for the capture host's architecture; or why apt cannot.
 */
const aptInstall = (
  installed: DesktopPackage,
  aptPackage: string,
  environment: string,
  hostArchitecture: string,
): ReturnType<typeof vendorInstall> =>
  // An archive package's declared dependencies are complete; a vendor package's may not be.
  fromUbuntuNobleArchive(installed.sources, installed.source_origins)
    ? ok({
        aptPackage,
        release: null,
        ...suppliedLibraries(installed, []),
        libraryPackages: [],
        sources: [],
        skipped: [],
        architectures: [...COMPUTER_ARCHITECTURES.values()],
        packageFile: null,
      })
    : vendorInstall(installed, aptPackage, environment, hostArchitecture);

/**
 * Whether the export installs the captured package from its package file,
 * and so takes `--package-url`: a Debian package apt does not install by
 * name. The environment name only names key files, so any name answers.
 */
export const installsFromPackageFile = (
  installed: DesktopPackage,
  hostArchitecture: string,
): boolean =>
  installed.kind === "deb" &&
  installed.name !== null &&
  !aptInstall(
    installed,
    installed.name.split(":")[0] ?? installed.name,
    "app",
    hostArchitecture,
  ).ok;

/**
 * Install by name from apt where it can; a package apt does not install,
 * given `--package-url`, is downloaded from it and installed from its
 * captured package file; anything else is refused with the reason.
 */
const packageInstall = (
  installed: DesktopPackage,
  environment: string,
  hostArchitecture: string,
  packageUrl?: string,
): Result<ExportInstall, InstallRefusal> => {
  if (installed.kind !== "deb" || installed.name === null)
    return err(
      refusal(
        `The application is not an apt package (${describePackage(installed)}), so the computer cannot install it.`,
      ),
    );
  const aptPackage = installed.name.split(":")[0] ?? installed.name;
  const named = aptInstall(
    installed,
    aptPackage,
    environment,
    hostArchitecture,
  );
  if (named.ok)
    return packageUrl === undefined
      ? named
      : err(
          refusal(
            `--package-url is not needed: the computer installs ${aptPackage} from ${named.value.sources.length === 0 ? "the Ubuntu 24.04 archive by name" : `the vendor apt repository ${named.value.sources.map((source) => source.uri).join(", ")}`}.`,
            "package_url",
            "Export without --package-url.",
          ),
        );
  if (packageUrl === undefined) return err(named.error.refusal);
  return packageFileInstall(
    installed,
    { aptPackage, skipped: named.error.skipped },
    packageUrl,
    hostArchitecture,
  );
};

/** How the computer installs the captured package and, when another package owns the program its desktop entry runs, that package too. */
export const exportInstall = (
  ...request: Parameters<typeof packageInstall>
): Result<ExportInstall, InstallRefusal> => {
  const install = packageInstall(...request);
  const [{ executable_package: program, executable_package_reason: found }] =
    request;
  if (!install.ok) return install;
  if (program === undefined)
    return found === undefined
      ? install
      : err(
          refusal(
            `The desktop entry belongs to ${install.value.aptPackage}, but the computer cannot install the program it runs: ${found}.`,
            "capture",
            "Capture again with the packaged program first on PATH, or with --executable naming it.",
          ),
        );
  const reason =
    found ??
    (install.value.strandedPackages?.includes(program) === true
      ? "only apt repositories the export leaves out offer it"
      : undefined);
  return reason === undefined
    ? ok({ ...install.value, executablePackage: program })
    : err(
        refusal(
          `The desktop entry belongs to ${install.value.aptPackage}, but the program it runs belongs to ${program}, which the computer cannot install: ${reason}.`,
        ),
      );
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
