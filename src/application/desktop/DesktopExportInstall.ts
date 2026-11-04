import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { exportInstall } from "../../domain/desktop/appExportInstall.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";

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

/** Refuse what the computer cannot install or tell ready; how it installs the app and the window class to match. */
export const admitApplication = (
  capture: DesktopApplicationCapture,
  environment: string,
) => {
  const install = exportInstall(capture.application.package, environment);
  if (!install.ok)
    throw refuse(
      install.error,
      "capture",
      "Capture an application installed with apt from the Ubuntu 24.04 archive, or from a vendor repository on a host where apt trusts its key and gpgv is installed.",
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
