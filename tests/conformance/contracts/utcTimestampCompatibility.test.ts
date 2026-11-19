import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import { webObservationSessionSchema } from "../../../src/domain/browserSession.js";
import { webScreenshotSchema } from "../../../src/domain/webScreenshot.js";

const fields = [
  ["screenshot capture", webScreenshotSchema.shape.captured_at],
  [
    "page inspection start",
    webPageInspectionSchema.shape.capture_window.shape.started_at,
  ],
  [
    "session observation end",
    webObservationSessionSchema.shape.window.shape.ended_at,
  ],
] as const;

it.each(fields)(
  "%s preserves UTC timestamps without seconds and rejects offsets",
  (_name, schema) => {
    const utc = "2026-10-09T04:00Z";
    const offset = "2026-10-09T04:00+02:00";
    const validate = new Ajv2020().compile(
      z.toJSONSchema(schema, { target: "draft-2020-12" }),
    );
    expect(schema.parse(utc)).toBe(utc);
    expect(schema.safeParse(offset).success).toBe(false);
    expect(validate(utc)).toBe(true);
    expect(validate(offset)).toBe(false);
  },
);
