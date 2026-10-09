import { afterEach, expect, it, vi } from "vitest";

import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import { PlaywrightElectronActiveProvider } from "./PlaywrightElectronActiveProvider.js";

afterEach(() => vi.unstubAllEnvs());

it("passes the selected environment and ownership token to Electron launch", async () => {
  vi.stubEnv("LANG", "ambient-language");
  let launchedEnvironment: unknown;
  const provider = new PlaywrightElectronActiveProvider(
    {
      LANG: "selected-language",
      PATH: "/selected/bin",
      REA_PRIVATE_VALUE: "not-a-launch-setting",
    },
    async (options) => {
      launchedEnvironment = options?.env;
      throw new Error("launch boundary reached");
    },
  );
  const result = await provider.capture(
    electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: process.execPath,
    }),
  );

  expect(result.ok).toBe(false);
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PROCESS_RUN_ID: expect.any(String),
  });
});
