import { err, ok, type Result } from "../result.js";
import { downloadPrefix, type DownloadInstall } from "./appDownloadInstall.js";
import {
  computerArchitecture,
  type ExportInstall,
  type InstallRefusal,
} from "./appExportInstall.js";
import type { DesktopApplicationInventory } from "./desktopCapture.js";

const refusal = (
  reason: string,
  field: InstallRefusal["field"],
  remediation: string,
): InstallRefusal => ({ field, reason, remediation });

/**
 * The download the app was installed from, as a build computer installed it:
 * refused unless the capture launched that download's desktop entry, whose
 * program lies in the folder it unpacks to, on the download's architecture.
 */
export const downloadExportInstall = (
  application: Pick<
    DesktopApplicationInventory,
    "desktop_entry" | "executable"
  >,
  hostArchitecture: string,
  download: DownloadInstall,
  packageUrl?: string,
): Result<ExportInstall, InstallRefusal> => {
  const remediation =
    "Capture the app the build computer installed from this download, launched from its desktop entry, and export it with the same --download-install.";
  if (packageUrl !== undefined)
    return err(
      refusal(
        "--package-url and --download-install each name how the computer installs the app; an app comes from one of them.",
        "package_url",
        "Pass --download-install for an app a build computer unpacked from an AppImage or tarball, or --package-url for one installed from a .deb file.",
      ),
    );
  const entry = application.desktop_entry?.id ?? null;
  if (entry !== download.desktop_entry)
    return err(
      refusal(
        `--download-install installs the desktop entry ${download.desktop_entry}, but the capture launched ${entry === null ? "no desktop entry" : entry}.`,
        "download_install",
        remediation,
      ),
    );
  const prefix = downloadPrefix(download);
  const program =
    application.executable.resolved_path ?? application.executable.path;
  if (!program.startsWith(`${prefix}/`))
    return err(
      refusal(
        `The captured program ${program} is not under ${prefix}, where the download is unpacked, so the capture is not of the app it installs.`,
        "download_install",
        remediation,
      ),
    );
  if (computerArchitecture(hostArchitecture) !== download.architecture)
    return err(
      refusal(
        `The download is built for ${download.architecture}, but the capture ran on ${hostArchitecture}.`,
        "download_install",
        "Export with the download the capture host's build computer installed.",
      ),
    );
  return ok({
    aptPackage: download.desktop_entry,
    release: null,
    libraryPackages: [],
    sources: [],
    skipped: [],
    architectures: [download.architecture],
    packageFile: null,
    download,
  });
};
