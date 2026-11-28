import {
  sanitizeBrowserUrl,
  type InspectWebPageInput,
} from "../domain/browserObservation.js";
import { parseRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import {
  browserCssVariableItemSchema,
  DEFAULT_MAX_CSS_VARIABLES,
  DEFAULT_MAX_CSS_VARIABLE_VALUE_LENGTH,
  type BrowserCssVariableItem,
  type BrowserCssVariables,
} from "../domain/browserObservationSchemas.js";
import { boundedList } from "../domain/boundedList.js";
import { ellipsisExcerpt } from "../domain/excerpt.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import {
  cdpStringValue,
  numberValue,
  recordValue,
  recordsValue,
} from "./CdpCaptureValues.js";
import type { CdpConnection } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import type { CdpCommand, CdpCommandParams } from "./protocol/CdpCommands.js";

const MAX_INTAKE_CSS_VARIABLES = 2000;
const MAX_REJECTED_PREVIEWS = 3;
const MAX_PREVIEW_NAME_LENGTH = 64;

const sanitizeDiagnosticPreview = (text: string): string =>
  text.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, "");

const decodeCssUrlWithSpanMap = (
  rawUrl: string,
): {
  readonly decoded: string;
  readonly rawStartMap: readonly number[];
  readonly rawEndMap: readonly number[];
} => {
  if (!rawUrl.includes("\\")) {
    const rawStartMap = Array.from({ length: rawUrl.length }, (_, i) => i);
    const rawEndMap = Array.from({ length: rawUrl.length }, (_, i) => i + 1);
    return { decoded: rawUrl, rawStartMap, rawEndMap };
  }
  let decoded = "";
  const rawStartMap: number[] = [];
  const rawEndMap: number[] = [];
  let curr = 0;
  while (curr < rawUrl.length) {
    const ch = rawUrl[curr]!;
    if (ch === "\\") {
      const [unescaped, nextPos] = consumeEscape(rawUrl, curr + 1);
      for (let k = 0; k < unescaped.length; k++) {
        rawStartMap.push(curr);
        rawEndMap.push(nextPos);
      }
      decoded += unescaped;
      curr = nextPos;
    } else {
      rawStartMap.push(curr);
      rawEndMap.push(curr + 1);
      decoded += ch;
      curr++;
    }
  }
  return { decoded, rawStartMap, rawEndMap };
};

const redactCssUrl = (
  rawUrl: string,
): { readonly url: string; readonly redacted: boolean } => {
  const { decoded, rawStartMap, rawEndMap } = decodeCssUrlWithSpanMap(rawUrl);
  const { credentials } = parseRecordedTransportUrl(decoded);
  if (credentials !== null && typeof credentials === "object") {
    const rawStart = rawStartMap[credentials.start] ?? rawUrl.length;
    const rawEnd =
      credentials.end === 0
        ? 0
        : (rawEndMap[credentials.end - 1] ?? rawUrl.length);
    return {
      url: `${rawUrl.slice(0, rawStart)}${rawUrl.slice(rawEnd)}`,
      redacted: true,
    };
  }
  const sanitized = sanitizeBrowserUrl(decoded);
  if (sanitized.redacted) {
    return { url: sanitized.url, redacted: true };
  }
  if (credentials === "ambiguous") {
    const withBase = URL.parse(decoded, "https://rea.invalid");
    if (
      withBase !== null &&
      (withBase.username !== "" || withBase.password !== "")
    ) {
      withBase.username = "";
      withBase.password = "";
      const stripped = /^[\\/]{2}/u.test(decoded.trimStart())
        ? `//${withBase.host}${withBase.pathname}${withBase.search}${withBase.hash}`
        : withBase.href;
      return { url: stripped, redacted: true };
    }
    return { url: "[redacted-url]", redacted: true };
  }
  return { url: rawUrl, redacted: false };
};

const isHexDigit = (ch: string): boolean =>
  (ch >= "0" && ch <= "9") ||
  (ch >= "a" && ch <= "f") ||
  (ch >= "A" && ch <= "F");

const isWhitespace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f";

const consumeEscape = (text: string, pos: number): [string, number] => {
  if (pos >= text.length) return ["\uFFFD", pos];
  const first = text[pos]!;
  if (isHexDigit(first)) {
    let hex = "";
    let curr = pos;
    while (curr < text.length && isHexDigit(text[curr]!) && hex.length < 6) {
      hex += text[curr]!;
      curr++;
    }
    if (curr < text.length && isWhitespace(text[curr]!)) {
      curr++;
    }
    const codePoint = parseInt(hex, 16);
    if (
      codePoint === 0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
    ) {
      return ["\uFFFD", curr];
    }
    return [String.fromCodePoint(codePoint), curr];
  }
  if (first === "\r" && pos + 1 < text.length && text[pos + 1] === "\n") {
    return ["", pos + 2];
  }
  if (first === "\r" || first === "\n" || first === "\f") {
    return ["", pos + 1];
  }
  return [first, pos + 1];
};

interface CssUrlMatch {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly rawUrl: string;
  readonly suffix: string;
}

const consumeQuotedString = (
  text: string,
  start: number,
  quote: string,
):
  | {
      readonly urlStart: number;
      readonly urlEnd: number;
      readonly nextPos: number;
    }
  | undefined => {
  let curr = start + 1;
  const len = text.length;
  while (curr < len) {
    const ch = text[curr]!;
    if (ch === quote) {
      return { urlStart: start + 1, urlEnd: curr, nextPos: curr + 1 };
    }
    if (ch === "\r" || ch === "\n" || ch === "\f") {
      return undefined;
    }
    if (ch === "\\") {
      curr++;
      if (curr >= len) return undefined;
      const [, nextPos] = consumeEscape(text, curr);
      curr = nextPos;
      continue;
    }
    curr++;
  }
  return undefined;
};

const findCssUrlMatches = (text: string): readonly CssUrlMatch[] => {
  const matches: CssUrlMatch[] = [];
  const imageSetParens: number[] = [];
  let parenDepth = 0;
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const ch = text[pos]!;
    if (ch === "(") {
      parenDepth++;
      pos++;
      continue;
    }
    if (ch === ")") {
      if (imageSetParens.at(-1) === parenDepth) {
        imageSetParens.pop();
      }
      parenDepth = Math.max(0, parenDepth - 1);
      pos++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quoted = consumeQuotedString(text, pos, ch);
      if (quoted === undefined) {
        pos++;
        continue;
      }
      if (imageSetParens.at(-1) === parenDepth) {
        matches.push({
          start: pos,
          end: quoted.nextPos,
          prefix: ch,
          rawUrl: text.slice(quoted.urlStart, quoted.urlEnd),
          suffix: ch,
        });
      }
      pos = quoted.nextPos;
      continue;
    }

    if (!(/[\w-]/u.test(ch) || ch.charCodeAt(0) >= 0x80 || ch === "\\")) {
      pos++;
      continue;
    }

    let identName = "";
    let curr = pos;
    while (curr < len) {
      const identCh = text[curr]!;
      if (identCh === "\\") {
        const [escapedChar, nextPos] = consumeEscape(text, curr + 1);
        identName += escapedChar;
        curr = nextPos;
      } else if (/[\w-]/u.test(identCh) || identCh.charCodeAt(0) >= 0x80) {
        identName += identCh;
        curr++;
      } else {
        break;
      }
    }

    const lowerIdent = identName.toLowerCase();
    if (
      (lowerIdent === "image-set" || lowerIdent === "-webkit-image-set") &&
      curr < len &&
      text[curr] === "("
    ) {
      parenDepth++;
      imageSetParens.push(parenDepth);
      pos = curr + 1;
      continue;
    }

    if (lowerIdent === "url" && curr < len && text[curr] === "(") {
      const start = pos;
      curr++;

      while (curr < len && isWhitespace(text[curr]!)) {
        curr++;
      }

      if (curr >= len) break;

      const firstChar = text[curr]!;
      if (firstChar === '"' || firstChar === "'") {
        const quoted = consumeQuotedString(text, curr, firstChar);
        if (quoted === undefined) {
          pos = curr + 1;
          continue;
        }
        curr = quoted.nextPos;

        while (curr < len && isWhitespace(text[curr]!)) {
          curr++;
        }

        if (curr < len && text[curr] === ")") {
          curr++;
          matches.push({
            start,
            end: curr,
            prefix: text.slice(start, quoted.urlStart),
            rawUrl: text.slice(quoted.urlStart, quoted.urlEnd),
            suffix: text.slice(quoted.urlEnd, curr),
          });
          pos = curr;
          continue;
        }
        pos = start + 1;
        continue;
      } else if (firstChar !== ")") {
        const urlStart = curr;
        let closed = false;
        let urlEnd = curr;

        while (curr < len) {
          const urlCh = text[curr]!;
          if (urlCh === ")") {
            closed = true;
            urlEnd = curr;
            curr++;
            break;
          }
          if (isWhitespace(urlCh)) {
            urlEnd = curr;
            while (curr < len && isWhitespace(text[curr]!)) {
              curr++;
            }
            if (curr < len && text[curr] === ")") {
              closed = true;
              curr++;
            }
            break;
          }
          if (
            urlCh === '"' ||
            urlCh === "'" ||
            urlCh === "(" ||
            /[\x00-\x08\x0B\x0E-\x1F\x7F]/u.test(urlCh)
          ) {
            break;
          }
          if (urlCh === "\\") {
            curr++;
            if (curr >= len) break;
            const [, nextPos] = consumeEscape(text, curr);
            curr = nextPos;
            continue;
          }
          curr++;
        }

        if (closed) {
          matches.push({
            start,
            end: curr,
            prefix: text.slice(start, urlStart),
            rawUrl: text.slice(urlStart, urlEnd),
            suffix: text.slice(urlEnd, curr),
          });
          pos = curr;
          continue;
        }
        pos = start + 1;
        continue;
      } else {
        pos = curr + 1;
        continue;
      }
    }

    pos = Math.max(pos + 1, curr);
  }

  return matches;
};

export const redactCssUrlCredentials = (
  value: string,
  maxLength = DEFAULT_MAX_CSS_VARIABLE_VALUE_LENGTH,
): string => {
  if (
    value.length > maxLength ||
    (!/url\(/iu.test(value) &&
      !/image-set\(/iu.test(value) &&
      !value.includes("\\"))
  ) {
    return value;
  }
  const matches = findCssUrlMatches(value);
  if (matches.length === 0) return value;

  let result = "";
  let lastIndex = 0;
  for (const match of matches) {
    result += value.slice(lastIndex, match.start);
    try {
      const sanitized = redactCssUrl(match.rawUrl);
      if (sanitized.redacted) {
        result += `${match.prefix}${sanitized.url}${match.suffix}`;
      } else {
        result += value.slice(match.start, match.end);
      }
    } catch {
      result += value.slice(match.start, match.end);
    }
    lastIndex = match.end;
  }
  result += value.slice(lastIndex);
  return result;
};

const emptyCssVariables = (
  status: BrowserCssVariables["status"],
): BrowserCssVariables => ({
  status,
  origin_scope: "same_origin",
  total: 0,
  retained_count: 0,
  items: [],
});

const safeCdpCommand = async <M extends CdpCommand>(
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly signal?: AbortSignal;
    readonly events?: {
      readonly completeness: {
        readonly exclude: (
          section: "css_variables",
          reason: "invalid_protocol_value",
          count: number | null,
        ) => void;
      };
    };
  },
  method: M,
  parameters: CdpCommandParams<M>,
  limitations: string[],
): Promise<unknown | undefined> => {
  try {
    const result = await optionalCdpCommand(
      context,
      method,
      parameters,
      limitations,
    );
    if (result.ok) return result.value;
    if (result.error._tag === "CdpMalformedReply") {
      context.events?.completeness.exclude(
        "css_variables",
        "invalid_protocol_value",
        1,
      );
    }
    return undefined;
  } catch (cause: unknown) {
    if (cause instanceof CdpCommandRejection && cause.code === -32000) {
      limitations.push(
        `${method} failed (CDP error -32000): ${cause.reportedMessage ?? "target node detached or unavailable"}.`,
      );
      return undefined;
    }
    throw cause;
  }
};

/**
 * Passively extract declared and computed CSS custom properties (variables)
 * for the root document element of an authorized page target.
 */
export const captureCssVariables = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly input: InspectWebPageInput;
    readonly signal?: AbortSignal;
    readonly events?: {
      readonly completeness: {
        readonly exclude: (
          section: "css_variables",
          reason: "invalid_protocol_value",
          count: number | null,
        ) => void;
      };
    };
  },
  limitations: string[],
): Promise<BrowserCssVariables> => {
  if (!context.input.include_css_variables) {
    return emptyCssVariables("not_approved");
  }

  const doc = await safeCdpCommand(
    context,
    "DOM.getDocument",
    { depth: 1 },
    limitations,
  );
  if (doc === undefined) {
    return emptyCssVariables("unavailable");
  }

  const rootRecord = recordValue(recordValue(doc)?.root);
  if (rootRecord === undefined) {
    context.events?.completeness.exclude(
      "css_variables",
      "invalid_protocol_value",
      1,
    );
    limitations.push("DOM.getDocument response omitted valid root node.");
    return emptyCssVariables("unavailable");
  }

  const children = recordsValue(rootRecord.children);
  const elementChild = children.find((c) => numberValue(c.nodeType) === 1);
  const targetNodeId =
    numberValue(elementChild?.nodeId) ?? numberValue(rootRecord.nodeId);

  if (targetNodeId === undefined || targetNodeId <= 0) {
    context.events?.completeness.exclude(
      "css_variables",
      "invalid_protocol_value",
      1,
    );
    limitations.push(
      "DOM.getDocument response root node omitted valid numeric nodeId.",
    );
    return emptyCssVariables("unavailable");
  }

  const enabled = await safeCdpCommand(context, "CSS.enable", {}, limitations);
  if (enabled === undefined) {
    return emptyCssVariables("unavailable");
  }

  let computedResult: unknown;
  try {
    computedResult = await safeCdpCommand(
      context,
      "CSS.getComputedStyleForNode",
      { nodeId: targetNodeId },
      limitations,
    );
  } finally {
    await safeCdpCommand(context, "CSS.disable", {}, limitations).catch(
      () => undefined,
    );
  }

  if (computedResult === undefined) {
    return emptyCssVariables("unavailable");
  }

  const computedStyleVal = recordValue(computedResult)?.computedStyle;
  if (!Array.isArray(computedStyleVal)) {
    context.events?.completeness.exclude(
      "css_variables",
      "invalid_protocol_value",
      1,
    );
    limitations.push(
      "CSS.getComputedStyleForNode response omitted valid computedStyle property list.",
    );
    return emptyCssVariables("unavailable");
  }

  const maxRetainedVariables =
    context.input.max_css_variables ?? DEFAULT_MAX_CSS_VARIABLES;
  const maxValueLength =
    context.input.max_css_variable_value_length ??
    DEFAULT_MAX_CSS_VARIABLE_VALUE_LENGTH;
  const maxIntake = Math.max(MAX_INTAKE_CSS_VARIABLES, maxRetainedVariables);

  const validItems: BrowserCssVariableItem[] = [];
  let totalObserved = 0;
  let rejectedCount = 0;
  let malformedProtocolEntries = 0;
  const rejectedPreviews: string[] = [];

  for (const entry of computedStyleVal) {
    const prop = recordValue(entry);
    if (prop === undefined) {
      malformedProtocolEntries += 1;
      continue;
    }
    const name = cdpStringValue(prop.name);
    if (name === undefined) {
      malformedProtocolEntries += 1;
      continue;
    }
    if (!name.startsWith("--")) {
      continue;
    }
    const rawValue = cdpStringValue(prop.value);
    if (rawValue === undefined) {
      malformedProtocolEntries += 1;
      totalObserved += 1;
      rejectedCount += 1;
      if (rejectedPreviews.length < MAX_REJECTED_PREVIEWS) {
        const truncatedName = ellipsisExcerpt(
          sanitizeDiagnosticPreview(name),
          MAX_PREVIEW_NAME_LENGTH,
        );
        rejectedPreviews.push(
          `${truncatedName} (missing or invalid protocol string value)`,
        );
      }
      continue;
    }

    totalObserved += 1;

    if (rawValue.length > maxValueLength) {
      rejectedCount += 1;
      if (rejectedPreviews.length < MAX_REJECTED_PREVIEWS) {
        const truncatedName = ellipsisExcerpt(
          sanitizeDiagnosticPreview(name),
          MAX_PREVIEW_NAME_LENGTH,
        );
        rejectedPreviews.push(
          `${truncatedName} (value length ${String(rawValue.length)} exceeds max_css_variable_value_length ${String(maxValueLength)})`,
        );
      }
      continue;
    }

    const sanitizedValue = redactCssUrlCredentials(rawValue, maxValueLength);
    const redacted = sanitizedValue !== rawValue;
    const parsed = browserCssVariableItemSchema.safeParse({
      name,
      value: sanitizedValue,
      redacted,
    });
    if (parsed.success) {
      if (validItems.length < maxIntake) {
        validItems.push(parsed.data);
      }
    } else {
      rejectedCount += 1;
      if (rejectedPreviews.length < MAX_REJECTED_PREVIEWS) {
        const truncatedName = ellipsisExcerpt(
          sanitizeDiagnosticPreview(name),
          MAX_PREVIEW_NAME_LENGTH,
        );
        const issue =
          parsed.error.issues[0]?.message ?? "invalid token format or size";
        rejectedPreviews.push(`${truncatedName} (${issue})`);
      }
    }
  }

  if (malformedProtocolEntries > 0) {
    context.events?.completeness.exclude(
      "css_variables",
      "invalid_protocol_value",
      malformedProtocolEntries,
    );
    limitations.push(
      `CSS.getComputedStyleForNode response contained ${String(malformedProtocolEntries)} malformed property ${malformedProtocolEntries === 1 ? "entry" : "entries"} (missing or invalid protocol values).`,
    );
  }

  if (rejectedCount > 0) {
    const preview = rejectedPreviews.join(", ");
    const remaining =
      rejectedCount > rejectedPreviews.length
        ? ` and ${String(rejectedCount - rejectedPreviews.length)} more`
        : "";
    limitations.push(
      `${String(rejectedCount)} root CSS custom ${rejectedCount === 1 ? "property was" : "properties were"} rejected: ${preview}${remaining}.`,
    );
  }

  validItems.sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );

  const total = totalObserved;
  const items = [...boundedList(validItems, maxRetainedVariables).items];
  const redactedCount = items.filter((item) => item.redacted).length;
  if (redactedCount > 0) {
    limitations.push(
      `${String(redactedCount)} root CSS custom ${redactedCount === 1 ? "property value had transport credentials redacted" : "property values had transport credentials redacted"}.`,
    );
  }

  const status: BrowserCssVariables["status"] =
    malformedProtocolEntries > 0 && items.length === 0
      ? "unavailable"
      : total > items.length || malformedProtocolEntries > 0
        ? "truncated"
        : "included";

  if (total > maxRetainedVariables) {
    limitations.push(
      `CSS custom properties were truncated to ${String(maxRetainedVariables)} items (${String(total)} were observed on the root element).`,
    );
  }

  return {
    status,
    origin_scope: "same_origin",
    total,
    retained_count: items.length,
    items,
  };
};
