import { getManyValues, isMany, none, type Many } from "stream-chain/defs.js";
import { jsonParser, type Token } from "stream-json/core/parser.js";
import { isHostLimitFailure } from "../parseFailure.js";

/**
 * Containers kept for the summary are at most three deep (the record, `user`,
 * and `groups`). Anything deeper belongs to an ignored body. The tokenizer
 * stops there so a nested body cannot grow a value tree or the parser stack.
 */
export const KUBERNETES_AUDIT_JSON_DEPTH = 64;
/** Longer than every owned key. A longer key cannot match and is not stored. */
const MAX_OWNED_KEY_CHARS = 64;
/** Longer than every safe integer's decimal form. */
const MAX_NUMBER_CHARS = 20;

const ROOT_STRINGS = new Set([
  "apiVersion",
  "auditID",
  "stage",
  "requestURI",
  "verb",
  "userAgent",
  "requestReceivedTimestamp",
]);
const OBJECT_REF_STRINGS = new Set(["resource", "namespace", "name"]);

type AuditJsonTokenizer = (
  value: string | typeof none,
) => Many<Token> | typeof none;

type StringList = {
  readonly kind: "strings";
  readonly target: "sourceIPs" | "groups";
  readonly values: string[];
  invalid: boolean;
};
type Frame =
  | { readonly kind: "root" }
  | { readonly kind: "skip" }
  | { readonly kind: "user" }
  | { readonly kind: "objectRef" }
  | { readonly kind: "responseStatus" }
  | StringList;

export type KubernetesAuditLineParse =
  | { readonly kind: "event"; readonly value: Record<string, unknown> }
  | { readonly kind: "syntax" }
  | { readonly kind: "nesting" };

const detachedText = (value: string): string =>
  Buffer.from(value, "utf16le").toString("utf16le");

const isTokenizerDepth = (cause: unknown): boolean =>
  cause instanceof Error &&
  cause.name === "RangeError" &&
  cause.message.includes("maxDepth");

/**
 * Read one audit line without building object bodies the inventory does not
 * keep. `requestObject`, `responseObject`, annotations and any other container
 * are skipped. A body deeper than {@link KUBERNETES_AUDIT_JSON_DEPTH} stops
 * the scan; identity already read is kept and fields after that body are absent.
 */
export const parseKubernetesAuditLine = (
  line: string,
): KubernetesAuditLineParse => {
  const value: Record<string, unknown> = {};
  const user: Record<string, unknown> = {};
  const objectRef: Record<string, unknown> = {};
  const responseStatus: Record<string, unknown> = {};
  let sawUser = false;
  let sawObject = false;
  let sawStatus = false;
  const stack: Frame[] = [];
  let pendingKey: string | undefined;
  let capture: "key" | "string" | "number" | undefined;
  let text = "";
  let keyTooLong = false;
  let numberTooLong = false;

  const top = (): Frame | undefined => stack.at(-1);
  const skipping = (): boolean => top()?.kind === "skip";

  const ownedString = (): boolean => {
    const frame = top();
    if (frame === undefined || frame.kind === "skip") return false;
    if (frame.kind === "strings") return true;
    if (frame.kind === "root")
      return pendingKey !== undefined && ROOT_STRINGS.has(pendingKey);
    if (frame.kind === "user") return pendingKey === "username";
    if (frame.kind === "objectRef")
      return pendingKey !== undefined && OBJECT_REF_STRINGS.has(pendingKey);
    return false;
  };

  const takeString = (entry: string): void => {
    const frame = top();
    const kept = detachedText(entry);
    if (frame?.kind === "strings") {
      frame.values.push(kept);
      return;
    }
    if (frame?.kind === "root" && pendingKey !== undefined)
      value[pendingKey] = kept;
    else if (frame?.kind === "user" && pendingKey === "username") {
      sawUser = true;
      user.username = kept;
    } else if (
      frame?.kind === "objectRef" &&
      pendingKey !== undefined &&
      OBJECT_REF_STRINGS.has(pendingKey)
    ) {
      sawObject = true;
      objectRef[pendingKey] = kept;
    }
  };

  const rejectScalar = (): void => {
    const frame = top();
    if (frame?.kind === "strings") {
      frame.invalid = true;
      return;
    }
    if (frame?.kind === "root" && pendingKey !== undefined) {
      if (pendingKey === "auditID" || pendingKey === "stage")
        value[pendingKey] = null;
      else if (ROOT_STRINGS.has(pendingKey)) value[pendingKey] = null;
      else delete value[pendingKey];
    } else if (frame?.kind === "responseStatus" && pendingKey === "code") {
      sawStatus = true;
      responseStatus.code = null;
    }
  };

  const pushValue = (token: "object" | "array"): void => {
    const frame = top();
    if (frame === undefined) {
      stack.push(token === "object" ? { kind: "root" } : { kind: "skip" });
      pendingKey = undefined;
      return;
    }
    if (token === "object" && frame.kind === "root") {
      if (pendingKey === "user") {
        sawUser = true;
        for (const key of Object.keys(user)) delete user[key];
        stack.push({ kind: "user" });
      } else if (pendingKey === "objectRef") {
        sawObject = true;
        for (const key of Object.keys(objectRef)) delete objectRef[key];
        stack.push({ kind: "objectRef" });
      } else if (pendingKey === "responseStatus") {
        sawStatus = true;
        delete responseStatus.code;
        stack.push({ kind: "responseStatus" });
      } else stack.push({ kind: "skip" });
    } else if (
      token === "array" &&
      frame.kind === "root" &&
      pendingKey === "sourceIPs"
    )
      stack.push({
        kind: "strings",
        target: "sourceIPs",
        values: [],
        invalid: false,
      });
    else if (
      token === "array" &&
      frame.kind === "user" &&
      pendingKey === "groups"
    )
      stack.push({
        kind: "strings",
        target: "groups",
        values: [],
        invalid: false,
      });
    else stack.push({ kind: "skip" });
    pendingKey = undefined;
    capture = undefined;
  };

  const finishList = (frame: StringList): void => {
    const list = frame.invalid ? null : frame.values;
    if (frame.target === "sourceIPs") value.sourceIPs = list;
    else {
      sawUser = true;
      user.groups = list;
    }
  };

  const consume = (token: Token): void => {
    if (token.name === "startObject") {
      pushValue("object");
      return;
    }
    if (token.name === "startArray") {
      pushValue("array");
      return;
    }
    if (token.name === "endObject" || token.name === "endArray") {
      const frame = stack.pop();
      if (frame?.kind === "strings") finishList(frame);
      pendingKey = undefined;
      capture = undefined;
      return;
    }
    if (skipping()) return;
    switch (token.name) {
      case "startKey":
        capture = "key";
        text = "";
        keyTooLong = false;
        break;
      case "endKey":
        pendingKey = keyTooLong ? undefined : text;
        capture = undefined;
        break;
      case "startString":
        if (ownedString()) {
          capture = "string";
          text = "";
        } else rejectScalar();
        break;
      case "stringChunk":
        if (capture === "key" && text.length <= MAX_OWNED_KEY_CHARS) {
          const room = MAX_OWNED_KEY_CHARS + 1 - text.length;
          text += token.value.slice(0, room);
          if (text.length > MAX_OWNED_KEY_CHARS) keyTooLong = true;
        } else if (capture === "string") text += token.value;
        break;
      case "endString":
        if (capture === "string") takeString(text);
        capture = undefined;
        pendingKey = undefined;
        break;
      case "startNumber":
        if (top()?.kind === "responseStatus" && pendingKey === "code") {
          capture = "number";
          text = "";
          numberTooLong = false;
        } else rejectScalar();
        break;
      case "numberChunk":
        if (capture === "number" && text.length <= MAX_NUMBER_CHARS) {
          const room = MAX_NUMBER_CHARS + 1 - text.length;
          text += token.value.slice(0, room);
          if (text.length > MAX_NUMBER_CHARS) numberTooLong = true;
        }
        break;
      case "endNumber":
        if (capture === "number") {
          const code = Number(text);
          sawStatus = true;
          responseStatus.code =
            !numberTooLong && Number.isSafeInteger(code) ? code : null;
        }
        capture = undefined;
        pendingKey = undefined;
        break;
      case "nullValue":
      case "trueValue":
      case "falseValue":
        rejectScalar();
        pendingKey = undefined;
        break;
      case "keyValue":
      case "numberValue":
      case "stringValue":
      case "whitespace":
        break;
    }
  };

  const publish = (): Record<string, unknown> => {
    if (sawUser) value.user = { ...user };
    if (sawObject) value.objectRef = { ...objectRef };
    if (sawStatus) value.responseStatus = { ...responseStatus };
    return value;
  };

  const tokens = jsonParser({
    packValues: false,
    packKeys: false,
    packStrings: false,
    packNumbers: false,
    streamValues: false,
    jsonStreaming: false,
    maxDepth: KUBERNETES_AUDIT_JSON_DEPTH,
  }) as AuditJsonTokenizer;
  const feed = (chunk: string | typeof none): void => {
    const produced = tokens(chunk);
    if (isMany(produced))
      for (const token of getManyValues(produced)) consume(token);
  };
  try {
    // One code unit at a time. A larger slice that later exceeds the depth
    // cap throws away every token in that slice, including identity fields
    // that were already scanned.
    for (let index = 0; index < line.length; index += 1)
      feed(line.charAt(index));
    feed(none);
  } catch (cause: unknown) {
    if (isHostLimitFailure(cause)) throw cause;
    if (!isTokenizerDepth(cause)) return { kind: "syntax" };
    return typeof value.auditID === "string" && typeof value.stage === "string"
      ? { kind: "event", value: publish() }
      : { kind: "nesting" };
  }
  return { kind: "event", value: publish() };
};
