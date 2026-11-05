import { HwpDocumentService } from "../application/hwp/HwpDocumentService.js";
import { HwpDocumentProvider } from "../hwp/HwpDocumentProvider.js";

/** Compose HWP document inspection backed by the hwp-rs json_dump binary. */
export const createHwpDocumentService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): HwpDocumentService =>
  new HwpDocumentService(new HwpDocumentProvider(environment));
