import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { z } from "zod";
import { CaptureFormatError } from "./CaptureFormatError.js";

/** Validate using the unchanged, pinned upstream HAR 1.2 draft-06 schemas. */
export const createHarValidator = (): ((value: unknown) => void) => {
  const require = createRequire(import.meta.url);
  const schemas = z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .parse(require("har-schema"));
  const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true });
  ajv.addMetaSchema(require("ajv/dist/refs/json-schema-draft-06.json"));
  const plugin: unknown = require("ajv-formats");
  if (typeof plugin !== "function")
    throw new Error("Pinned AJV formats plugin is unavailable");
  plugin(ajv);
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  const validate = ajv.getSchema("har.json#");
  if (validate === undefined)
    throw new Error("Pinned HAR root schema is unavailable");
  return (value) => {
    allowMitmproxyAbsentPostData(value);
    if (!validate(value)) {
      const error = validate.errors?.[0];
      throw new CaptureFormatError(
        "format",
        `HAR schema validation failed: ${error?.keyword ?? "unknown constraint"}.`,
        error?.instancePath ?? "",
      );
    }
  };
};

/** Observed SaveHar 12.2.3 compatibility: validate omitted optional text while retaining reported null. */
const allowMitmproxyAbsentPostData = (value: unknown): void => {
  const parsed = z
    .object({
      log: z.object({
        creator: z.object({
          name: z.literal("mitmproxy"),
          version: z.literal("12.2.3"),
        }),
        entries: z.array(z.unknown()),
      }),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    typeof value !== "object" ||
    value === null ||
    !("log" in value)
  )
    return;
  const log = value.log;
  if (
    typeof log !== "object" ||
    log === null ||
    !("entries" in log) ||
    !Array.isArray(log.entries)
  )
    return;
  for (const entry of log.entries) {
    const candidate: unknown = entry;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("request" in candidate)
    )
      continue;
    const request = candidate.request;
    if (
      typeof request !== "object" ||
      request === null ||
      !("postData" in request)
    )
      continue;
    const body = request.postData;
    if (
      typeof body === "object" &&
      body !== null &&
      "text" in body &&
      body.text === null
    )
      delete body.text;
  }
};
