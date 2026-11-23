import { expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";
import { SessionRuntimeAvailability } from "./SessionRuntimeAvailability.js";

const provider = { id: "kuna", name: "Kuna", version: "1" } as const;
const inspect = {
  operation: "list_strings",
  provider,
  available: true,
} as const;
const decode = {
  operation: "search_strings",
  provider,
  available: true,
} as const;

it("records the repair a runtime refusal publishes", () => {
  const availability = new SessionRuntimeAvailability();
  const remediation = "Restart Kuna from a host that provides its SDK.";
  const changed = availability.observe(
    availability.dispatch(),
    inspect,
    [inspect],
    err(
      new AnalysisCapabilityUnavailableError(
        "kuna",
        "list_strings",
        "the selected provider is unavailable",
        { remediationAction: remediation },
      ),
    ),
  );
  expect(changed).toBe(true);
  expect(availability.entries.get("list_strings")).toEqual({
    reason:
      "Provider kuna cannot execute list_strings: the selected provider is unavailable",
    remediation,
  });
});

it("keeps an active failure's own repair when a sibling report arrives", () => {
  const availability = new SessionRuntimeAvailability();
  availability.observe(
    availability.dispatch(),
    inspect,
    [inspect, decode],
    err(
      new AnalysisCapabilityUnavailableError(
        "kuna",
        "list_strings",
        "first refusal",
        {
          remediationAction: "repair one",
        },
      ),
    ),
  );
  availability.observe(
    availability.dispatch(),
    decode,
    [inspect, decode],
    err(
      new AnalysisCapabilityUnavailableError(
        "kuna",
        "search_strings",
        "second refusal",
        {
          remediationAction: "repair two",
          siblingOperations: ["list_strings"],
        },
      ),
    ),
  );
  // The reason stays the one the active failure published, so its repair must
  // stay with it instead of being replaced by the incoming sibling report.
  expect(availability.entries.get("list_strings")).toEqual({
    reason: "Provider kuna cannot execute list_strings: first refusal",
    remediation: "repair one",
  });
});

it("keeps the repair out of the recorded reason", () => {
  const availability = new SessionRuntimeAvailability();
  const remediation = "Restart Kuna from a host that provides its SDK.";
  availability.observe(
    availability.dispatch(),
    inspect,
    [inspect],
    err(
      new AnalysisCapabilityUnavailableError(
        "kuna",
        "list_strings",
        "the selected provider is unavailable",
        {
          // A provider may fold the repair into the friendly message; the
          // recorded reason must still not contain it.
          userMessage: `The selected provider is unavailable. ${remediation}`,
          remediationAction: remediation,
        },
      ),
    ),
  );
  const entry = availability.entries.get("list_strings");
  expect(entry?.remediation).toBe(remediation);
  expect(entry?.reason).not.toContain(remediation);
});
