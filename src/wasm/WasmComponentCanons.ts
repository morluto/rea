import type { GatedFeature } from "../domain/wasm/wasmComponent.js";
import type {
  CanonKind,
  ComponentCanon,
} from "../domain/wasm/wasmComponentTypes.js";
import type { WasmComponentReader } from "./WasmComponentReader.js";
import type { TypeDecodeContext } from "./WasmComponentTypeContext.js";
import { decodeValType } from "./WasmComponentTypes.js";
import { decodeCoreValType } from "./WasmCoreTypes.js";

type CanonOption = NonNullable<ComponentCanon["options"]>[number];
type CanonFields = Omit<ComponentCanon, "range" | "kind" | "defines">;

const STRING_ENCODINGS = ["utf8", "utf16", "latin1+utf16"] as const;

const decodeCanonOption = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): CanonOption => {
  const at = reader.offset;
  const option = reader.byte("canonical option");
  const encoding = STRING_ENCODINGS[option];
  if (encoding !== undefined) return { kind: "string-encoding", encoding };
  switch (option) {
    case 0x03:
      return { kind: "memory", core_memory: reader.u32("memory") };
    case 0x04:
      return { kind: "realloc", core_func: reader.u32("realloc") };
    case 0x05:
      return { kind: "post-return", core_func: reader.u32("post-return") };
    case 0x06:
      context.features.add("async");
      return { kind: "async" };
    case 0x07:
      context.features.add("async");
      return { kind: "callback", core_func: reader.u32("callback") };
    default:
      throw reader.unsupported(
        `Unknown canonical option 0x${option.toString(16)}`,
        at,
      );
  }
};

/** `opts`, kept in source order so duplicates remain visible. */
const decodeCanonOptions = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): CanonOption[] => {
  const options: CanonOption[] = [];
  const count = reader.count("canonical options");
  for (let index = 0; index < count; index += 1)
    options.push(decodeCanonOption(reader, context));
  return options;
};

const flag = (reader: WasmComponentReader, context: string): boolean => {
  const at = reader.offset;
  const value = reader.byte(context);
  if (value > 1) throw reader.malformed(`Invalid ${context} flag`, at);
  return value === 1;
};

const reservedZero = (reader: WasmComponentReader, context: string): void => {
  const at = reader.offset;
  if (reader.byte(context) !== 0x00)
    throw reader.unsupported(`Unknown ${context} immediate`, at);
};

/** Built-ins with no immediates, keyed by opcode, and the gate each belongs to. */
const NULLARY_CANONS = new Map<number, [CanonKind, GatedFeature]>([
  [0x24, ["backpressure.inc", "async"]],
  [0x25, ["backpressure.dec", "async"]],
  [0x05, ["task.cancel", "async"]],
  [0x0d, ["subtask.drop", "async"]],
  [0x1e, ["error-context.drop", "error-context"]],
  [0x1f, ["waitable-set.new", "async"]],
  [0x22, ["waitable-set.drop", "async"]],
  [0x23, ["waitable.join", "async"]],
  [0x26, ["thread.index", "threads"]],
  [0x28, ["thread.resume-later", "threads"]],
]);
/** Built-ins with one vestigial `0x00` immediate. */
const THREAD_SWITCH_CANONS = new Map<number, [CanonKind, GatedFeature]>([
  [0x29, ["thread.suspend", "threads"]],
  [0x0c, ["thread.yield", "async"]],
  [0x2a, ["thread.suspend-then-resume", "threads"]],
  [0x2b, ["thread.yield-then-resume", "threads"]],
  [0x2c, ["thread.suspend-then-promote", "threads"]],
  [0x2d, ["thread.yield-then-promote", "threads"]],
]);
/** Stream and future built-ins sharing a type operand, by opcode. */
const TYPED_CANONS = new Map<
  number,
  [CanonKind, "none" | "options" | "async", GatedFeature]
>([
  [0x0e, ["stream.new", "none", "async"]],
  [0x0f, ["stream.read", "options", "async"]],
  [0x10, ["stream.write", "options", "async"]],
  [0x11, ["stream.cancel-read", "async", "async"]],
  [0x12, ["stream.cancel-write", "async", "async"]],
  [0x13, ["stream.drop-readable", "none", "async"]],
  [0x14, ["stream.drop-writable", "none", "async"]],
  [0x2e, ["stream.forward", "none", "async-forward"]],
  [0x15, ["future.new", "none", "async"]],
  [0x16, ["future.read", "options", "async"]],
  [0x17, ["future.write", "options", "async"]],
  [0x18, ["future.cancel-read", "async", "async"]],
  [0x19, ["future.cancel-write", "async", "async"]],
  [0x1a, ["future.drop-readable", "none", "async"]],
  [0x1b, ["future.drop-writable", "none", "async"]],
  [0x2f, ["future.forward", "none", "async-forward"]],
]);

type CanonDecoder = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
) => readonly [CanonKind, CanonFields];

const resource =
  (kind: CanonKind): CanonDecoder =>
  (reader) => [kind, { type: reader.u32("resource type") }];

const decodeTaskReturn: CanonDecoder = (reader, context) => {
  context.features.add("async");
  const at = reader.offset;
  const kind = reader.byte("task.return result list");
  let result: ComponentCanon["result"];
  if (kind === 0x00) result = decodeValType(reader, context);
  else if (kind === 0x01 && reader.byte("empty result list") === 0x00)
    result = null;
  else throw reader.malformed("Invalid task.return result list", at);
  return [
    "task.return",
    { result, options: decodeCanonOptions(reader, context) },
  ];
};

const contextSlot =
  (kind: CanonKind): CanonDecoder =>
  (reader, context) => {
    context.features.add("async");
    return [
      kind,
      {
        value_type: decodeCoreValType(reader),
        slot: reader.u32("context slot"),
      },
    ];
  };

const errorContext =
  (kind: CanonKind): CanonDecoder =>
  (reader, context) => {
    context.features.add("error-context");
    return [kind, { options: decodeCanonOptions(reader, context) }];
  };

const waitableSet =
  (kind: CanonKind): CanonDecoder =>
  (reader, context) => {
    context.features.add("async");
    reservedZero(reader, "waitable-set");
    return [kind, { core_memory: reader.u32("waitable-set memory") }];
  };

const spawn =
  (kind: CanonKind, withTable: boolean): CanonDecoder =>
  (reader, context) => {
    context.features.add("shared-threads");
    const shared = flag(reader, "shared");
    const coreType = reader.u32("thread core type");
    return [
      kind,
      withTable
        ? {
            shared,
            core_type: coreType,
            core_table: reader.u32("thread core table"),
          }
        : { shared, core_type: coreType },
    ];
  };

/** Canonical definitions with bespoke immediates, keyed by opcode. */
const SPECIFIC_CANONS = new Map<number, CanonDecoder>([
  [
    0x00,
    (reader, context) => {
      reservedZero(reader, "canon lift sort");
      const coreFunc = reader.u32("lifted core function");
      const options = decodeCanonOptions(reader, context);
      return [
        "lift",
        { core_func: coreFunc, options, type: reader.u32("lifted type") },
      ];
    },
  ],
  [
    0x01,
    (reader, context) => {
      reservedZero(reader, "canon lower sort");
      const func = reader.u32("lowered function");
      return ["lower", { func, options: decodeCanonOptions(reader, context) }];
    },
  ],
  [0x02, resource("resource.new")],
  [0x03, resource("resource.drop")],
  [0x04, resource("resource.rep")],
  [0x09, decodeTaskReturn],
  [0x0a, contextSlot("context.get")],
  [0x0b, contextSlot("context.set")],
  [
    0x06,
    (reader, context) => {
      context.features.add("async");
      return [
        "subtask.cancel",
        { async: flag(reader, "subtask.cancel async") },
      ];
    },
  ],
  [0x1c, errorContext("error-context.new")],
  [0x1d, errorContext("error-context.debug-message")],
  [0x20, waitableSet("waitable-set.wait")],
  [0x21, waitableSet("waitable-set.poll")],
  [
    0x27,
    (reader, context) => {
      context.features.add("threads");
      return [
        "thread.new-indirect",
        {
          core_type: reader.u32("thread core type"),
          core_table: reader.u32("thread core table"),
        },
      ];
    },
  ],
  [0x40, spawn("thread.spawn-ref", false)],
  [0x41, spawn("thread.spawn-indirect", true)],
  [
    0x42,
    (reader, context) => {
      context.features.add("shared-threads");
      return [
        "thread.available-parallelism",
        { shared: flag(reader, "shared") },
      ];
    },
  ],
]);

const decodeTable = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
  opcode: number,
): readonly [CanonKind, CanonFields] | undefined => {
  const nullary = NULLARY_CANONS.get(opcode);
  if (nullary !== undefined) {
    context.features.add(nullary[1]);
    return [nullary[0], {}];
  }
  const switching = THREAD_SWITCH_CANONS.get(opcode);
  if (switching !== undefined) {
    reservedZero(reader, switching[0]);
    context.features.add(switching[1]);
    return [switching[0], {}];
  }
  const typed = TYPED_CANONS.get(opcode);
  if (typed !== undefined) {
    const [kind, immediates, feature] = typed;
    context.features.add(feature);
    if (feature === "async-forward") context.features.add("async");
    const type = reader.u32(`${kind} type`);
    if (immediates === "options")
      return [kind, { type, options: decodeCanonOptions(reader, context) }];
    if (immediates === "async")
      return [kind, { type, async: flag(reader, `${kind} async`) }];
    return [kind, { type }];
  }
  return SPECIFIC_CANONS.get(opcode)?.(reader, context);
};

/** One `canon` definition; lifts define a func, everything else a core func. */
export const decodeCanon = (
  reader: WasmComponentReader,
  context: TypeDecodeContext,
): ComponentCanon => {
  const start = reader.offset;
  const opcode = reader.byte("canonical definition");
  const decoded = decodeTable(reader, context, opcode);
  if (decoded === undefined)
    throw reader.unsupported(
      `Unknown canonical definition 0x${opcode.toString(16)}`,
      start,
    );
  const [kind, fields] = decoded;
  return {
    range: { start, end: reader.offset },
    kind,
    ...fields,
    defines: { sort: kind === "lift" ? "func" : "core func", index: null },
  };
};
