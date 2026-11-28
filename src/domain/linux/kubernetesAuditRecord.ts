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

/** Retained list text. A longer list is not stored; the field stays null. */
const LIST_TEXT_BUDGET = 128 * 1024;

type StringList = {
  readonly kind: "strings";
  readonly target: "sourceIPs" | "groups";
  readonly values: string[];
  bytes: number;
  invalid: boolean;
  overBudget: boolean;
};
type Frame =
  | { readonly kind: "root" }
  | { readonly kind: "skip" }
  | { readonly kind: "user" }
  | { readonly kind: "objectRef" }
  | { readonly kind: "responseStatus" }
  | StringList;

export type KubernetesAuditLineParse =
  | {
      readonly kind: "event";
      readonly value: Record<string, unknown>;
      /** True when the tokenizer stopped before the record's closing brace. */
      readonly depthLimited: boolean;
      /** A kept string or list was dropped because it exceeded the text budget. */
      readonly budgetOmitted: boolean;
    }
  | { readonly kind: "syntax" }
  | { readonly kind: "nesting" };

const detachedText = (value: string): string =>
  Buffer.from(value, "utf16le").toString("utf16le");

export const isTokenizerDepth = (cause: unknown): boolean =>
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
  step = 4096,
  replayFrom?: number,
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
  let stringOverflow = false;
  let budgetOmitted = false;

  const top = (): Frame | undefined => stack.at(-1);
  const skipping = (): boolean => top()?.kind === "skip";

  const ownedString = (): boolean => {
    const frame = top();
    if (frame === undefined || frame.kind === "skip") return false;
    if (frame.kind === "strings") return !frame.invalid;
    if (frame.kind === "root")
      return pendingKey !== undefined && ROOT_STRINGS.has(pendingKey);
    if (frame.kind === "user") return pendingKey === "username";
    if (frame.kind === "objectRef")
      return pendingKey !== undefined && OBJECT_REF_STRINGS.has(pendingKey);
    return false;
  };

  const takeString = (entry: string): void => {
    const frame = top();
    if (frame?.kind === "strings") {
      if (frame.invalid) return;
      const cost = 2 * entry.length + 32;
      if (frame.bytes + cost > LIST_TEXT_BUDGET) {
        frame.invalid = true;
        frame.overBudget = true;
        frame.values.length = 0;
        frame.bytes = 0;
        return;
      }
      frame.bytes += cost;
      frame.values.push(detachedText(entry));
      return;
    }
    const kept = detachedText(entry);
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
    if (frame?.kind === "root" && pendingKey === "user") {
      sawUser = false;
      for (const key of Object.keys(user)) delete user[key];
      return;
    }
    if (frame?.kind === "root" && pendingKey === "objectRef") {
      sawObject = false;
      for (const key of Object.keys(objectRef)) delete objectRef[key];
      return;
    }
    if (frame?.kind === "root" && pendingKey === "responseStatus") {
      sawStatus = false;
      delete responseStatus.code;
      return;
    }
    if (frame?.kind === "root" && pendingKey !== undefined) {
      if (pendingKey === "auditID" || pendingKey === "stage")
        value[pendingKey] = null;
      else if (ROOT_STRINGS.has(pendingKey)) value[pendingKey] = null;
      else delete value[pendingKey];
    } else if (frame?.kind === "user" && pendingKey === "groups") {
      sawUser = true;
      user.groups = null;
    } else if (frame?.kind === "user" && pendingKey === "username") {
      sawUser = true;
      user.username = null;
    } else if (
      frame?.kind === "objectRef" &&
      pendingKey !== undefined &&
      OBJECT_REF_STRINGS.has(pendingKey)
    ) {
      sawObject = true;
      objectRef[pendingKey] = null;
    } else if (frame?.kind === "responseStatus" && pendingKey === "code") {
      sawStatus = true;
      responseStatus.code = null;
    }
  };

  /** A container where a scalar or string list was required leaves that field null. */
  const invalidatePending = (): void => {
    const frame = top();
    if (frame?.kind === "strings") {
      frame.invalid = true;
      frame.values.length = 0;
      frame.bytes = 0;
      return;
    }
    if (frame?.kind === "root" && pendingKey === "user") {
      sawUser = false;
      for (const key of Object.keys(user)) delete user[key];
      return;
    }
    if (frame?.kind === "root" && pendingKey === "objectRef") {
      sawObject = false;
      for (const key of Object.keys(objectRef)) delete objectRef[key];
      return;
    }
    if (frame?.kind === "root" && pendingKey === "responseStatus") {
      sawStatus = false;
      delete responseStatus.code;
      return;
    }
    if (frame?.kind === "root" && pendingKey === "sourceIPs") {
      value.sourceIPs = null;
      return;
    }
    if (
      frame?.kind === "root" &&
      pendingKey !== undefined &&
      ROOT_STRINGS.has(pendingKey)
    ) {
      value[pendingKey] = null;
      return;
    }
    if (frame?.kind === "user" && pendingKey === "groups") {
      sawUser = true;
      user.groups = null;
      return;
    }
    if (frame?.kind === "user" && pendingKey === "username") {
      sawUser = true;
      user.username = null;
      return;
    }
    if (
      frame?.kind === "objectRef" &&
      pendingKey !== undefined &&
      OBJECT_REF_STRINGS.has(pendingKey)
    ) {
      sawObject = true;
      objectRef[pendingKey] = null;
      return;
    }
    if (frame?.kind === "responseStatus" && pendingKey === "code") {
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
      } else {
        invalidatePending();
        stack.push({ kind: "skip" });
      }
    } else if (
      token === "array" &&
      frame.kind === "root" &&
      pendingKey === "sourceIPs"
    ) {
      value.sourceIPs = null;
      stack.push({
        kind: "strings",
        target: "sourceIPs",
        values: [],
        bytes: 0,
        invalid: false,
        overBudget: false,
      });
    } else if (
      token === "array" &&
      frame.kind === "user" &&
      pendingKey === "groups"
    ) {
      sawUser = true;
      user.groups = null;
      stack.push({
        kind: "strings",
        target: "groups",
        values: [],
        bytes: 0,
        invalid: false,
        overBudget: false,
      });
    } else {
      invalidatePending();
      stack.push({ kind: "skip" });
    }
    pendingKey = undefined;
    capture = undefined;
  };

  const finishList = (frame: StringList): void => {
    if (frame.overBudget) budgetOmitted = true;
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
        } else if (capture === "string" && text.length <= LIST_TEXT_BUDGET) {
          const room = LIST_TEXT_BUDGET + 1 - text.length;
          text += token.value.slice(0, room);
          if (text.length > LIST_TEXT_BUDGET) stringOverflow = true;
        }
        break;
      case "endString":
        if (capture === "string" && stringOverflow) {
          budgetOmitted = true;
          rejectScalar();
          const list = top();
          if (list?.kind === "strings") {
            list.invalid = true;
            list.overBudget = true;
            list.values.length = 0;
          }
        } else if (capture === "string") takeString(text);
        stringOverflow = false;
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
  const partial = (): KubernetesAuditLineParse =>
    typeof value.auditID === "string" && typeof value.stage === "string"
      ? {
          kind: "event",
          value: publish(),
          depthLimited: true,
          budgetOmitted,
        }
      : { kind: "nesting" };
  try {
    if (replayFrom === undefined) {
      let offset = 0;
      while (offset < line.length) {
        const end = Math.min(line.length, offset + step);
        try {
          feed(line.slice(offset, end));
        } catch (cause: unknown) {
          if (isHostLimitFailure(cause)) throw cause;
          if (!isTokenizerDepth(cause) || step === 1) throw cause;
          // Replay the successful prefix in slices and only the overflowed
          // slice one code unit at a time.
          return parseKubernetesAuditLine(line, 1, offset);
        }
        offset = end;
      }
    } else {
      let offset = 0;
      while (offset < replayFrom) {
        const end = Math.min(replayFrom, offset + 4096);
        feed(line.slice(offset, end));
        offset = end;
      }
      const badEnd = Math.min(line.length, replayFrom + 4096);
      for (let index = replayFrom; index < badEnd; index += 1)
        feed(line.charAt(index));
    }
    feed(none);
  } catch (cause: unknown) {
    if (isHostLimitFailure(cause)) throw cause;
    if (!isTokenizerDepth(cause)) return { kind: "syntax" };
    return partial();
  }
  return {
    kind: "event",
    value: publish(),
    depthLimited: false,
    budgetOmitted,
  };
};
