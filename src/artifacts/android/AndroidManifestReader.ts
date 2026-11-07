import type {
  AndroidManifestFacts,
  AndroidManifestReadFailure,
} from "../../domain/android/androidManifestFacts.js";
import { err, ok, type Result } from "../../domain/result.js";
import { Bytes, Stop, limit, malformed, truncated } from "./AxmlBytes.js";
import { StringPool } from "./AxmlStringPool.js";

/** Manifests larger than this are refused before any chunk is walked. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** Chunks examined in one document; bounds hostile or corrupt input. */
const MAX_CHUNKS = 1_000_000;

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const NO_INDEX = 0xffffffff;

/** `ResXMLTree_node` header size and `ResXMLTree_attrExt` fixed part. */
const NODE_HEADER_MIN = 16;
const ATTR_EXT_BYTES = 20;
const ATTRIBUTE_BYTES = 20;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";

/** Framework resource ids observed in aapt2 output (`aapt2 dump xmltree`). */
const ATTR = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  versionCodeMajor: 0x01010576,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  isFeatureSplit: 0x0101055b,
  isolatedSplits: 0x0101054b,
  targetSandboxVersion: 0x0101054c,
  isSplitRequired: 0x01010591,
} as const;

type AttrKey = keyof typeof ATTR;
const ATTR_KEY_BY_ID = new Map<number, AttrKey>(
  (Object.entries(ATTR) as [AttrKey, number][]).map(([key, id]) => [id, key]),
);

type Literal = string | number | boolean;

interface Attribute {
  readonly name: string;
  readonly namespace: string | null;
  readonly resourceId: number | null;
  readonly dataType: number;
  readonly data: number;
  readonly text: string | null;
}

interface Element {
  readonly name: string;
  readonly attributes: readonly Attribute[];
}

interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly headerSize: number;
}

interface ReadContext {
  readonly doc: Bytes;
  readonly pool: StringPool;
  readonly resourceIds: readonly number[];
}

const readAttribute = (context: ReadContext, at: number): Attribute => {
  const { doc, pool, resourceIds } = context;
  const namespaceIndex = doc.u32(at);
  const nameIndex = doc.u32(at + 4);
  if (nameIndex === NO_INDEX) throw malformed("attribute has no name");
  const dataType = doc.u8(at + 15);
  const data = doc.u32(at + 16);
  return {
    name: pool.get(nameIndex),
    namespace: namespaceIndex === NO_INDEX ? null : pool.get(namespaceIndex),
    resourceId: nameIndex < resourceIds.length ? resourceIds[nameIndex]! : null,
    dataType,
    data,
    text: dataType === TYPE_STRING ? pool.get(data) : null,
  };
};

const readElement = (
  context: ReadContext,
  chunk: Chunk,
  wantAttributes: boolean,
): Element => {
  const { doc, pool } = context;
  if (chunk.headerSize < NODE_HEADER_MIN)
    throw malformed(
      `element header size ${chunk.headerSize} is below ${NODE_HEADER_MIN}`,
    );
  const ext = chunk.start + chunk.headerSize;
  if (ext + ATTR_EXT_BYTES > chunk.end)
    throw malformed("element body exceeds its chunk");
  const name = pool.get(doc.u32(ext + 4));
  if (!wantAttributes) return { name, attributes: [] };
  const attributeStart = doc.u16(ext + 8);
  const attributeSize = doc.u16(ext + 10);
  const attributeCount = doc.u16(ext + 12);
  if (attributeStart < ATTR_EXT_BYTES || attributeSize < ATTRIBUTE_BYTES)
    throw malformed(
      `attribute layout ${attributeStart}/${attributeSize} is below the minimum`,
    );
  const first = ext + attributeStart;
  if (first + attributeCount * attributeSize > chunk.end)
    throw malformed(`${attributeCount} attributes exceed their element chunk`);
  const attributes: Attribute[] = [];
  for (let index = 0; index < attributeCount; index += 1)
    attributes.push(readAttribute(context, first + index * attributeSize));
  return { name, attributes };
};

/** `undefined` means a value that is not a supported literal (e.g. a reference). */
const literalOf = (attribute: Attribute): Literal | undefined => {
  switch (attribute.dataType) {
    case TYPE_STRING:
      return attribute.text ?? undefined;
    case TYPE_INT_DEC:
      return attribute.data | 0;
    case TYPE_INT_HEX:
      return attribute.data >>> 0;
    case TYPE_INT_BOOLEAN:
      return attribute.data !== 0;
    default:
      return undefined;
  }
};

const androidKey = (attribute: Attribute): AttrKey | null => {
  if (attribute.namespace !== ANDROID_NAMESPACE) return null;
  if (attribute.resourceId !== null)
    return ATTR_KEY_BY_ID.get(attribute.resourceId) ?? null;
  return Object.hasOwn(ATTR, attribute.name)
    ? (attribute.name as AttrKey)
    : null;
};

type Draft = {
  -readonly [K in keyof AndroidManifestFacts]: AndroidManifestFacts[K];
} & { unresolved_attributes: string[] };

interface LiteralKinds {
  readonly string: string;
  readonly number: number;
  readonly boolean: boolean;
}

/**
 * Read an attribute's literal as the type the attribute is defined to have. A
 * reference, or a literal of another type, is recorded as unresolved and
 * yields null, so "not declared" and "declared but unusable" stay distinct.
 */
const typed = <K extends keyof LiteralKinds>(
  draft: Draft,
  element: string,
  /** The recognized attribute name, not the possibly renamed raw name. */
  name: string,
  attribute: Attribute,
  kind: K,
): LiteralKinds[K] | null => {
  const value = literalOf(attribute);
  if (typeof value === kind) return value as LiteralKinds[K];
  draft.unresolved_attributes.push(`${element}@${name}`);
  return null;
};

const UNNAMESPACED_MANIFEST_FIELDS = new Map<
  string,
  "package" | "split" | "config_for_split"
>([
  ["package", "package"],
  ["split", "split"],
  ["configForSplit", "config_for_split"],
]);

const collectManifest = (
  draft: Draft,
  attributes: readonly Attribute[],
): void => {
  for (const attribute of attributes) {
    if (attribute.namespace === null) {
      const field = UNNAMESPACED_MANIFEST_FIELDS.get(attribute.name);
      if (field !== undefined)
        draft[field] = typed(
          draft,
          "manifest",
          attribute.name,
          attribute,
          "string",
        );
      continue;
    }
    const key = androidKey(attribute);
    switch (key) {
      case "versionCode":
        draft.version_code = typed(draft, "manifest", key, attribute, "number");
        break;
      case "versionCodeMajor":
        draft.version_code_major = typed(
          draft,
          "manifest",
          key,
          attribute,
          "number",
        );
        break;
      case "versionName":
        draft.version_name = typed(draft, "manifest", key, attribute, "string");
        break;
      case "isFeatureSplit":
        draft.is_feature_split = typed(
          draft,
          "manifest",
          key,
          attribute,
          "boolean",
        );
        break;
      case "isolatedSplits":
        draft.isolated_splits = typed(
          draft,
          "manifest",
          key,
          attribute,
          "boolean",
        );
        break;
      case "targetSandboxVersion":
        draft.target_sandbox_version = typed(
          draft,
          "manifest",
          key,
          attribute,
          "number",
        );
        break;
      default:
        break;
    }
  }
};

const collectUsesSdk = (
  draft: Draft,
  attributes: readonly Attribute[],
): void => {
  for (const attribute of attributes) {
    const key = androidKey(attribute);
    if (key === "minSdkVersion")
      draft.min_sdk_version = typed(
        draft,
        "uses-sdk",
        key,
        attribute,
        "number",
      );
    else if (key === "targetSdkVersion")
      draft.target_sdk_version = typed(
        draft,
        "uses-sdk",
        key,
        attribute,
        "number",
      );
  }
};

const collectApplication = (
  draft: Draft,
  attributes: readonly Attribute[],
): void => {
  for (const attribute of attributes)
    if (androidKey(attribute) === "isSplitRequired")
      draft.is_split_required = typed(
        draft,
        "application",
        "isSplitRequired",
        attribute,
        "boolean",
      );
};

const emptyDraft = (): Draft => ({
  package: null,
  version_code: null,
  version_code_major: null,
  version_name: null,
  split: null,
  config_for_split: null,
  is_feature_split: null,
  isolated_splits: null,
  target_sandbox_version: null,
  is_split_required: null,
  min_sdk_version: null,
  target_sdk_version: null,
  unresolved_attributes: [],
});

interface WalkState {
  pool: StringPool | undefined;
  resourceIds: readonly number[];
  readonly open: string[];
  readonly draft: Draft;
  sawManifest: boolean;
}

const handleStartElement = (
  doc: Bytes,
  chunk: Chunk,
  state: WalkState,
): void => {
  if (state.pool === undefined)
    throw malformed("element precedes the string pool");
  if (state.open.length === 0 && state.sawManifest)
    throw malformed("document has more than one root element");
  const depth = state.open.length;
  const element = readElement(
    { doc, pool: state.pool, resourceIds: state.resourceIds },
    chunk,
    depth <= 1,
  );
  state.open.push(element.name);
  if (depth === 0) {
    if (element.name !== "manifest")
      throw malformed(`root element is ${element.name}, not manifest`);
    state.sawManifest = true;
    collectManifest(state.draft, element.attributes);
  } else if (depth === 1 && element.name === "uses-sdk") {
    collectUsesSdk(state.draft, element.attributes);
  } else if (depth === 1 && element.name === "application") {
    collectApplication(state.draft, element.attributes);
  }
};

const handleEndElement = (doc: Bytes, chunk: Chunk, state: WalkState): void => {
  const ext = chunk.start + chunk.headerSize;
  if (state.pool === undefined || ext + 8 > chunk.end)
    throw malformed("end element is incomplete");
  const closed = state.pool.get(doc.u32(ext + 4));
  const expected = state.open.pop();
  if (expected === undefined)
    throw malformed(`end element ${closed} has no open element`);
  if (expected !== closed)
    throw malformed(`end element ${closed} closes ${expected}`);
};

const readResourceMap = (doc: Bytes, chunk: Chunk): readonly number[] => {
  const count = Math.floor((chunk.end - chunk.start - chunk.headerSize) / 4);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1)
    ids.push(doc.u32(chunk.start + chunk.headerSize + index * 4));
  return ids;
};

const handleChunk = (
  doc: Bytes,
  type: number,
  chunk: Chunk,
  state: WalkState,
): void => {
  if (type === RES_STRING_POOL_TYPE) {
    // One pool carries one decode budget; a second would reset it.
    if (state.pool !== undefined)
      throw malformed("document has more than one string pool");
    state.pool = StringPool.read(doc, chunk.start);
  } else if (type === RES_XML_RESOURCE_MAP_TYPE)
    state.resourceIds = readResourceMap(doc, chunk);
  else if (type === RES_XML_START_ELEMENT_TYPE)
    handleStartElement(doc, chunk, state);
  else if (type === RES_XML_END_ELEMENT_TYPE)
    handleEndElement(doc, chunk, state);
};

const walk = (doc: Bytes): AndroidManifestFacts => {
  const declared = doc.u32(4);
  if (declared > doc.length)
    throw truncated(
      `document declares ${declared} bytes but only ${doc.length} are present`,
    );
  const end = declared;
  let offset = doc.u16(2);
  if (offset < 8 || offset > end)
    throw malformed(`document header size ${offset} is invalid`);

  const state: WalkState = {
    pool: undefined,
    resourceIds: [],
    open: [],
    draft: emptyDraft(),
    sawManifest: false,
  };
  let chunks = 0;
  while (offset < end) {
    chunks += 1;
    if (chunks > MAX_CHUNKS) throw limit(`more than ${MAX_CHUNKS} chunks`);
    if (offset + 8 > end) throw truncated("chunk header exceeds document");
    const type = doc.u16(offset);
    const headerSize = doc.u16(offset + 2);
    const size = doc.u32(offset + 4);
    if (size < 8 || headerSize < 8 || headerSize > size)
      throw malformed(`chunk at ${offset} has invalid sizes`);
    if (offset + size > end)
      throw truncated(`chunk at ${offset} overruns the document`);
    handleChunk(
      doc,
      type,
      { start: offset, end: offset + size, headerSize },
      state,
    );
    offset += size;
  }
  if (!state.sawManifest) throw malformed("document has no manifest element");
  if (state.open.length > 0)
    throw malformed(
      `element ${state.open[state.open.length - 1]} is never closed`,
    );
  return state.draft;
};

/**
 * Read the facts REA needs from a compiled (binary) `AndroidManifest.xml`.
 *
 * Only `<manifest>`, its direct `<uses-sdk>` and `<application>` children are
 * interpreted. Strings are decoded lazily and every read is bounds-checked
 * against the chunk that declares it; document size, string count, decoded
 * bytes and chunk count are capped, so malformed input becomes a typed
 * failure rather than an exception or unbounded work.
 */
export const readAndroidManifest = (
  bytes: Uint8Array,
): Result<AndroidManifestFacts, AndroidManifestReadFailure> => {
  try {
    if (bytes.byteLength > MAX_MANIFEST_BYTES)
      throw limit(
        `manifest is ${bytes.byteLength} bytes, above ${MAX_MANIFEST_BYTES}`,
      );
    if (bytes.byteLength < 8)
      throw truncated("manifest is shorter than 8 bytes");
    const doc = new Bytes(bytes);
    if (doc.u16(0) !== RES_XML_TYPE)
      throw malformed(
        `document type 0x${doc.u16(0).toString(16)} is not compiled XML`,
      );
    return ok(walk(doc));
  } catch (cause) {
    if (cause instanceof Stop) return err(cause.failure);
    throw cause;
  }
};
