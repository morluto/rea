import { expect, it } from "vitest";

import { MAX_FIRMWARE_STAGING_ENTRIES } from "../domain/firmware/firmwareAnalysis.js";
import { firmwareStagingBudgetRemediation } from "./FirmwareFiles.js";

it.each([
  [MAX_FIRMWARE_STAGING_ENTRIES - 1, true],
  [MAX_FIRMWARE_STAGING_ENTRIES, false],
])(
  "offers an entry-budget increase at %i only when the request can raise it",
  (limit, adjustable) => {
    const action = firmwareStagingBudgetRemediation("max_output_files", limit);
    expect(action).toContain(`max_output_files=${limit}`);
    expect(action).toContain(String(MAX_FIRMWARE_STAGING_ENTRIES));
    expect(action).toContain(
      adjustable
        ? "narrower firmware byte range"
        : "smaller firmware byte range",
    );
    expect(action.includes("Increase max_output_files")).toBe(adjustable);
  },
);
