import { expect, it } from "vitest";
import type { z } from "zod";

import { machoTargetSelectionSchema } from "./apple/machoTargetSelection.js";
import {
  browserEndpointSchema,
  browserObservationEndpointSchema,
} from "./browserObservation.js";
import { browserScenarioUrlSchema } from "./browserScenarioValues.js";

// The compact advertisement drops nested validation detail, so each refusal
// states the rule it applies. None echoes the refused value.
const messages = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ message }) => message);
};

it("names the accepted browser URL form", () => {
  expect(
    messages(browserScenarioUrlSchema, { url: "app.example.test" }),
  ).toEqual([
    "Browser URLs must be absolute HTTP(S) URLs, such as https://app.example.test/",
  ]);
});

it("names the accepted CDP endpoint forms without echoing the value", () => {
  for (const value of ["not a url", "127.0.0.1:9222"]) {
    const observed = messages(browserObservationEndpointSchema, value);
    expect(observed).toEqual([
      "CDP endpoint must be a literal loopback URL: http://127.0.0.1:PORT, or ws://127.0.0.1:PORT/devtools/browser/ID",
    ]);
  }
  expect(messages(browserEndpointSchema, "not a url")).toEqual([
    "CDP endpoint must be an explicit-port HTTP URL on 127.0.0.1 or ::1",
  ]);
});

it("names the container rule a Mach-O selection breaks", () => {
  const base = {
    kind: "macho-selected-image-v1",
    offset: 0,
    byte_length: 16,
    cpu_type: 0x0100000c,
    cpu_subtype: 0,
  };
  const selection = (fields: Record<string, unknown>) => ({
    ...base,
    ...fields,
  });
  expect(
    messages(
      machoTargetSelectionSchema,
      selection({
        container: "thin",
        offset: 4096,
        container_table_sha256: null,
      }),
    ),
  ).toEqual([
    "A thin Mach-O selection has offset 0 and container_table_sha256 null",
  ]);
  expect(
    messages(
      machoTargetSelectionSchema,
      selection({
        container: "fat",
        offset: 4096,
        container_table_sha256: null,
      }),
    ),
  ).toEqual([
    "A fat Mach-O selection requires the container_table_sha256 of its fat header table",
  ]);
});
