import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MAX_JSON_DEPTH } from "../jsonValue.js";
import { projectKeyedArchive } from "./keyedArchive.js";

const deepValue = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};

describe("projectKeyedArchive input bound", () => {
  it("rejects an over-deep archive value with a validation error instead of crashing", () => {
    let error: unknown;
    try {
      projectKeyedArchive(deepValue(MAX_JSON_DEPTH + 1), {
        offset: 0,
        limit: 1,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(z.ZodError);
    expect(error).not.toBeInstanceOf(RangeError);
  });
});
