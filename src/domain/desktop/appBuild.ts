import { createHash } from "node:crypto";

import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  appModuleFile,
  aptSources,
  className,
  environmentName,
  py,
  pyList,
  renderEnvToml,
  renderInstallScript,
  renderSmokeTask,
} from "./appExport.js";
import { shellQuote } from "./shellQuote.js";
import { BUNDLE_SETTING_VARIABLE } from "./buildComputerSettings.js";
import { INSTALL_SCRIPT, type ExportPackageFile } from "./appExportInstall.js";
import { isArmoredKey } from "./aptRepositories.js";
import { buildSecretHandleSchema } from "./buildSecrets.js";
import { DEBIAN_PACKAGE_NAME } from "./debianPackageFile.js";

/** The Node.js release the build layer runs REA with: the one REA pins. */
export const BUILD_NODE_VERSION = "24.22.1";
/** SHA-256 of each architecture's Node.js tarball, from the release's SHASUMS256.txt. */
const NODE_TARBALLS = [
  {
    arch: "amd64",
    platform: "linux-x64",
    sha256: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
  },
  {
    arch: "arm64",
    platform: "linux-arm64",
    sha256: "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e",
  },
] as const;
const COMPUTER_ARCHITECTURES = ["amd64", "arm64"] as const;
/** The package of `gtk-launch`, which opens the app from its desktop entry. */
const LAUNCHER_PACKAGE = "libgtk-3-bin";
/** The package of `dconf`, which the capture reads the app's dconf settings with. */
const DCONF_PACKAGE = "dconf-cli";
const REA_INSTALL_SCRIPT = "install-rea.sh";
/** Where the build layer keeps a `.deb` the app came from, for the capture's `--package-file`. */
export const BUILD_PACKAGE_FILE = "/opt/rea/package.deb";
const ELECTRON_LAUNCH_SCRIPT = "prepare-electron-launch.sh";
const REA_PAYLOAD = "rea-payload.tar";

/** A URL agentenv downloads from: http or https in lowercase, without a user name or password. */
const downloadUrlSchema = z
  .url({ protocol: /^https?$/u })
  .regex(/^https?:\/\//u)
  .refine(
    (url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "";
    },
    { message: "The URL must not hold a user name or password." },
  );
const aptPackageSchema = z
  .string()
  .regex(DEBIAN_PACKAGE_NAME)
  .describe("A Debian package name.");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
/** How many packages an archive install may name beside the app. */
const MAX_EXTRA_PACKAGES = 16;

/** Where the computer installs the app from, chosen before anything is captured. */
export const buildInstallSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("archive"),
    package: aptPackageSchema,
    extra_packages: z
      .array(aptPackageSchema)
      .max(MAX_EXTRA_PACKAGES)
      .default([])
      .describe(
        "Archive packages installed beside the app, and by its export, such as a runtime piece it needs that its package does not install.",
      ),
  }),
  z.strictObject({
    kind: z.literal("apt_repository"),
    package: aptPackageSchema,
    uri: downloadUrlSchema,
    suite: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    components: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/u)).default([]),
    key_file: absoluteLocalPathStringSchema.describe(
      "The repository's signing key on this host, armored or binary.",
    ),
  }),
  z.strictObject({
    kind: z.literal("package_file"),
    url: downloadUrlSchema,
    sha256: sha256Schema,
    architecture: z.enum(COMPUTER_ARCHITECTURES),
    dependencies: z
      .array(aptPackageSchema)
      .default([])
      .describe(
        "Packages apt installs first; dpkg installs the file offline, so its dependencies must be listed.",
      ),
  }),
]);

/** A request for a build computer, or an existing bundle folder to keep up as it is. */
export const buildSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("request"),
    desktop_entry: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .max(255)
      .describe(
        "The desktop entry id the package installs, such as org.xfce.mousepad; the menu opens it with gtk-launch.",
      ),
    electron: z
      .boolean()
      .optional()
      .describe(
        "True when the app is Electron. The install rewrites its desktop entry's command with the same launch policy an export uses, adding --no-sandbox right after the program unless the command already has it. The computer's container does not grant the user namespaces Chromium needs, and Electron exits without that flag.",
      ),
    window_class: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("The app window's WM_CLASS class, when known."),
    install: buildInstallSchema,
  }),
  z.strictObject({
    kind: z.literal("bundle"),
    path: absoluteLocalPathStringSchema.describe(
      "An agentenv bundle folder whose tasks/smoke.json deploys one computer, such as an exported one.",
    ),
    settings: z
      .record(
        z.string().regex(BUNDLE_SETTING_VARIABLE),
        buildSecretHandleSchema,
      )
      .optional()
      .describe(
        "Each environment variable a withheld file's setting reads, as the export's withheld_files names it, mapped to the handle of the secret holding its value; REA supplies the value to the deploy and no result shows it. Build host control names are reserved.",
      ),
  }),
]);
export type BuildSource = z.output<typeof buildSourceSchema>;
export type BuildRequest = Extract<BuildSource, { kind: "request" }>;

/** The packages a request names beside the app, which its export installs beside it too: an archive install's extra packages, or a package file's dependencies; none for a bundle. */
export const extraPackagesOf = (source: BuildSource): readonly string[] =>
  source.kind === "bundle"
    ? []
    : source.install.kind === "archive"
      ? source.install.extra_packages
      : source.install.kind === "package_file"
        ? source.install.dependencies
        : [];

/** Where the build layer gets REA from: a tar archive with one top folder holding `scripts/rea.mjs`. */
export type ReaPayload =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "download";
      readonly url: string;
      readonly sha256: string;
    };

/** One file of the bundle: its text or bytes, or a host file copied as it is. */
export interface BuildBundleFile {
  readonly path: string;
  readonly content: string | Uint8Array | { readonly copyFrom: string };
}

const download = (
  url: string,
  sha256: string,
  to: string,
  arch?: string,
): string =>
  `Download(url=${py(url)}, sha256=${py(sha256)}, to=${py(to)}${arch === undefined ? "" : `, arch=${py(arch)}`})`;

/**
 * The build-only step: unpack Node.js and REA into /opt/rea, as root and
 * offline, put both on PATH, and keep a copy of the app's `.deb`, which its
 * own install step removes, for the capture to record.
 */
const renderReaInstallScript = (
  packageFile: string | undefined,
): string => `#!/bin/sh
# Build-only layer, run as root with the network off: unpack Node.js and REA into /opt/rea and put both on PATH.
set -eu
mkdir -p /opt/rea/payload${
  packageFile === undefined
    ? ""
    : `
cp ${packageFile} ${BUILD_PACKAGE_FILE}`
}
python3 - <<'PY'
import glob
import tarfile

for name, into in [(path, "/opt/rea") for path in glob.glob("node-*.tar.xz")] + [("${REA_PAYLOAD}", "/opt/rea/payload")]:
    with tarfile.open(name) as archive:
        archive.extractall(into, filter="tar")
PY
set -- /opt/rea/payload/*/scripts/rea.mjs
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "The REA archive must hold one top folder with scripts/rea.mjs." >&2
    exit 1
fi
ln -sf /opt/rea/node-v${BUILD_NODE_VERSION}-linux-*/bin/node /usr/local/bin/node
# The archive's top folder is caller-chosen and may contain spaces. The launcher
# runs a fixed path so the shell does not split that folder before Node opens it.
ln -sfn "$1" /opt/rea/rea.mjs
printf '#!/bin/sh\\nexec /usr/local/bin/node /opt/rea/rea.mjs "$@"\\n' > /usr/local/bin/rea
chmod 755 /usr/local/bin/rea
rm -f node-*.tar.xz ${REA_PAYLOAD}
`;

/** What the computer installs for a request: packages, sources, downloads and run scripts. */
const buildInstall = (
  request: BuildRequest,
  name: string,
  payload: ReaPayload,
  aptKey: Uint8Array | undefined,
) => {
  const { install } = request;
  const architectures =
    install.kind === "package_file"
      ? [install.architecture]
      : [...COMPUTER_ARCHITECTURES];
  if (install.kind === "apt_repository" && aptKey === undefined)
    throw new TypeError("An apt repository needs its key file's bytes.");
  const key =
    install.kind === "apt_repository" && aptKey !== undefined
      ? {
          bytes: aptKey,
          source: {
            uri: install.uri,
            suite: install.suite,
            components: install.components,
            keyFile: `apt-keys/${name}.${isArmoredKey(aptKey) ? "asc" : "gpg"}`,
            keySha256: createHash("sha256").update(aptKey).digest("hex"),
          },
        }
      : undefined;
  const packageFile: ExportPackageFile | null =
    install.kind === "package_file"
      ? {
          url: install.url,
          sha256: install.sha256,
          path: "vendor/package.deb",
          architecture: install.architecture,
          dependencies: install.dependencies,
          unreadDependencies: [],
        }
      : null;
  const downloads = [
    ...NODE_TARBALLS.filter(({ arch }) => architectures.includes(arch)).map(
      ({ arch, platform, sha256 }) =>
        download(
          `https://nodejs.org/dist/v${BUILD_NODE_VERSION}/node-v${BUILD_NODE_VERSION}-${platform}.tar.xz`,
          sha256,
          `node-${arch}.tar.xz`,
          arch,
        ),
    ),
    ...(packageFile === null
      ? []
      : [
          download(
            packageFile.url,
            packageFile.sha256,
            packageFile.path,
            packageFile.architecture,
          ),
        ]),
    ...(payload.kind === "download"
      ? [download(payload.url, payload.sha256, REA_PAYLOAD)]
      : []),
  ];
  return {
    architectures,
    packages: [
      ...new Set([
        ...(install.kind === "package_file" ? [] : [install.package]),
        ...extraPackagesOf(request),
        LAUNCHER_PACKAGE,
        DCONF_PACKAGE,
      ]),
    ],
    key,
    packageFile,
    downloads,
    // REA's layer runs first, so it can keep the .deb the install removes.
    scripts: [
      REA_INSTALL_SCRIPT,
      ...(packageFile === null ? [] : [INSTALL_SCRIPT]),
      ...(request.electron === true ? [ELECTRON_LAUNCH_SCRIPT] : []),
    ],
  };
};

/**
 * The build step that rewrites an Electron app's installed desktop command
 * with REA's launch policy. It runs after Node.js and the REA payload are
 * unpacked, and before the Applications menu opens the entry with gtk-launch.
 */
const renderElectronLaunchScript = (entry: string): string => `#!/bin/sh
# Applications menu -> gtk-launch of this entry. Chromium's sandbox needs user
# namespaces the container does not grant, so adjust the installed command first.
set -eu
entry='${entry}'
desktop=
ifs=$IFS
IFS=:
for dir in \${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
  if [ -n "$dir" ] && [ -f "$dir/applications/$entry.desktop" ]; then
    desktop="$dir/applications/$entry.desktop"
    break
  fi
done
IFS=$ifs
if [ -z "$desktop" ]; then
  echo "No installed desktop entry $entry.desktop was found, so its command cannot be adjusted for Electron." >&2
  exit 1
fi
set -- /opt/rea/payload/*/dist/domain/desktop/appExportInstall.js
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "The REA archive must include dist/domain/desktop/appExportInstall.js so an Electron app can use REA's launch policy." >&2
  exit 1
fi
/usr/local/bin/node --input-type=module - "$1" "$desktop" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const policy = await import(pathToFileURL(process.argv[2]).href);
if (typeof policy.adjustInstalledDesktopText !== "function") {
  console.error("REA's desktop launch policy did not load from the archive.");
  process.exit(1);
}
const desktop = process.argv[3];
const adjusted = policy.adjustInstalledDesktopText(readFileSync(desktop, "utf8"), true);
if (!adjusted.ok) {
  console.error(\`The desktop entry \${desktop} could not be adjusted for Electron: \${adjusted.error}.\`);
  process.exit(1);
}
writeFileSync(desktop, adjusted.value);
JS
`;

/** The class module: the decorators that install and launch the app, and a class with no hooks. */
const renderBuildModule = (
  request: BuildRequest,
  entry: string,
  plan: { readonly className: string },
  install: ReturnType<typeof buildInstall>,
): string => {
  const window =
    request.window_class === undefined
      ? ""
      : `, window={"class": ${py(request.window_class)}}, ready=Ready(window=True)`;
  const sources = aptSources({
    aptSources: install.key === undefined ? [] : [install.key.source],
  });
  return `"""${entry} as an agentenv computer app for building an environment with REA.

Rendered by REA's start_build_computer: the app installed from the request, opened on demand, and REA with Node.js
${BUILD_NODE_VERSION} in /opt/rea. It is for building only; keep it local and never publish it.
"""

from agentenv_protocol.computer import AptSource, ComputerAppEnvironment, Download, Launch, Packages, Ready, RunScript, computer_app, linux


@computer_app(supports=[{"os": {"type": "linux", "display": ["x11"]}, "arch": ${pyList(install.architectures)}}])
@linux(
    packages=Packages(apt=${pyList(install.packages)}),${sources}
    downloads=[${install.downloads.join(", ")}],
    run=[${install.scripts.map((script) => `RunScript(script=${py(script)})`).join(", ")}],
    launch=Launch(at="demand", command=${pyList(["sh", "-c", `cd "$HOME" 2>/dev/null; exec gtk-launch ${shellQuote(entry)}`])}${window}),
)
class ${plan.className}(ComputerAppEnvironment):
    """${entry}, opened on demand for building: it keeps no seed and serves no data operations."""
`;
};

/**
 * The bundle a build computer starts from: the requested app installed and
 * opened on demand, without a seed or data hooks, plus REA and Node.js in a
 * build-only layer. Node.js is downloaded per architecture at put; REA is
 * downloaded too, or shipped in the environment folder from a local archive.
 * An apt repository's key file is copied into the environment folder.
 */
export const renderBuildBundle = (
  request: BuildRequest,
  payload: ReaPayload,
  aptKey?: Uint8Array,
): { readonly name: string; readonly files: readonly BuildBundleFile[] } => {
  const entry = request.desktop_entry.replace(/\.desktop$/u, "");
  const name = environmentName(entry, (candidate) => candidate !== "app");
  const plan = { name, className: className(name) };
  const install = buildInstall(request, name, payload, aptKey);
  const env = `envs/${name}`;
  const file = (path: string, content: BuildBundleFile["content"]) => ({
    path: `${env}/${path}`,
    content,
  });
  return {
    name,
    files: [
      file("env.toml", renderEnvToml(plan)),
      file(
        appModuleFile(name),
        renderBuildModule(request, entry, plan, install),
      ),
      file(
        REA_INSTALL_SCRIPT,
        renderReaInstallScript(install.packageFile?.path ?? undefined),
      ),
      ...(request.electron === true
        ? [file(ELECTRON_LAUNCH_SCRIPT, renderElectronLaunchScript(entry))]
        : []),
      ...(install.packageFile === null
        ? []
        : [file(INSTALL_SCRIPT, renderInstallScript(install.packageFile))]),
      ...(install.key === undefined
        ? []
        : [file(install.key.source.keyFile, install.key.bytes)]),
      ...(payload.kind === "file"
        ? [file(REA_PAYLOAD, { copyFrom: payload.path })]
        : []),
      { path: "tasks/smoke.json", content: renderSmokeTask(plan) },
    ],
  };
};
