import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import { readRegularFileText } from "../RegularFileRead.js";
import {
  downloadInstallFiles,
  downloadInstallSchema,
  type DownloadInstall,
} from "../../domain/desktop/appDownloadInstall.js";
import {
  environmentName,
  renderInstallScript,
  type DesktopAppExportPlan,
} from "../../domain/desktop/appExport.js";
import { downloadExportInstall } from "../../domain/desktop/appExportDownload.js";
import {
  INSTALL_SCRIPT,
  exportInstall,
  withExtraPackages,
} from "../../domain/desktop/appExportInstall.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { isPortableBundleName } from "../../domain/portableBundleName.js";

const OPERATION = "export_desktop_application";
const MAX_DOWNLOAD_INSTALL_BYTES = 64 * 1024;

/** An export refusal of one input field. */
export const refuse = (
  userMessage: string,
  field: string,
  remediationAction: string,
) =>
  new AnalysisInputError(
    OPERATION,
    { userMessage, remediationAction, conformsToInputContract: true },
    [{ path: [field], reason: "invalid_value", message: userMessage }],
  );

/** The environment name: the caller's, else one from the desktop entry id or program; refused unless portable. */
export const exportEnvironmentName = (
  capture: DesktopApplicationCapture,
  name: string | undefined,
): string => {
  const { application } = capture;
  const source =
    name ??
    environmentName(
      application.desktop_entry?.id ??
        application.executable.path.split("/").at(-1) ??
        "app",
      isPortableBundleName,
    );
  if (!isPortableBundleName(source))
    throw refuse(
      `${source} is not a portable environment name.`,
      "name",
      "Pass --name with lowercase letters, digits and hyphens.",
    );
  return source;
};

/** The download a `--download-install` file names, as a build computer installed the app from it; none without the file. */
export const readDownloadInstall = async (
  path: string | undefined,
  signal?: AbortSignal,
): Promise<DownloadInstall | undefined> => {
  if (path === undefined) return undefined;
  const field = "download_install";
  const remediation =
    "Pass --download-install with a JSON file naming kind (appimage or tarball), desktop_entry, url, sha256 and architecture, and a tarball's program, as the build request named them.";
  const unreadable = () =>
    refuse(
      `--download-install ${path} is not a readable file of at most ${String(MAX_DOWNLOAD_INSTALL_BYTES)} bytes.`,
      field,
      remediation,
    );
  let text: string;
  try {
    text = await readRegularFileText(path, {
      signal,
      admit: (state) => {
        if (state.size > MAX_DOWNLOAD_INSTALL_BYTES) throw unreadable();
      },
    });
  } catch (cause: unknown) {
    if (
      signal?.aborted === true ||
      cause instanceof AnalysisError ||
      cause instanceof RegularFileCleanupFailure
    )
      throw cause;
    throw unreadable();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refuse(
      `--download-install ${path} does not hold JSON.`,
      field,
      remediation,
    );
  }
  const parsed = downloadInstallSchema.safeParse(value);
  if (!parsed.success)
    throw refuse(
      `--download-install ${path} names no AppImage or tarball install: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ")}.`,
      field,
      remediation,
    );
  return parsed.data;
};

/** Refuse what the computer cannot install or tell ready; how it installs the app and the window class to match. */
export const admitApplication = (
  capture: DesktopApplicationCapture,
  environment: string,
  {
    packageUrl,
    extraPackages = [],
    download,
  }: {
    readonly packageUrl?: string | undefined;
    readonly extraPackages?: readonly string[] | undefined;
    readonly download?: DownloadInstall | undefined;
  },
) => {
  const packaged =
    download === undefined
      ? exportInstall(
          capture.application.package,
          environment,
          capture.host.architecture,
          packageUrl,
        )
      : downloadExportInstall(
          capture.application,
          capture.host.architecture,
          download,
          packageUrl,
        );
  const install = packaged.ok
    ? withExtraPackages(packaged.value, extraPackages)
    : packaged;
  if (!install.ok)
    throw refuse(
      install.error.reason,
      install.error.field,
      install.error.remediation,
    );
  const window = capture.session.window_match;
  if (window === null)
    throw refuse(
      "The capture saw no application window, so the export cannot match the app's window to tell when it is ready.",
      "capture",
      "Capture again and wait for the application window to open.",
    );
  return { install: install.value, windowClass: window.class };
};

/** The files the install adds to the environment folder: a package file's run script, or a download's. */
export const installFiles = (
  plan: Pick<DesktopAppExportPlan, "packageFile" | "download">,
): readonly { readonly path: string; readonly content: string }[] => [
  ...(plan.packageFile === null
    ? []
    : [
        {
          path: INSTALL_SCRIPT,
          content: renderInstallScript(plan.packageFile),
        },
      ]),
  ...(plan.download === undefined ? [] : downloadInstallFiles(plan.download)),
];
