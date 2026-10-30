import { createRequire } from "node:module";
import { isIP } from "node:net";
import { Ajv } from "ajv";
import { z } from "zod";
import { CaptureFormatError } from "./CaptureFormatError.js";
import { captureObject } from "./CaptureRedaction.js";

const durationSchema = { type: "number", minimum: 0 };
const optionalDurationSchema = {
  anyOf: [durationSchema, { const: -1 }],
};

// har-schema@2.0.0 omits object types and uses the unknown `min` keyword
// on duration fields. Own the corrections from HAR 1.2 without changing
// producer data or mutating the installed schemas.
const timingsSchema = {
  $id: "timings.json#",
  $schema: "http://json-schema.org/draft-06/schema#",
  type: "object",
  required: ["send", "wait", "receive"],
  properties: {
    send: durationSchema,
    wait: durationSchema,
    receive: durationSchema,
    blocked: optionalDurationSchema,
    dns: optionalDurationSchema,
    connect: optionalDurationSchema,
    ssl: optionalDurationSchema,
    comment: { type: "string" },
  },
};

/** Validate with pinned HAR 1.2 draft-06 schemas and the owned schema corrections. */
export const createHarValidator = (): ((
  value: unknown,
) => readonly number[]) => {
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
  const propertiesSchema = z.record(z.string(), z.unknown());
  const correctedSchemas: Record<string, Record<string, unknown>> = {
    timings: timingsSchema,
    cache: { ...schemas.cache, type: "object" },
    entry: {
      ...schemas.entry,
      properties: {
        ...propertiesSchema.parse(schemas.entry?.properties),
        time: durationSchema,
      },
    },
    pageTimings: {
      ...schemas.pageTimings,
      properties: {
        ...propertiesSchema.parse(schemas.pageTimings?.properties),
        onContentLoad: optionalDurationSchema,
        onLoad: optionalDurationSchema,
      },
    },
  };
  for (const [name, schema] of Object.entries(schemas))
    ajv.addSchema(correctedSchemas[name] ?? schema);
  const validate = ajv.getSchema("har.json#");
  if (validate === undefined)
    throw new Error("Pinned HAR root schema is unavailable");
  return (value) => {
    const adaptedPlaywrightEntries =
      allowObservedProducerRepresentations(value);
    if (!validate(value)) {
      const error = validate.errors?.[0];
      // AJV messages name the violated constraint, such as the missing
      // property, without restating any captured value.
      throw new CaptureFormatError(
        "format",
        error === undefined
          ? "HAR schema validation failed: unknown constraint."
          : `HAR schema validation failed: ${error.keyword} (${error.message ?? "no detail"}).`,
        error?.instancePath ?? "",
      );
    }
    return adaptedPlaywrightEntries;
  };
};

/** Adapt only observed producer representations in the disposable validation copy. */
const allowObservedProducerRepresentations = (
  value: unknown,
): readonly number[] => {
  if (!captureObject(value) || !captureObject(value.log)) return [];
  const log = value.log;
  if (!captureObject(log.creator) || !Array.isArray(log.entries)) return [];
  const mitmproxy =
    log.creator.name === "mitmproxy" && log.creator.version === "12.2.3";
  const playwright =
    log.creator.name === "Playwright" && log.creator.version === "1.58.2";
  if (!mitmproxy && !playwright) return [];
  const adaptedPlaywrightEntries: number[] = [];
  for (const [ordinal, entry] of log.entries.entries()) {
    const candidate: unknown = entry;
    if (!captureObject(candidate)) continue;
    const address = candidate.serverIPAddress;
    if (
      playwright &&
      typeof address === "string" &&
      address.startsWith("[") &&
      address.endsWith("]") &&
      isIP(address.slice(1, -1)) === 6
    ) {
      candidate.serverIPAddress = address.slice(1, -1);
      adaptedPlaywrightEntries.push(ordinal);
    }
    if (!mitmproxy) continue;
    const request = candidate.request;
    if (!captureObject(request)) continue;
    const body = request.postData;
    if (captureObject(body) && body.text === null) delete body.text;
  }
  return adaptedPlaywrightEntries;
};
