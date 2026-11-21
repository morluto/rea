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

interface HarProducerProfile {
  readonly name: string;
  readonly version: string;
  readonly label?: string;
  readonly bracketedIpv6?: true;
  readonly emptyServerAddress?: true;
  readonly unavailableFailedRequestTimings?: true;
  readonly nullPostDataText?: true;
}

// Match exact observed profiles. Chromium DevTools declares WebInspector with
// the frozen AppleWebKit version from its user agent.
const HAR_PRODUCER_PROFILES: readonly HarProducerProfile[] = [
  {
    name: "Playwright",
    version: "1.58.2",
    bracketedIpv6: true,
  },
  {
    name: "Playwright",
    version: "1.64.1",
    bracketedIpv6: true,
    unavailableFailedRequestTimings: true,
  },
  {
    name: "WebInspector",
    version: "537.36",
    label: "Chromium DevTools (WebInspector 537.36)",
    bracketedIpv6: true,
    emptyServerAddress: true,
  },
  { name: "mitmproxy", version: "12.2.3", nullPostDataText: true },
];

/** Validation changes tied to observed spelling and the declared producer. */
interface HarEntryAdaptation {
  readonly producer: string;
  readonly entries: readonly number[];
}

interface HarProducerAdaptations {
  readonly bracketedIpv6: HarEntryAdaptation | null;
  readonly emptyServerAddress: HarEntryAdaptation | null;
  readonly failedRequests: HarEntryAdaptation | null;
}

/** Validate with pinned HAR 1.2 draft-06 schemas and the owned schema corrections. */
export const createHarValidator = (): ((
  value: unknown,
) => HarProducerAdaptations) => {
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
  ajv.addFormat(HAR_REQUEST_URL_FORMAT, harRequestUrlValidator(plugin));
  const propertiesSchema = z.record(z.string(), z.unknown());
  const correctedSchemas: Record<string, Record<string, unknown>> = {
    timings: timingsSchema,
    cache: { ...schemas.cache, type: "object" },
    request: {
      ...schemas.request,
      properties: {
        ...propertiesSchema.parse(schemas.request?.properties),
        url: { type: "string", format: HAR_REQUEST_URL_FORMAT },
      },
    },
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
    const adaptations = allowObservedProducerRepresentations(value);
    if (!validate(value)) {
      const error = validate.errors?.[0];
      // AJV messages name the violated constraint, such as the missing
      // property, without restating any captured value.
      throw new CaptureFormatError(
        "malformed",
        error === undefined
          ? "HAR schema validation failed: unknown constraint."
          : `HAR schema validation failed: ${error.keyword} (${error.message ?? "no detail"}).`,
        error?.instancePath ?? "",
      );
    }
    return adaptations;
  };
};

/** Adapt only observed producer representations in the disposable validation copy. */
const allowObservedProducerRepresentations = (
  value: unknown,
): HarProducerAdaptations => {
  const none = {
    bracketedIpv6: null,
    emptyServerAddress: null,
    failedRequests: null,
  };
  if (!captureObject(value) || !captureObject(value.log)) return none;
  const log = value.log;
  const creator = log.creator;
  if (!captureObject(creator) || !Array.isArray(log.entries)) return none;
  const profile = HAR_PRODUCER_PROFILES.find(
    ({ name, version }) => creator.name === name && creator.version === version,
  );
  if (profile === undefined) return none;
  const failedRequests: number[] = [];
  const adaptedEntries: number[] = [];
  const emptyAddressEntries: number[] = [];
  for (const [ordinal, entry] of log.entries.entries()) {
    const candidate: unknown = entry;
    if (!captureObject(candidate)) continue;
    // Playwright leaves required durations at -1 when a request fails before
    // response timing is available. Adapt only this observed sentinel in the
    // disposable validation copy; the recorded values remain unchanged.
    const response = candidate.response;
    const timings = candidate.timings;
    if (
      profile.unavailableFailedRequestTimings &&
      captureObject(response) &&
      typeof response._failureText === "string" &&
      response._failureText.length > 0 &&
      captureObject(timings)
    ) {
      let adapted = false;
      for (const field of ["send", "wait", "receive"])
        if (timings[field] === -1) {
          timings[field] = 0;
          adapted = true;
        }
      if (adapted) failedRequests.push(ordinal);
    }
    const address = candidate.serverIPAddress;
    if (
      profile.bracketedIpv6 &&
      typeof address === "string" &&
      address.startsWith("[") &&
      address.endsWith("]") &&
      !address.includes("%") &&
      isIP(address.slice(1, -1)) === 6
    ) {
      candidate.serverIPAddress = address.slice(1, -1);
      adaptedEntries.push(ordinal);
    }
    // DevTools writes request.remoteAddress(), which stays "" when a request
    // has no remote endpoint (a failed connection, an aborted or internally
    // redirected request). serverIPAddress is optional, so only the
    // validation copy omits that empty value.
    if (profile.emptyServerAddress && address === "") {
      delete candidate.serverIPAddress;
      emptyAddressEntries.push(ordinal);
    }
    if (!profile.nullPostDataText) continue;
    const request = candidate.request;
    if (!captureObject(request)) continue;
    const body = request.postData;
    if (captureObject(body) && body.text === null) delete body.text;
  }
  const producer = profile.label ?? `${profile.name} ${profile.version}`;
  return {
    bracketedIpv6:
      adaptedEntries.length === 0
        ? null
        : { producer, entries: adaptedEntries },
    emptyServerAddress:
      emptyAddressEntries.length === 0
        ? null
        : { producer, entries: emptyAddressEntries },
    failedRequests:
      failedRequests.length === 0
        ? null
        : { producer, entries: failedRequests },
  };
};

const HAR_REQUEST_URL_FORMAT = "absolute-url";

// HAR 1.2 defines request.url only as the absolute request URL. har-schema's
// RFC 3986 `uri` format rejects URLs exactly as browsers serialize and send
// them, such as an unescaped `|` or `{` in the query. Keep every RFC 3986 URL
// admitted, even one WHATWG would rewrite. Otherwise admit only a spelling that
// WHATWG URL serialization reproduces unchanged, so a URL admitted by this
// branch reads the same under WHATWG as it was recorded.
const harRequestUrlValidator = (
  plugin: object,
): ((value: string) => boolean) => {
  const getFormat: unknown = Reflect.get(plugin, "get");
  const rfc3986 = isCallable(getFormat) ? getFormat("uri") : undefined;
  if (!isCallable(rfc3986))
    throw new Error("Pinned AJV uri format is unavailable");
  return (value) => rfc3986(value) === true || URL.parse(value)?.href === value;
};

const isCallable = (value: unknown): value is (argument: string) => unknown =>
  typeof value === "function";
