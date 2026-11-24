import type { BrowserExtensionPort } from "../ports/browserExtension/BrowserExtensionPort.js";
import { BrowserExtensionService } from "../application/browserExtension/BrowserExtensionService.js";
import { BrowserExtensionProvider } from "../browserExtension/BrowserExtensionProvider.js";

/** Portable extension inspection with no browser, store, or installation. */
export const createBrowserExtensionService = (): BrowserExtensionService => {
  const provider: BrowserExtensionPort = new BrowserExtensionProvider();
  return new BrowserExtensionService(provider);
};
