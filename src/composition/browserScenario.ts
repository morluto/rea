import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import { PlaywrightBrowserScenarioProvider } from "../browser/PlaywrightBrowserScenarioProvider.js";
import { PlaywrightScenarioSessionFactory } from "../browser/PlaywrightScenarioSession.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createBrowserScenarioProvider = (
  environment: Readonly<Record<string, string | undefined>>,
): BrowserScenarioCapturePort =>
  new PlaywrightBrowserScenarioProvider(
    new PlaywrightScenarioSessionFactory(environment),
  );
