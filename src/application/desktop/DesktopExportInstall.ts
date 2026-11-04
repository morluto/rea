import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { environmentName } from "../../domain/desktop/appExport.js";
import { exportInstall } from "../../domain/desktop/appExportInstall.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";

const OPERATION = "export_desktop_application";

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

/** Refuse what the computer cannot install or tell ready; how it installs the app and the window class to match. */
export const admitApplication = (
  capture: DesktopApplicationCapture,
  environment: string,
) => {
  const install = exportInstall(
    capture.application.package,
    environment,
    capture.host.architecture,
  );
  if (!install.ok)
    throw refuse(
      install.error,
      "capture",
      "Capture an application installed with apt from the Ubuntu 24.04 archive, or from a vendor repository reached over http or https on an amd64 or arm64 host where apt trusts its key and gpgv is installed.",
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
