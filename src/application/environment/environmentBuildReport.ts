import { z } from "zod";
import { basename } from "node:path";
import { isIP } from "node:net";

import {
  isJsonLike,
  mediaTypeEssence,
} from "../../domain/analysisView/recordedMediaType.js";
import {
  decodeRetainedBase64,
  readRecordedResponseBody,
  type RecordedResponseBody,
} from "../../domain/analysisView/recordedResponseBody.js";
import { scenarioContentMediaType } from "../../domain/analysisView/scenarioCaptureRecords.js";
import type { BrowserScenarioEvent } from "../../domain/browserScenarioCaptureValues.js";
import type { EnvironmentBuildReport } from "../../domain/environmentBundleExport.js";
import {
  iterateUrlQueryParameters,
  parseRecordedTransportUrl,
} from "../../domain/recordedTransportUrl.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";

/** A note the build report carries; warnings never change what is built. */
export type EnvironmentBuildWarning =
  EnvironmentBuildReport["warnings"][number];

/** Whole name segments that name credentials; `author` is not `auth`. */
const CREDENTIAL_SEGMENTS = new Set([
  "accesstoken",
  "apikey",
  "apikeys",
  "apitoken",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "secret",
  "secrets",
  "session",
  "sessionid",
  "token",
  "tokens",
]);
const CREDENTIAL_PAIRS = new Set([
  "access key",
  "api key",
  "api keys",
  "client secret",
  "private key",
  "session id",
  "ssh key",
]);

/** A segment longer than every credential word matches none, so it is not kept. */
const LONGEST_SEGMENT = Math.max(
  ...[
    ...CREDENTIAL_SEGMENTS,
    ...[...CREDENTIAL_PAIRS].join(" ").split(" "),
  ].map((segment) => segment.length),
);

const upper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const lower = (code: number): boolean => code >= 0x61 && code <= 0x7a;
const digit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * Whether a member, header or query name looks like it holds a credential: a
 * lowercase segment, split at separators and case changes (`apiKey`,
 * `APIToken`, `api_key`), is a credential word, or follows the segment it
 * pairs with. The name is read once in place, keeping at most two short
 * segments, so a name of any length allocates no copies or segment list.
 * Lowercasing follows `toLowerCase`: U+212A KELVIN SIGN reads as `k`, and
 * U+0130 as `i` followed by a combining dot that ends the segment.
 */
export const credentialNamed = (name: string): boolean => {
  /** The segment before this one, or null when there is none or it was too long. */
  let previous: string | null = null;
  let segment = "";
  let open = false;
  let long = false;
  const close = (): boolean => {
    if (!open) return false;
    const word = long ? null : segment;
    const found =
      word !== null &&
      (CREDENTIAL_SEGMENTS.has(word) ||
        (previous !== null && CREDENTIAL_PAIRS.has(`${previous} ${word}`)));
    previous = word;
    segment = "";
    open = false;
    long = false;
    return found;
  };
  const append = (letter: string): void => {
    open = true;
    if (long) return;
    if (segment.length === LONGEST_SEGMENT) {
      long = true;
      segment = "";
    } else segment += letter;
  };
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (upper(code)) {
      // `aB` and `1B` start a segment at `B`; so does `C` in `ABCd`.
      const before = name.charCodeAt(index - 1);
      if (
        (lower(before) ||
          digit(before) ||
          (upper(before) && lower(name.charCodeAt(index + 1)))) &&
        close()
      )
        return true;
      append(String.fromCharCode(code + 0x20));
    } else if (lower(code) || digit(code)) append(name[index]!);
    else if (code === 0x212a) append("k");
    else if (code === 0x130) {
      append("i");
      if (close()) return true;
    } else if (close()) return true;
  }
  return close();
};

/** Bodies larger than this are not scanned. */
const SCAN_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** Values one scan reads in all, over every body and name/value list; each is charged before it is parsed or read. */
const SCAN_VALUE_BUDGET = 524_288;
/** Pointers the report lists; the count covers every match. */
const REPORTED_POINTERS = 20;

const pointerToken = (name: string): string =>
  name.replaceAll("~", "~0").replaceAll("/", "~1");

/** A held value: a non-empty string, or an array holding one. */
const holdsValue = (value: unknown): boolean =>
  (typeof value === "string" && value !== "") ||
  (Array.isArray(value) &&
    value.some((item) => typeof item === "string" && item !== ""));

const member = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;

/** A recorded body: text the scan parses as JSON or as form fields (in order, every occurrence kept, as headers and query strings are) once it fits the budget, or text too large or cut to scan. */
type ScannedBody =
  | { readonly kind: "json" | "form"; readonly text: string }
  | { readonly kind: "skipped" };

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
/** Space, tab, line feed and carriage return, the only whitespace JSON allows around a value. */
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** The parser a recorded media type names; otherwise JSON by its first character, or a form when it has `=` and no whitespace, which form encoding never leaves raw. */
const bodyFormat = (
  text: string,
  mediaType: unknown,
): "json" | "form" | undefined => {
  const essence =
    typeof mediaType === "string" ? mediaTypeEssence(mediaType) : null;
  if (essence === FORM_MEDIA_TYPE) return "form";
  if (isJsonLike(essence)) return "json";
  const start = text.trimStart()[0];
  if (start === "{" || start === "[") return "json";
  return text.includes("=") && !/\s/u.test(text) ? "form" : undefined;
};

/**
 * An upper bound on the values the text holds, counted no further than one
 * past `limit`. JSON text holds its first value only once it has a
 * non-whitespace character, and each later `[`, `{` and `,` starts at most one
 * more; one inside a string only loosens the bound. A form holds one field per
 * non-empty `&`-separated piece after an optional leading `?`, exactly as
 * `URLSearchParams` and the query reader split it. The count bounds the parse
 * before it allocates, and text that holds nothing, such as an empty query or
 * a bare `?`, charges nothing.
 */
const valueBound = (
  text: string,
  format: "json" | "form",
  limit: number,
): number => {
  let values = 0;
  let pieceStart = true;
  for (
    let index = format === "form" && text.startsWith("?") ? 1 : 0;
    index < text.length && values <= limit;
    index++
  ) {
    const code = text.charCodeAt(index);
    if (format === "form") {
      if (code === 0x26) pieceStart = true;
      else if (pieceStart) {
        values++;
        pieceStart = false;
      }
      continue;
    }
    if (values === 0 && !JSON_WHITESPACE.has(code)) values++;
    if (code === 0x5b || code === 0x7b || code === 0x2c) values++;
  }
  return values;
};

/** A recorded body the scan may parse, skipped when it is cut or over the text limit, or undefined when it is neither JSON nor a form. */
const scannableBody = (
  text: unknown,
  mediaType: unknown,
  cut = false,
): ScannedBody | undefined => {
  if (typeof text !== "string") return undefined;
  if (cut || Buffer.byteLength(text, "utf8") > SCAN_BODY_LIMIT_BYTES)
    return { kind: "skipped" };
  const kind = bodyFormat(text, mediaType);
  return kind === undefined ? undefined : { kind, text };
};

/** Decoded body text as the scan reads it; binary bytes hold no JSON or form text. */
const decodedBody = (
  body: RecordedResponseBody,
  mediaType: unknown,
): ScannedBody | undefined =>
  body.bodyEncoding === "base64"
    ? undefined
    : scannableBody(body.bodyText, mediaType, body.bodyCut === true);

/** A count of matches and the first of their pointers. */
interface ScanTally {
  count: number;
  readonly pointers: string[];
}

type CredentialScan = Readonly<ScanTally> & {
  readonly skipped: Readonly<ScanTally>;
};

const tallied = (tally: ScanTally, pointer: string): void => {
  tally.count++;
  if (tally.pointers.length < REPORTED_POINTERS) tally.pointers.push(pointer);
};

/**
 * The tallies both capture readers fill: a named value counts when its name
 * looks like a credential and it holds a value. One value budget covers the
 * whole scan: every body and name/value list is charged to it before it is
 * parsed or read, so the scan's work stays bounded however many records are
 * selected, and what does not fit is tallied as skipped. The body walk keeps
 * its own stack, so nesting depth cannot overflow it.
 */
const credentialTally = () => {
  const matches: ScanTally = { count: 0, pointers: [] };
  const skipped: ScanTally = { count: 0, pointers: [] };
  let remaining = SCAN_VALUE_BUDGET;
  /** Whether `values` more fit the budget, charging them; otherwise the label is tallied as skipped. */
  const charge = (values: number, label: string): boolean => {
    if (values > remaining) {
      tallied(skipped, label);
      return false;
    }
    remaining -= values;
    return true;
  };
  const field = (pointer: string, name: string, value: unknown): void => {
    if (credentialNamed(name) && holdsValue(value)) tallied(matches, pointer);
  };
  /** Name/value entries such as HAR headers, query strings and form params, read in place once their count fits the budget. */
  const entries = (
    items: unknown,
    label: string,
    each: (name: string, value: unknown) => void,
  ): void => {
    if (!Array.isArray(items) || !charge(items.length, label)) return;
    for (const entry of items as unknown[]) {
      const name = member(entry, "name");
      if (typeof name === "string") each(name, member(entry, "value"));
    }
  };
  /** Form-encoded text such as a transaction URL's query, read field by field once its bound fits the budget. */
  const query = (
    text: string,
    label: string,
    each: (name: string, value: string) => void,
  ): void => {
    if (!charge(valueBound(text, "form", remaining), label)) return;
    for (const [name, value] of iterateUrlQueryParameters(text))
      each(name, value);
  };
  const walk = (root: unknown, label: string): void => {
    const stack: [unknown, string][] = [[root, ""]];
    while (stack.length > 0) {
      const [value, pointer] = stack.pop()!;
      if (typeof value !== "object" || value === null) continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--)
          stack.push([value[index], `${pointer}/${String(index)}`]);
        continue;
      }
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [name, child] = entries[index]!;
        const path = `${pointer}/${pointerToken(name)}`;
        field(`${label} ${path}`, name, child);
        stack.push([child, path]);
      }
    }
  };
  const body = (scanned: ScannedBody | undefined, label: string): void => {
    if (scanned === undefined) return;
    if (scanned.kind === "skipped") {
      tallied(skipped, label);
      return;
    }
    if (!charge(valueBound(scanned.text, scanned.kind, remaining), label))
      return;
    if (scanned.kind === "form") {
      for (const [name, value] of new URLSearchParams(scanned.text))
        field(`${label} /${pointerToken(name)}`, name, value);
      return;
    }
    try {
      walk(JSON.parse(scanned.text), label);
    } catch {
      // Text that does not parse as JSON holds no members to scan.
    }
  };
  return {
    field,
    entries,
    query,
    body,
    result: (): CredentialScan => ({ ...matches, skipped }),
  };
};

/**
 * Credential-named members that hold a value in recorded JSON and form
 * bodies, headers and query strings: a count and the first pointers, never
 * values, and the bodies, header lists and query strings it did not read,
 * by record and side.
 */
export const scanCredentialNames = (
  records: readonly WebNetworkCaptureRecord[],
): CredentialScan => {
  const scan = credentialTally();
  for (const record of records) {
    const ordinal = String(record.ordinal);
    const request = member(record.reported, "request");
    const response = member(record.reported, "response");
    for (const [side, message] of [
      ["request", request],
      ["response", response],
    ] as const)
      scan.entries(
        member(message, "headers"),
        `record ${ordinal} ${side} headers`,
        (name, value) =>
          scan.field(`record ${ordinal} ${side} header ${name}`, name, value),
      );
    scan.entries(
      member(request, "queryString"),
      `record ${ordinal} request query`,
      (name, value) =>
        scan.field(`record ${ordinal} request query ${name}`, name, value),
    );
    const postData = member(request, "postData");
    const text = member(postData, "text");
    const label = `record ${ordinal} request`;
    // A HAR may record form fields only as structured params; each occurrence counts, as in a form body.
    if (typeof text !== "string")
      scan.entries(member(postData, "params"), label, (name, value) => {
        if (typeof value === "string")
          scan.field(`${label} /${pointerToken(name)}`, name, value);
      });
    else scan.body(scannableBody(text, member(postData, "mimeType")), label);
    scan.body(
      decodedBody(
        readRecordedResponseBody(record, SCAN_BODY_LIMIT_BYTES),
        member(member(response, "content"), "mimeType"),
      ),
      `record ${ordinal} response`,
    );
  }
  return scan.result();
};

/**
 * The same scan over a browser scenario's retained events, by index in
 * `events.items`: every network-content event's headers and body, whether or
 * not a record represents its transaction, and each transaction URL's query
 * once.
 */
export const scanScenarioCredentialNames = (
  events: readonly BrowserScenarioEvent[],
): CredentialScan => {
  const scan = credentialTally();
  const urls = new Set<string>();
  for (const [index, event] of events.entries()) {
    const label = `event ${String(index)}`;
    if (event.kind === "network-content") {
      const side = `${label} ${event.phase}`;
      if (event.headers.state === "captured")
        scan.entries(event.headers.items, `${side} headers`, (name, value) =>
          scan.field(`${side} header ${name}`, name, value),
        );
      if (event.body.state === "captured")
        scan.body(
          decodedBody(
            decodeRetainedBase64(event.body.content, SCAN_BODY_LIMIT_BYTES),
            scenarioContentMediaType(event),
          ),
          side,
        );
    } else if ("transaction_id" in event) {
      // Every event of a transaction repeats its URL; a response attached mid-flight may be the only one.
      const key = `${event.transaction_id} ${event.url.url}`;
      if (urls.has(key)) continue;
      urls.add(key);
      const { query } = parseRecordedTransportUrl(event.url.url, {
        includeQuery: true,
      });
      if (typeof query === "string")
        scan.query(query, `${label} ${event.kind} query`, (name, value) =>
          scan.field(`${label} ${event.kind} query ${name}`, name, value),
        );
    }
  }
  return scan.result();
};

/** The credential-name scan's warnings: what it found, and what it could not read. */
export const credentialScanWarnings = (capture: {
  readonly records: readonly WebNetworkCaptureRecord[];
  readonly scenarioEvents: readonly BrowserScenarioEvent[] | null;
}): EnvironmentBuildWarning[] => {
  const scanned =
    capture.scenarioEvents === null
      ? scanCredentialNames(capture.records)
      : scanScenarioCredentialNames(capture.scenarioEvents);
  const warnings: EnvironmentBuildWarning[] = [];
  if (scanned.count > 0)
    warnings.push({
      code: "credential-named-members",
      message: `${String(scanned.count)} recorded body members have credential-like names and a value; evidence.json ships them, so review it before sharing.`,
      pointers: scanned.pointers,
    });
  if (scanned.skipped.count > 0)
    warnings.push({
      code: "credential-scan-incomplete",
      message: `${String(scanned.skipped.count)} recorded bodies, header lists or query strings were not scanned: each is cut, over 4 MiB of text, or past the 524288 values the credential-name scan reads in all; evidence.json ships them, so review them before sharing.`,
      pointers: scanned.skipped.pointers,
    });
  return warnings;
};

const savedEntries = z.array(
  z.object({ name: z.string(), secret: z.boolean().optional() }),
);
const scenarioSaves = z.object({
  actions: z.array(
    z
      .object({
        save: savedEntries.optional(),
        save_response: z.object({ save: savedEntries }).optional(),
      })
      .loose(),
  ),
});

/** A browser scenario's saved values named like credentials but not marked secret, which the capture records unredacted. */
export const savedCredentialWarnings = (
  parameters: unknown,
): EnvironmentBuildWarning[] => {
  const parsed = scenarioSaves.safeParse(parameters);
  if (!parsed.success) return [];
  const pointers: string[] = [];
  parsed.data.actions.forEach((action, index) => {
    const unmarked = (
      entries:
        | readonly {
            readonly name: string;
            readonly secret?: boolean | undefined;
          }[]
        | undefined,
      at: string,
    ) =>
      entries?.forEach((entry, position) => {
        if (entry.secret !== true && credentialNamed(entry.name))
          pointers.push(
            `/parameters/actions/${String(index)}/${at}/${String(position)}`,
          );
      });
    unmarked(action.save, "save");
    unmarked(action.save_response?.save, "save_response/save");
  });
  return pointers.length === 0
    ? []
    : [
        {
          code: "credential-named-saved-values",
          message: `${String(pointers.length)} saved values have credential-like names but are not marked secret, so the capture records them unredacted; mark them \`secret: true\` and record again before sharing.`,
          pointers: pointers.slice(0, REPORTED_POINTERS),
        },
      ];
};

/** Whether an origin's host is a loopback name or an IP literal, which says nothing about the application. */
export const anonymousOrigin = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bracketless = host.startsWith("[") ? host.slice(1, -1) : host;
  const bare = bracketless.endsWith(".")
    ? bracketless.slice(0, -1)
    : bracketless;
  return (
    bare === "localhost" || bare.endsWith(".localhost") || isIP(bare) !== 0
  );
};

/** A kebab-case name from a capture file's name: `grafana.har` and `grafana.capture.json` become `grafana`. */
export const nameFromCaptureFile = (path: string): string =>
  basename(path)
    .replace(/\.(?:har|json)$/iu, "")
    .replace(/\.capture$/iu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
