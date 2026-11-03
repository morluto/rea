import { describe, expect, it } from "vitest";
import {
  WASM_MODULE_LIMITS,
  WasmModuleFailure,
  readInitialLinearMemory,
  readWasmModuleImage,
} from "./WasmModuleImage.js";

const u32 = (value: number): number[] => {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
};
const i32 = (value: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done =
      (value === 0 && (byte & 0x40) === 0) ||
      (value === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
};
const name = (text: string) => [...u32(text.length), ...Buffer.from(text)];
const vec = (items: number[][]) => [...u32(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [
  id,
  ...u32(body.length),
  ...body,
];
const offset = (value: number) => [0x41, ...i32(value), 0x0b];
const module = (...sections: number[][]) =>
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat()]);

const importFunction = (field: string) => [
  ...name("env"),
  ...name(field),
  0x00,
  0x00,
];
const importMemory = (min: number) => [
  ...name("env"),
  ...name("memory"),
  0x02,
  0x00,
  ...u32(min),
];
const functions = (count: number) => section(3, vec(Array(count).fill([0])));
const table = section(4, vec([[0x70, 0x00, 4]]));
const memory = (min: number, max?: number) =>
  section(
    5,
    vec([
      max === undefined
        ? [0x00, ...u32(min)]
        : [0x01, ...u32(min), ...u32(max)],
    ]),
  );
const elements = (base: number, indices: number[]) =>
  section(9, vec([[0x00, ...offset(base), ...vec(indices.map(u32))]]));
const data = (...segments: [number, number[]][]) =>
  section(
    11,
    vec(
      segments.map(([at, bytes]) => [
        0x00,
        ...offset(at),
        ...vec(bytes.map((b) => [b])),
      ]),
    ),
  );

const failure = (bytes: Buffer): [string, string] => {
  try {
    readWasmModuleImage(bytes);
  } catch (cause) {
    if (cause instanceof WasmModuleFailure) return [cause.kind, cause.message];
    throw cause;
  }
  throw new Error("module was accepted");
};

describe("readWasmModuleImage", () => {
  it("reads imports, table slots and data segments", () => {
    const bytes = module(
      section(2, vec([importFunction("a"), importFunction("b")])),
      functions(3),
      table,
      memory(1, 2),
      elements(1, [4, 0, 2]),
      data([16, [1, 2]], [24, [3]]),
    );
    const copy = Buffer.from(bytes);
    const image = readWasmModuleImage(bytes);
    expect(image.importedFunctionCount).toBe(2);
    expect(image.functionCount).toBe(5);
    expect(image.memory).toEqual({
      initialPages: 1,
      maximumPages: 2,
      imported: false,
    });
    expect([...image.table]).toEqual([
      [1, 4],
      [2, 0],
      [3, 2],
    ]);
    expect(image.dataSegments.map((s) => [s.offset, [...s.bytes]])).toEqual([
      [16, [1, 2]],
      [24, [3]],
    ]);
    expect(image.dataSegments[0]!.bytes.buffer).toBe(bytes.buffer);
    expect(bytes.equals(copy)).toBe(true);
  });

  it("reports an imported memory", () => {
    const image = readWasmModuleImage(
      module(section(2, vec([importMemory(1)])), data([0, [9]])),
    );
    expect(image.memory).toEqual({
      initialPages: 1,
      maximumPages: null,
      imported: true,
    });
  });

  it.each([
    ["passive data", section(11, vec([[0x01, ...vec([[7]])]]))],
    [
      "explicit memory data",
      section(11, vec([[0x02, 0x00, ...offset(0), 0x00]])),
    ],
    ...[1, 2, 3, 4, 5, 6, 7].map(
      (flags) =>
        [`element flags ${flags}`, section(9, vec([[flags]]))] as const,
    ),
    ["global.get offset", section(11, vec([[0x00, 0x23, 0x00, 0x0b, 0x00]]))],
    [
      "extended const offset",
      section(11, vec([[0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b, 0x00]])),
    ],
    ["shared memory", section(5, vec([[0x03, 1, 1]]))],
    ["memory64", section(5, vec([[0x04, 1]]))],
    ["custom page size", section(5, vec([[0x08, 1]]))],
    [
      "tag import",
      section(2, vec([[...name("env"), ...name("t"), 0x04, 0x00, 0x00]])),
    ],
    [
      "two memories",
      section(
        5,
        vec([
          [0x00, 1],
          [0x00, 1],
        ]),
      ),
    ],
    [
      "imported and defined memory",
      [...section(2, vec([importMemory(1)])), ...memory(1)],
    ],
    [
      "two tables",
      section(
        4,
        vec([
          [0x70, 0x00, 1],
          [0x70, 0x00, 1],
        ]),
      ),
    ],
  ] as [string, number[]][])("refuses %s as unsupported", (_, body) => {
    expect(failure(module(body))[0]).toBe("unsupported");
  });

  it("diagnoses gzip input separately", () => {
    expect(failure(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))).toEqual([
      "unsupported",
      "module is gzip compressed; decompress the .wasm first",
    ]);
  });

  it.each([
    ["bad magic", Buffer.from([0, 0x61, 0x73, 0x6e, 1, 0, 0, 0])],
    ["version 2", Buffer.from([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])],
    ["truncated LEB128", module([3, 0x01, 0x80])],
    [
      "overlong LEB128",
      module(section(3, [0x80, 0x80, 0x80, 0x80, 0x80, 0x00])),
    ],
    ["section past the module", module([3, 0x05, 0x00])],
    [
      "segment past its section",
      module(section(11, [1, 0x00, ...offset(0), 4, 1])),
    ],
    ["segment past memory", module(memory(1), data([65535, [1, 2]]))],
    [
      "segment past imported minimum",
      module(section(2, vec([importMemory(1)])), data([65536, [1]])),
    ],
    ["data without memory", module(data([0, [1]]))],
    ["slot past function count", module(functions(1), table, elements(0, [1]))],
  ] as [string, Buffer][])("refuses %s as malformed", (_, bytes) => {
    expect(failure(bytes)[0]).toBe("malformed");
  });

  it("bounds data segment and slot counts", () => {
    const tooManyData = module(
      section(11, u32(WASM_MODULE_LIMITS.dataSegments + 1)),
    );
    expect(failure(tooManyData)[0]).toBe("capacity");
    const tooManySlots = module(
      section(9, [
        1,
        0x00,
        ...offset(0),
        ...u32(WASM_MODULE_LIMITS.tableSlots + 1),
      ]),
    );
    expect(failure(tooManySlots)[0]).toBe("capacity");
  });

  it("bounds input bytes before parsing", () => {
    const huge = { length: WASM_MODULE_LIMITS.inputBytes + 1 } as Buffer;
    huge.subarray = () => Buffer.alloc(2);
    expect(failure(huge)[0]).toBe("capacity");
  });
});

describe("readInitialLinearMemory", () => {
  it("spans lowest start to highest end with zero gaps", () => {
    const image = readWasmModuleImage(
      module(memory(1), data([16, [1, 2]], [20, [3]])),
    );
    const linear = readInitialLinearMemory(image);
    expect(linear.address).toBe(16);
    expect([...linear.bytes]).toEqual([1, 2, 0, 0, 3]);
  });

  it("lets a later overlapping segment win", () => {
    const image = readWasmModuleImage(
      module(memory(1), data([8, [1, 1, 1, 1]], [9, [2, 2]], [4, [3]])),
    );
    const linear = readInitialLinearMemory(image);
    expect(linear.address).toBe(4);
    expect([...linear.bytes]).toEqual([3, 0, 0, 0, 1, 2, 2, 1]);
  });

  it("is empty without data", () => {
    expect(readInitialLinearMemory({ dataSegments: [] }).bytes.length).toBe(0);
  });
});
