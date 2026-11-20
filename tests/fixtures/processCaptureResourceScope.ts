import { onTestFinished } from "vitest";
import { ProcessCaptureResourceScope } from "../../src/process/capture/ProcessCaptureLifecycle.js";

/** Keep each capture's actual close capabilities owned through test finalization. */
export const createTestProcessCaptureResourceScope =
  (): ProcessCaptureResourceScope => {
    const resources = new ProcessCaptureResourceScope();
    onTestFinished(() => resources.close());
    return resources;
  };
