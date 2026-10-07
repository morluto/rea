import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createBrowserObservationProvider = (): BrowserObservationPort =>
  new CdpBrowserProvider();
