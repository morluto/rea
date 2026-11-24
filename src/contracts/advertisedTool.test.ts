import { describe, expect, it } from "vitest";

import {
  advertiseToolOutput,
  type RecordedOutputAdvertisement,
} from "./advertisedTool.js";
import { COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES } from "./mcpSchemaPresentation.js";

const canonical = {
  type: "object",
  description: "root stays",
  properties: {
    value: { type: "string", description: "nested guidance leaves" },
  },
  required: ["value"],
  additionalProperties: false,
} as const;

const recordedSchema = {
  type: "object",
  properties: {
    value: { type: "string", description: "kept for a recorded tool" },
  },
  required: ["value"],
  additionalProperties: false,
};

const presentation: RecordedOutputAdvertisement = {
  recordedTools: new Set(["search_guidance"]),
  live: { budgetBytes: COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES },
};

describe("advertiseToolOutput", () => {
  it("serves a recorded schema unchanged and compacts a live tool", () => {
    expect(
      advertiseToolOutput(recordedSchema, presentation, "search_guidance"),
    ).toBe(recordedSchema);
    expect(
      advertiseToolOutput({ ...canonical }, presentation, "discover_tools"),
    ).toEqual({
      type: "object",
      description: "root stays",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("compacts a schema that is not named as recorded", () => {
    expect(advertiseToolOutput({ ...canonical }, presentation)).toEqual({
      type: "object",
      description: "root stays",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
  });
});
