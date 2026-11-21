import { expect, it } from "vitest";
import {
  exportStructuredRasterResourcesRequestSchema as request,
  exportStructuredRasterResourcesInputSchema as input,
} from "./structuredRasterExport.js";
const selected = {
  path: "/source",
  expected_sha256: "a".repeat(64),
  output_directory: "/new",
};
it("preserves caller omissions and separately resolves export defaults", () => {
  expect(request.parse(selected)).toEqual(selected);
  expect(input.parse(selected)).toMatchObject({
    ambiguity: "skip",
    formats: ["raw", "png"],
    color_policy: { kind: "diagnostic-indices" },
    min_records: 8,
  });
});
it.each([
  { expected_sha256: "bad" },
  { max_resources: 1 },
  { payloadRange: { offset: 0, length: 1 } },
  { color_policy: { kind: "record12-lut-registry", theme_slot: 0 } },
  { min_records: 10, max_records: 9 },
])("rejects inadmissible export arguments %j", (extra) => {
  expect(request.safeParse({ ...selected, ...extra }).success).toBe(false);
});
