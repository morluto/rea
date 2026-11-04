import { describe, expect, it } from "vitest";
import {
  readInitialLinearMemorySteps,
  readWasmModuleImageSteps,
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
const code = (count: number) =>
  section(10, vec(Array(count).fill([2, 0, 0x0b])));
/** Adds one empty body per declared function, in section order, unless a test gives its own. */
const module = (...sections: number[][]) => {
  const declared = sections.find((part) => part[0] === 3);
  const withCode =
    declared === undefined || sections.some((part) => part[0] === 10)
      ? sections
      : (() => {
          const count = readWasmModuleImageCount(declared);
          const at = sections.findIndex((part) => part[0] === 11);
          const list = [...sections];
          list.splice(at < 0 ? list.length : at, 0, code(count));
          return list;
        })();
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...withCode.flat()]);
};
/** Function count from a function section built by `functions` (single-byte LEB sizes). */
const readWasmModuleImageCount = (part: number[]) => {
  let at = 1;
  while (part[at]! & 0x80) at++;
  let count = 0;
  let shift = 0;
  for (at++; ; at++) {
    count |= (part[at]! & 0x7f) << shift;
    shift += 7;
    if (!(part[at]! & 0x80)) return count;
  }
};

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
    // Bodies long enough for the declared counts, so only the cap refuses them.
    const dataCount = WASM_MODULE_LIMITS.dataSegments + 1;
    const tooManyData = module(
      section(11, [...u32(dataCount), ...Array<number>(dataCount).fill(0)]),
    );
    expect(failure(tooManyData)[0]).toBe("capacity");
    const slotCount = WASM_MODULE_LIMITS.tableSlots + 1;
    const tooManySlots = module(
      section(9, [
        1,
        0x00,
        ...offset(0),
        ...u32(slotCount),
        ...Array<number>(slotCount).fill(0),
      ]),
    );
    expect(failure(tooManySlots)[0]).toBe("capacity");
    // The same counts over bodies that cannot hold them are damaged sections.
    expect(failure(module(section(11, u32(dataCount))))[0]).toBe("malformed");
    expect(
      failure(
        module(section(9, [1, 0x00, ...offset(0), ...u32(slotCount)])),
      )[0],
    ).toBe("malformed");
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
    const linear = readInitialLinearMemory({
      dataSegments: image.dataSegments,
    });
    expect(linear.address).toBe(16);
    expect([...linear.bytes]).toEqual([1, 2, 0, 0, 3]);
  });

  it("lets a later overlapping segment win", () => {
    const image = readWasmModuleImage(
      module(memory(1), data([8, [1, 1, 1, 1]], [9, [2, 2]], [4, [3]])),
    );
    const linear = readInitialLinearMemory({
      dataSegments: image.dataSegments,
    });
    expect(linear.address).toBe(4);
    expect([...linear.bytes]).toEqual([3, 0, 0, 0, 1, 2, 2, 1]);
  });

  it("keeps a short zero tail, not the whole initial memory", () => {
    const image = readWasmModuleImage(module(memory(1), data([16, [1, 2]])));
    const linear = readInitialLinearMemory(image);
    expect(linear.address).toBe(16);
    // 16 + 2 + 64 rounds up to the 8-byte boundary at 88.
    expect(linear.bytes.length).toBe(88 - 16);
    expect([...linear.bytes.subarray(0, 3)]).toEqual([1, 2, 0]);
    const full = readWasmModuleImage(module(memory(1), data([65530, [1, 2]])));
    expect(readInitialLinearMemory(full).bytes.length).toBe(6);
  });

  it("is empty without data", () => {
    expect(readInitialLinearMemory({ dataSegments: [] }).bytes.length).toBe(0);
  });
});

describe("checks that keep counts unambiguous", () => {
  it("refuses unused bits in the fifth byte of an i32 offset", () => {
    const bad = section(
      11,
      vec([[0x00, 0x41, 0x80, 0x80, 0x80, 0x80, 0x70, 0x0b, ...vec([[1]])]]),
    );
    expect(failure(module(memory(1), bad))).toEqual([
      "malformed",
      "i32 has unused bits set in its fifth byte",
    ]);
  });
  it("refuses a repeated function section", () => {
    expect(failure(module(functions(1), functions(2)))[1]).toBe(
      "section 3 is repeated or out of order",
    );
  });
  it("refuses a data section before memory and an unknown section id", () => {
    expect(failure(module(data([0, [1]]), memory(1)))[1]).toBe(
      "section 5 is repeated or out of order",
    );
    expect(failure(module(section(20, [])))[1]).toBe(
      "section id 20 is unknown",
    );
  });
  it("refuses element segments past the table or without one", () => {
    expect(
      failure(module(functions(1), table, elements(2, [0, 0, 0])))[1],
    ).toBe("element segment at slot 2 ends past the 4 initial table slots");
    expect(failure(module(functions(1), elements(0, [0])))[1]).toBe(
      "element segments name a table the module does not have",
    );
  });
});

describe("code bodies and segment counts", () => {
  it("refuses declared functions without code bodies", () => {
    const bytes = Buffer.from([
      0x00,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...functions(2),
      ...code(1),
    ]);
    expect(failure(bytes)).toEqual([
      "malformed",
      "module declares 2 functions but has 1 code bodies",
    ]);
  });
  it("bounds element segment records before reading them", () => {
    const count = WASM_MODULE_LIMITS.elementSegments + 1;
    const bytes = module(
      table,
      section(9, [...u32(count), ...Array<number>(count).fill(0)]),
    );
    expect(failure(bytes)[0]).toBe("capacity");
    expect(failure(module(table, section(9, u32(count))))[0]).toBe("malformed");
  });
});

describe("count checks against the section body", () => {
  it("refuses counts one byte short of their body as malformed", () => {
    // One byte short of the declared counts is already a damaged section.
    expect(
      failure(
        module(
          section(11, [
            ...u32(WASM_MODULE_LIMITS.dataSegments + 1),
            ...Array<number>(WASM_MODULE_LIMITS.dataSegments).fill(0),
          ]),
        ),
      )[0],
    ).toBe("malformed");
    expect(
      failure(
        module(
          section(9, [
            1,
            0x00,
            ...offset(0),
            ...u32(WASM_MODULE_LIMITS.tableSlots + 1),
            ...Array<number>(WASM_MODULE_LIMITS.tableSlots).fill(0),
          ]),
        ),
      )[0],
    ).toBe("malformed");
  });
});

describe("table representation", () => {
  const bigTable = (min: number) =>
    section(4, vec([[0x70, 0x00, ...u32(min)]]));
  it("keeps a high-base segment without allocating the slots below it", () => {
    // Past the slot allowance, so a table that started at slot 0 would be refused.
    const base = WASM_MODULE_LIMITS.tableSlots * 2;
    const image = readWasmModuleImage(
      module(functions(1), bigTable(base + 1), elements(base, [0])),
    );
    expect(image.table.get(base)).toBe(0);
    expect(image.table.get(base - 1)).toBeUndefined();
    expect([...image.table]).toEqual([[base, 0]]);
  });
  it("refuses filled slots spread wider than the slot allowance as capacity", () => {
    const far = WASM_MODULE_LIMITS.tableSlots;
    const bytes = module(
      functions(1),
      bigTable(far + 1),
      section(
        9,
        vec([
          [0x00, ...offset(0), ...vec([u32(0)])],
          [0x00, ...offset(far), ...vec([u32(0)])],
        ]),
      ),
    );
    expect(failure(bytes)).toEqual([
      "capacity",
      `element segments span ${far + 1} table slots, above ${far}`,
    ]);
  });
  it("leaves a slot between two segments unfilled", () => {
    const image = readWasmModuleImage(
      module(
        functions(2),
        table,
        section(
          9,
          vec([
            [0x00, ...offset(1), ...vec([u32(0)])],
            [0x00, ...offset(3), ...vec([u32(1)])],
          ]),
        ),
      ),
    );
    expect(image.table.get(2)).toBeUndefined();
    expect([...image.table]).toEqual([
      [1, 0],
      [3, 1],
    ]);
  });
  it("accepts filled slots spread exactly as wide as the slot allowance", () => {
    const last = WASM_MODULE_LIMITS.tableSlots - 1;
    const image = readWasmModuleImage(
      module(
        functions(1),
        bigTable(last + 1),
        section(
          9,
          vec([
            [0x00, ...offset(0), ...vec([u32(0)])],
            [0x00, ...offset(last), ...vec([u32(0)])],
          ]),
        ),
      ),
    );
    expect([...image.table]).toEqual([
      [0, 0],
      [last, 0],
    ]);
  });
  it("lets a later segment overwrite an earlier one's slot", () => {
    const image = readWasmModuleImage(
      module(
        functions(2),
        table,
        section(
          9,
          vec([
            [0x00, ...offset(1), ...vec([u32(0), u32(0)])],
            [0x00, ...offset(2), ...vec([u32(1)])],
          ]),
        ),
      ),
    );
    expect([...image.table]).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});

describe("table types and yielding", () => {
  it("refuses a table whose elements are not funcref", () => {
    const externref = section(4, vec([[0x6f, 0x00, 4]]));
    expect(failure(module(externref))).toEqual([
      "unsupported",
      "table element type 0x6f is not funcref",
    ]);
  });
  it.each([
    [
      "element",
      () =>
        module(
          table,
          section(
            9,
            vec([[0x00, ...offset(0), ...vec(Array(5000).fill([0]))]]),
          ),
        ),
    ],
    [
      "code",
      () =>
        Buffer.from([
          0x00,
          0x61,
          0x73,
          0x6d,
          1,
          0,
          0,
          0,
          ...section(10, vec(Array(5000).fill([2, 0, 0x0b]))),
        ]),
    ],
    [
      "data",
      () =>
        module(
          memory(1),
          data(
            ...Array.from({ length: 5000 }, (_, i): [number, number[]] => [
              i,
              [1],
            ]),
          ),
        ),
    ],
  ] as const)("yields while reading a large %s section", (_, build) => {
    expect(readWasmModuleImageSteps(build()).next().done).toBe(false);
  });

  it("yields while reading a large function section", () => {
    const steps = readWasmModuleImageSteps(module(functions(5000)));
    expect(steps.next().done).toBe(false);
  });
});

describe("table source", () => {
  it("reports whether table 0 is imported", () => {
    const imported = section(
      2,
      vec([[...name("env"), ...name("table"), 0x01, 0x70, 0x00, 4]]),
    );
    expect(readWasmModuleImage(module(imported)).tableImported).toBe(true);
    expect(readWasmModuleImage(module(table)).tableImported).toBe(false);
  });
});

describe("import yields and sparse memory", () => {
  it("yields while reading a large import section", () => {
    const imports = section(
      2,
      vec(Array.from({ length: 5000 }, () => importFunction("f"))),
    );
    expect(readWasmModuleImageSteps(module(imports)).next().done).toBe(false);
  });
  it("bounds the zero bytes sparse segments add before allocating them", () => {
    const sparse = readWasmModuleImage(
      module(
        memory(2048),
        data([0, [1]], [WASM_MODULE_LIMITS.linearMemoryGapBytes + 16, [1]]),
      ),
    );
    expect(() =>
      readInitialLinearMemory({ dataSegments: sparse.dataSegments }),
    ).toThrow(/zero bytes in their span/u);
  });
});

describe("source and view share one allowance", () => {
  it("counts the module bytes the caller holds against the view", () => {
    const image = readWasmModuleImage(
      module(memory(1), data([0, [1, 2, 3, 4]])),
    );
    expect(() =>
      readInitialLinearMemory(
        { dataSegments: image.dataSegments },
        WASM_MODULE_LIMITS.linearMemoryBytes - 2,
      ),
    ).toThrow(/beside a .*-byte module/u);
    expect(
      readInitialLinearMemory({ dataSegments: image.dataSegments }, 0).bytes
        .length,
    ).toBe(4);
  });
});

describe("overlap and copy batching", () => {
  it("counts overlapping segments once against the zero-gap allowance", () => {
    const gap = WASM_MODULE_LIMITS.linearMemoryGapBytes;
    // Four 64-byte copies of one range: summing them would hide 192 zero bytes.
    const repeated = Array.from({ length: 4 }, (): [number, number[]] => [
      0,
      Array<number>(64).fill(1),
    ]);
    const image = readWasmModuleImage(
      module(memory(2048), data(...repeated, [gap + 100, [1]])),
    );
    expect(() =>
      readInitialLinearMemory({ dataSegments: image.dataSegments }),
    ).toThrow(/zero bytes in their span/u);
  });
  it("yields while copying a segment larger than one copy batch", () => {
    const big = Array<number>((1 << 20) + 16).fill(1);
    const image = readWasmModuleImage(module(memory(32), data([0, big])));
    const steps = readInitialLinearMemorySteps({
      dataSegments: image.dataSegments,
    });
    expect(steps.next().done).toBe(false);
  });
});

describe("zeroing the view", () => {
  it("yields while zeroing a view larger than one batch, and leaves gaps zero", () => {
    const image = readWasmModuleImage(
      module(memory(64), data([0, [1]], [(1 << 21) + 8, [2]])),
    );
    const steps = readInitialLinearMemorySteps({
      dataSegments: image.dataSegments,
    });
    // Two segments of one copy chunk each yield twice; a 2 MiB view zeroed in
    // 1 MiB chunks yields at least twice more.
    let yields = 0;
    let step = steps.next();
    while (!step.done) {
      yields++;
      step = steps.next();
    }
    expect(yields).toBeGreaterThanOrEqual(4);
    const view = step.value.bytes;
    expect(view[0]).toBe(1);
    expect(view[(1 << 21) + 8]).toBe(2);
    expect(view.subarray(1, 1 << 21).every((byte) => byte === 0)).toBe(true);
  });
});
