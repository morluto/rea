/**
 * Original component-model binaries encoded from the pinned Binary.md grammar.
 * Fixtures are built in memory; no producer output or binary file is committed.
 */

export const COMPONENT_PREAMBLE = [
  0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00,
] as const;
export const CORE_PREAMBLE = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
] as const;

/** Unsigned LEB128. */
export const u32 = (value: number): number[] => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 0x80;
    remaining = Math.floor(remaining / 0x80);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
};

export const name = (text: string): number[] => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...u32(bytes.length), ...bytes];
};

/** `vec(T)` from an array, without spreading entries into call arguments. */
export const vecOf = (items: readonly (readonly number[])[]): number[] => {
  const bytes = u32(items.length);
  for (const item of items) for (const byte of item) bytes.push(byte);
  return bytes;
};

export const vec = (...items: readonly (readonly number[])[]): number[] =>
  vecOf(items);

export const section = (id: number, payload: readonly number[]): number[] => [
  id,
  ...u32(payload.length),
  ...payload,
];

export const component = (...sections: readonly (readonly number[])[]) =>
  Uint8Array.from([...COMPONENT_PREAMBLE, ...sections.flat()]);

export const coreModule = (...sections: readonly (readonly number[])[]) => [
  ...CORE_PREAMBLE,
  ...sections.flat(),
];

/** Plain extern name (`0x00 len name`). */
export const externName = (text: string): number[] => [0x00, ...name(text)];

const STRING = 0x73;
const U32 = 0x79;
const I32 = 0x7f;
const NO_RESULT = [0x01, 0x00];

/** Core module importing `host.log` and exporting `run` and `memory`. */
export const representativeCoreModule = (): number[] =>
  coreModule(
    section(1, vec([0x60, ...vec([I32], [I32]), ...vec()])),
    section(2, vec([...name("host"), ...name("log"), 0x00, ...u32(0)])),
    section(
      7,
      vec([...name("run"), 0x00, ...u32(1)], [...name("memory"), 0x02, 0x00]),
    ),
  );

/**
 * A component that lowers an imported `log` into its core module, lifts the
 * core `run` export, imports a WASI-style instance with a resource method,
 * and names its functions.
 */
export const representativeComponent = (): Uint8Array =>
  component(
    // type 0: (func (param "msg" string))
    section(7, vec([0x40, ...vec([...name("msg"), STRING]), ...NO_RESULT])),
    // import "log" (func (type 0)) -> func 0
    section(10, vec([...externName("log"), 0x01, ...u32(0)])),
    // core module 0
    section(1, representativeCoreModule()),
    // canon lower (func 0) (string-encoding=utf8) -> core func 0
    section(8, vec([0x01, 0x00, ...u32(0), ...vec([0x00])])),
    // core instance 0 exports "log" -> core func 0; core instance 1 instantiates module 0 with "host"
    section(
      2,
      vec(
        [0x01, ...vec([...name("log"), 0x00, ...u32(0)])],
        [0x00, ...u32(0), ...vec([...name("host"), 0x12, ...u32(0)])],
      ),
    ),
    // alias core export 1 "run" (core func) -> core func 1; "memory" -> core memory 0
    section(
      6,
      vec(
        [0x00, 0x00, 0x01, ...u32(1), ...name("run")],
        [0x00, 0x02, 0x01, ...u32(1), ...name("memory")],
      ),
    ),
    // type 1: (func (result u32)); type 2: WASI-style instance with a resource method
    section(
      7,
      vec(
        [0x40, ...vec(), 0x00, U32],
        [
          0x42,
          ...vec(
            [0x04, ...externName("file"), 0x03, 0x01],
            [0x01, 0x68, ...u32(0)],
            [0x01, 0x40, ...vec([...name("self"), ...u32(1)]), 0x00, STRING],
            [0x04, ...externName("[method]file.name"), 0x01, ...u32(2)],
          ),
        ],
      ),
    ),
    // canon lift (core func 1) (type 1) -> func 1
    section(8, vec([0x00, 0x00, ...u32(1), ...vec(), ...u32(1)])),
    // import "wasi:fs/types@0.2.0" (instance (type 2)) -> instance 0
    section(10, vec([...externName("wasi:fs/types@0.2.0"), 0x05, ...u32(2)])),
    // alias export instance 0 "[method]file.name" (func) -> func 2
    section(6, vec([0x01, 0x00, ...u32(0), ...name("[method]file.name")])),
    // canon lower (func 2) (memory 0) (string-encoding=utf8) -> core func 2
    section(8, vec([0x01, 0x00, ...u32(2), ...vec([0x03, ...u32(0)], [0x00])])),
    // export "run" (func 1) -> func 3
    section(11, vec([...externName("run"), 0x01, ...u32(1), 0x00])),
    section(0, [
      ...name("component-name"),
      ...section(0, name("demo")),
      ...section(1, [
        0x01,
        ...vec([...u32(0), ...name("log")], [...u32(1), ...name("run")]),
      ]),
    ]),
  );

/** Gated async, map, fixed-size list, error-context and attribute encodings. */
export const gatedFeatureComponent = (): Uint8Array =>
  component(
    section(
      7,
      vec(
        // type 0: (stream u8)
        [0x66, 0x01, 0x7d],
        // type 1: (map string u32)
        [0x63, STRING, U32],
        // type 2: (list u8 4)
        [0x67, 0x7d, ...u32(4)],
        // type 3: (func async (param "s" 0) (result error-context))
        [0x43, ...vec([...name("s"), ...u32(0)]), 0x00, 0x64],
      ),
    ),
    // import "wasi:io/streams" with version suffix "-rc1" (func (type 3))
    section(
      10,
      vec([
        0x02,
        ...name("wasi:io/streams@0.3.0"),
        ...vec([0x01, ...name("-rc1")]),
        0x01,
        ...u32(3),
      ]),
    ),
    // canon task.return (result u32) (async) and stream.new (type 0)
    section(8, vec([0x09, 0x00, U32, ...vec([0x06])], [0x0e, ...u32(0)])),
  );

/** Nest `inner` in `depth` enclosing components. */
export const nestedComponent = (
  depth: number,
  inner: Uint8Array,
): Uint8Array => {
  let current = inner;
  for (let level = 0; level < depth; level += 1)
    current = component(section(4, [...current]));
  return current;
};

/** Replace the version and layer of a component preamble. */
export const withPreamble = (
  bytes: Uint8Array,
  version: number,
  layer: number,
): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[4] = version;
  copy[5] = 0;
  copy[6] = layer;
  copy[7] = 0;
  return copy;
};
