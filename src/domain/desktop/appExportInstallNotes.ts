import { INSTALL_SCRIPT } from "./appExportInstall.js";
import type { DesktopAppExportPlan } from "./appExport.js";

/** The package as apt takes it: `name`, or `name/release` for a vendor release. */
export const installName = (plan: DesktopAppExportPlan): string =>
  plan.aptRelease === null
    ? plan.aptPackage
    : `${plan.aptPackage}/${plan.aptRelease}`;

/** Where the app's package comes from: the archive, or each vendor repository with its key. */
const installedFrom = (plan: DesktopAppExportPlan): string =>
  plan.aptSources.length === 0
    ? "the distribution archive"
    : plan.aptSources
        .map(
          (source) =>
            `the apt repository \`${source.uri}\` (suite \`${source.suite}\`${source.components.length === 0 ? "" : `, components \`${source.components.join(" ")}\``}), trusting \`${source.keyFile}\`, the key that verified its release on the capture host`,
        )
        .join(" and ");

/** What the computer installs, and from where. */
export const installs = (plan: DesktopAppExportPlan): string =>
  plan.packageFile === null
    ? `\`${installName(plan)}\` from ${installedFrom(plan)}`
    : `\`${plan.aptPackage}\`${plan.packageVersion === null ? "" : ` ${plan.packageVersion}`} from its package file, downloaded from
  \`${plan.packageFile.url}\` when the bundle is put and refused unless its SHA-256 is \`${plan.packageFile.sha256}\``;

/** The README's notes on a package file the computer downloads. */
const packageFileNotes = ({ packageFile: file }: DesktopAppExportPlan) =>
  file === null
    ? []
    : [
        `- The bundle does not contain the package: \`${INSTALL_SCRIPT}\` installs \`${file.path}\` with dpkg once the apt packages
  it depends on are in${file.dependencies.length === 0 ? "" : ` (${file.dependencies.map((name) => `\`${name}\``).join(", ")})`}, so the computer runs exactly the captured version, on \`${file.architecture}\` only.`,
        "- Vendor sites may refuse automated downloads, so the URL must point at a copy of the file the operator may use.\n  The package's licence, such as a trial's terms, is the operator's to check.",
      ];

/** The README's notes on what the computer installs beside the app, and why. */
export const installNotes = (plan: DesktopAppExportPlan): string =>
  [
    ...packageFileNotes(plan),
    ...(plan.extraPackages === undefined
      ? []
      : [
          `- Installed beside the app because the export was asked for them with \`--extra-package\`, as a build computer asks
  for the packages its request named: ${plan.extraPackages.map((name) => `\`${name}\``).join(", ")}.`,
        ]),
    ...(plan.executablePackage === undefined
      ? []
      : [
          `- \`${plan.executablePackage}\`, which owns the program the desktop entry runs, is installed with it.`,
        ]),
    ...(plan.libraryPackages.length === 0
      ? []
      : [
          `- Library packages, which own the shared libraries the executable loaded on the capture host, are installed with it:
  ${plan.libraryPackages.map((name) => `\`${name}\``).join(", ")}.`,
        ]),
    ...(plan.electron
      ? [
          "- Chromium's sandbox is off (`--no-sandbox`): it needs user namespaces the computer's container does not grant,\n  and Electron exits without them.",
        ]
      : []),
  ]
    .map((line) => `\n${line}`)
    .join("");
