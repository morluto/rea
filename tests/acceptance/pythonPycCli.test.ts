import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { pythonPycSchema } from "../../src/domain/python/pythonPyc.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { pythonPycEqualityGolden } from "../fixtures/python-pyc-equality/golden.js";

const completePycEvidenceSchema = toolContract(
  "inspect_python_pyc",
).outputSchema.safeExtend({ normalized_result: pythonPycSchema });

cliTest(
  "preserves CPython code-member identity in public Evidence",
  async ({ cli }) => {
    const golden = pythonPycEqualityGolden;
    const directory = await createTestTempDirectory("rea-pyc-code-equality-");
    const path = join(directory, "equality.pyc");
    await writeFile(path, Buffer.from(golden.pyc_base64, "base64"));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = completePycEvidenceSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.artifact).toMatchObject({ path, sha256: golden.sha256 });
    expect(report.header).toMatchObject({
      python_version: "3.12",
      code_layout: "py311",
    });
    expect(report.code_objects[0]?.consts).toEqual(
      golden.cases.map((sample) => ({
        kind: "frozenset",
        length: sample.members,
      })),
    );
    expect(report.code_objects).toHaveLength(golden.code_objects);
    expect(report.coverage.status).toBe("complete");
  },
);

cliTest(
  "preserves the check-source bit and discloses when it is inactive",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-pyc-header-flags-");
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected file MCP session");

    for (const flags of [0x02, 0x03]) {
      const hashBased = flags === 0x03;
      const path = join(directory, `flags-${flags}.pyc`);
      await writeFile(
        path,
        pythonPycFixture("py311", {
          header: {
            flags,
            mtime: 7,
            sourceSize: 11,
            sourceHash: Buffer.from("0102030405060708", "hex"),
          },
        }),
      );

      const response = await cli.run({
        arguments: ["inspect-python-pyc", path, "--json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const report = completePycEvidenceSchema.parse(
        response.json,
      ).normalized_result;
      expect(report.header).toMatchObject({
        flags,
        check_source: true,
        hash_based: hashBased,
        source_hash_hex: hashBased ? "0102030405060708" : null,
        source_mtime: hashBased ? null : 7,
        source_size: hashBased ? null : 11,
      });
      expect(
        report.limitations.some((note) =>
          note.includes(
            "check_source bit is set but applies only to hash-based",
          ),
        ),
      ).toBe(!hashBased);

      const mcp = await call("inspect_python_pyc", { path });
      expect(mcp.isError).not.toBe(true);
      expect(
        completePycEvidenceSchema.parse(mcp.structuredContent)
          .normalized_result,
      ).toEqual(report);
    }
  },
);

const marshalUtf8 = (bytes: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([Buffer.from([0x75]), length, bytes]);
};

const marshalInt64 = (value: bigint): Buffer => {
  const payload = Buffer.alloc(8);
  payload.writeBigInt64LE(value);
  return Buffer.concat([Buffer.from([0x49]), payload]);
};

cliTest(
  "retains distinct Python 3.13 code objects after STORE_SLICE",
  async ({ cli }) => {
    // CPython 3.13.17 marshal output: a module with a frozenset of two
    // compiler-produced functions differing only in the LOAD_FAST operand
    // immediately after STORE_SLICE. CPython retains both through round-trip.
    const pyc = Buffer.from(
      "8w0NCgAAAAAAAAAAAAAAAOMAAAAAAAAAAAAAAAABAAAAAAAAAPMEAAAAlQBnACkCTj4CAAAA4wIAAAAAAAAAAAAAAAQAAAADAAAA8w4AAACVAFgQUwFTAiYAVQAkACkDTukBAAAA6QIAAACpACkC2gFh2gFicwIAAAAgINoKZml4dHVyZS5wedoBZnIKAAAAAQAAAHMQAAAAgADYDQ6AYYgBgEbYCwyASPMAAAAA4wIAAAAAAAAAAAAAAAQAAAADAAAA8w4AAACVAFgQUwFTAiYAVQEkACkDTnIEAAAAcgUAAAByBgAAACkCcgcAAAByCAAAAHMCAAAAICByCQAAAHIKAAAAcgoAAAABAAAAcxAAAACAANgNDoBhiAGARtgLDIBIcgsAAAByBgAAAHIGAAAAcgsAAAByCQAAANoIPG1vZHVsZT5yDgAAAAEAAABzCAAAAPADAQEB2AAEcgsAAAA=",
      "base64",
    );
    const root = await createTestTempDirectory("rea-python-pyc-store-slice-");
    const path = join(root, "code-set.pyc");
    await writeFile(path, pyc);
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePycEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.code_objects).toHaveLength(3);
    expect(evidence.normalized_result.code_objects[0]).toMatchObject({
      consts: [{ kind: "none" }, { kind: "frozenset", length: 2 }],
      nested_code: [1, 2],
    });
    expect(evidence.normalized_result.artifact.sha256).toBe(
      createHash("sha256").update(pyc).digest("hex"),
    );
  },
);

cliTest.for([
  {
    version: "3.14.4",
    pythonVersion: "3.14",
    magic: 3627,
    moduleConsts: [
      { kind: "code", name: "f", firstlineno: 1 },
      { kind: "none" },
      { kind: "frozenset", length: 2 },
    ],
    encoded:
      "Kw4NCgAAAAAAAAAAHwAAAOMAAAAAAAAAAAAAAAABAAAAAAAAAPMMAAAAgABSABcAdABSASMAKQNjAQAAAAAAAAAAAAAAAgAAAAMAAADzFAAAAIAAVgBSACwaAAAAAAAAAAAAACMAKQE66QEAAADpCgAAAOkCAAAAqQApAdoBYXMBAAAAJtoKZml4dHVyZS5wedoBZnIJAAAAAQAAAHMMAAAAgADYCwyIVo050AQU8wAAAABOPgIAAADjAgAAAAAAAAAAAAAAAgAAAAMAAADzHgAAAIAAVgBQAAAAAAAAAAAAAAAAAAAAAAAAAFYAMwIjAKkBTqkB2gF4qQJyBwAAANoBYnMCAAAAJiZyCAAAANoIPGxhbWJkYT5yEgAAAAEAAABzDAAAAIAAsAG3A7EDsFGpeHIKAAAA4wIAAAAAAAAAAAAAAAIAAAADAAAA8x4AAACAAFYAUAAAAAAAAAAAAAAAAAAAAAAAAABWATMCIwByDQAAAHIOAAAAchAAAABzAgAAACYmcggAAAByEgAAAHISAAAAAQAAAHMMAAAAgACQcZdzkXOYQZFocgoAAAApAXIJAAAAcgYAAAByCgAAAHIIAAAA2gg8bW9kdWxlPnIVAAAAAQAAAHMKAAAA8AMBAQH0AgEBFXIKAAAA",
  },
  {
    version: "3.15.0b3",
    pythonVersion: "3.15",
    magic: 3666,
    // 3.15 loads None through LOAD_COMMON_CONSTANT, so it is not a constant.
    moduleConsts: [
      { kind: "code", name: "f", firstlineno: 1 },
      { kind: "frozenset", length: 2 },
    ],
    encoded:
      "Ug4NCgAAAAAAAAAAHwAAAOMAAAAAAAAAAAAAAAABAAAAAAAAAPMOAAAAgAAAAFEAFQBzAFAHIQApAmMBAAAAAAAAAAAAAAACAAAAAwAAAPMWAAAAgAAAAFUAUQAqGgAAAAAAAAAAAAAhACkBOukBAAAA6QoAAADpAgAAAKkAKQHaAWFzAQAAACbaCmZpeHR1cmUucHnaAWZyCQAAAAEAAABzDAAAAIEA2AsMiFaNOdAEFPMAAAAAPgIAAADjAgAAAAAAAAAAAAAAAgAAAAMAAADzIAAAAIAAAABVAE8AAAAAAAAAAAAAAAAAAAAAAAAAVQAxAiEAKQFOKQHaAXgpAnIHAAAA2gFicwIAAAAmJnIIAAAA2gg8bGFtYmRhPnIPAAAAAQAAAHMMAAAAgQCIYY9jiWOQMYlYcgoAAADjAgAAAAAAAAAAAAAAAgAAAAMAAADzIAAAAIAAAABVAE8AAAAAAAAAAAAAAAAAAAAAAAAAVQExAiEAKQFOKQFyDQAAACkCcgcAAAByDgAAAHMCAAAAJiZyCAAAAHIPAAAAcg8AAAABAAAAcwwAAACBAIhhj2OJY5AxiVhyCgAAACkBcgkAAAByBgAAAHIKAAAAcggAAADaCDxtb2R1bGU+chIAAAABAAAAcwoAAADxAwEBAfQCAQEVcgoAAAA=",
  },
])(
  "reads CPython $version output with a slice constant and distinct lambdas",
  async ({ version, pythonVersion, magic, moduleConsts, encoded }, { cli }) => {
    // CPython marshal output of `def f(a): return a[1:10:2]` plus a frozenset
    // of two same-line lambdas, `(a.x, b)` and `(a.x, a)`, whose bytecode
    // differs only in the LOAD_FAST_BORROW operand after LOAD_ATTR's caches.
    const pyc = Buffer.from(encoded, "base64");
    const root = await createTestTempDirectory("rea-python-pyc-slice-");
    const path = join(root, `slice-${version}.pyc`);
    await writeFile(path, pyc);
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePycEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.header).toMatchObject({
      magic,
      python_version: pythonVersion,
      code_layout: "py311",
    });
    expect(evidence.normalized_result.code_objects).toHaveLength(4);
    expect(evidence.normalized_result.code_objects[0]).toMatchObject({
      consts: moduleConsts,
      nested_code: [1, 2, 3],
    });
    expect(evidence.normalized_result.code_objects[1]).toMatchObject({
      name: "f",
      consts: [{ kind: "slice" }],
    });
    expect(evidence.normalized_result.code_objects[2]?.name).toBe("<lambda>");
    expect(evidence.normalized_result.code_objects[3]?.name).toBe("<lambda>");
  },
);

cliTest("reads a CPython 3.15 magic 3666 stdlib pyc", async ({ cli }) => {
  // `encodings/__pycache__/utf_8.cpython-315.pyc`, byte for byte as shipped in
  // python-build-standalone cpython-3.15.2+20261026-aarch64-apple-darwin
  // (install_only tarball, SHA-256 285a6b92...e64a6): the header carries magic 3666.
  // The expected rows are what CPython 3.15.0b3 (magic 3666) reports for
  // these bytes through its own `marshal.loads` (qualname, first line,
  // SHA-256 of `co_code`), so they are not derived from this reader.
  const pyc = Buffer.from(
    "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",
    "base64",
  );
  const root = await createTestTempDirectory("rea-python-pyc-final-315-");
  const path = join(root, "utf_8.cpython-315.pyc");
  await writeFile(path, pyc);
  const result = await cli.run({
    arguments: ["inspect-python-pyc", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = completePycEvidenceSchema.parse(result.json);
  expect(evidence.normalized_result.header).toMatchObject({
    magic: 3666,
    python_version: "3.15",
    code_layout: "py311",
    flags: 0,
    hash_based: false,
  });
  expect(
    evidence.normalized_result.code_objects.map((code) => [
      code.qualname,
      code.firstlineno,
      code.bytecode.sha256,
    ]),
  ).toEqual([
    [
      "<module>",
      1,
      "dec009b8d182273295bb1af2572eaf510c5a2c9b79c9ed5b5867acd3ab3f3532",
    ],
    [
      "decode",
      15,
      "fe1a50cda8d8510aee7c6c8a4300c4fb151a360ba9e830b7ac9bd797d4b522f6",
    ],
    [
      "IncrementalEncoder",
      18,
      "32afcda5f0c08dccd01a0e42c4a2b5575247c8ed5723bc704db2dd995511c73b",
    ],
    [
      "IncrementalEncoder.encode",
      19,
      "df5053d342e0600648ddbd48ec64a5f1c4336c6956cde360b8799c61da5d93fe",
    ],
    [
      "IncrementalDecoder",
      22,
      "2d2cf7a62ece3c133ac82e9d59fee2ecfd21eb1a79c31b7d4a6e64a30fc2072d",
    ],
    [
      "StreamWriter",
      25,
      "b77dff0cd7cf304af6ae747b34e03499353b914282cb7d782ec4d8e24e442c67",
    ],
    [
      "StreamReader",
      28,
      "0b21e2f77e98d3f01c2698ed2b9cff5778331afb1a8bdc12b3eb80c389d36861",
    ],
    [
      "getregentry",
      33,
      "98cecbb09af6594440e3caab695700c9ca4d5a1355a3e8a83e2172dd8a9fc6a5",
    ],
  ]);
  expect(evidence.normalized_result.artifact.sha256).toBe(
    createHash("sha256").update(pyc).digest("hex"),
  );
});

cliTest(
  "classifies unsupported 3.7 alpha headers without labeling their marshal data malformed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-alpha-header-");
    const marshal = Buffer.from(
      "e3000000000000000000000000010000004000000073040000006400530029014ea900720100000072010000007201000000fa066d6f642e7079da083c6d6f64756c653e010000007300000000",
      "hex",
    );
    expect(marshal).toHaveLength(77);
    const path = join(root, "3390.pyc");
    const header = Buffer.from("3e0d0d0a0000000000000000", "hex");
    await writeFile(path, Buffer.concat([header, marshal]));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
    });
    expect(JSON.stringify(result.json)).toContain(
      "unsupported 12-byte CPython header",
    );
    expect(result.json).not.toHaveProperty("normalized_result");
  },
);

cliTest(
  "preserves negative CPython first line numbers through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-lines-");
    const path = join(root, "sample.pyc");
    const nested = marshalCode("py311", {
      name: "inner",
      firstlineno: -7,
    });
    const bytes = Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        firstlineno: -1,
        consts: [nested],
      }),
    ]);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePycEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.code_objects[0]?.firstlineno).toBe(-1);
    expect(evidence.normalized_result.code_objects[1]?.firstlineno).toBe(-7);
    expect(evidence.normalized_result.code_objects[0]?.consts).toContainEqual({
      kind: "code",
      name: "inner",
      firstlineno: -7,
    });
  },
);

cliTest(
  "matches CPython reference slots for singleton and reference tags",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-ref-slots-");
    const cases = [
      {
        name: "flagged-none",
        consts: "2903cefa01787200000000",
        expected: [
          { kind: "none" },
          { kind: "str", value: "x" },
          { kind: "str", value: "x" },
        ],
      },
      {
        name: "flagged-ref",
        consts: "2904fa0161f200000000fa01627201000000",
        expected: [
          { kind: "str", value: "a" },
          { kind: "str", value: "a" },
          { kind: "str", value: "b" },
          { kind: "str", value: "b" },
        ],
      },
    ];
    for (const testCase of cases) {
      const path = join(root, `${testCase.name}.pyc`);
      await writeFile(
        path,
        Buffer.concat([
          pythonPycHeader(3531),
          marshalCode("py311", {
            constsObject: Buffer.from(testCase.consts, "hex"),
          }),
        ]),
      );
      const result = await cli.run({
        arguments: ["inspect-python-pyc", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = completePycEvidenceSchema.parse(result.json);
      expect(evidence.normalized_result.code_objects[0]?.consts).toMatchObject(
        testCase.expected,
      );
    }
  },
);

cliTest(
  "uses constructor-normalized legacy flags for code keys and preserves raw flags",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-python-pyc-effective-flags-",
    );
    const cases = [
      {
        name: "py37-empty-tables",
        magic: 3394,
        layout: "py37" as const,
        freevars: [],
        cellvars: [],
        lengths: [1, 1],
      },
      {
        name: "py310-nonempty-tables",
        magic: 3439,
        layout: "py38" as const,
        freevars: ["capture"],
        cellvars: [],
        lengths: [1, 1],
      },
      {
        name: "py311-raw-flags",
        magic: 3531,
        layout: "py311" as const,
        freevars: [],
        cellvars: [],
        lengths: [2, 2],
      },
    ];
    for (const testCase of cases) {
      const code = (flags: number) =>
        marshalCode(testCase.layout, {
          name: "f",
          filename: "fixture.py",
          firstlineno: 1,
          flags,
          freevars: testCase.freevars,
          cellvars: testCase.cellvars,
        });
      const first = code(0);
      const second = code(0x40);
      const frozenSet = Buffer.concat([
        Buffer.from([0x3e]),
        Buffer.from([2, 0, 0, 0]),
        first,
        second,
      ]);
      const dict = Buffer.concat([
        Buffer.from([0x7b]),
        first,
        Buffer.from([0x4e]),
        second,
        Buffer.from([0x54, 0x30]),
      ]);
      const path = join(root, `${testCase.name}.pyc`);
      await writeFile(
        path,
        Buffer.concat([
          pythonPycHeader(testCase.magic),
          marshalCode(testCase.layout, { consts: [frozenSet, dict] }),
        ]),
      );
      const result = await cli.run({
        arguments: ["inspect-python-pyc", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = completePycEvidenceSchema.parse(result.json);
      expect(
        evidence.normalized_result.code_objects[0]?.consts.map((value) =>
          value.kind === "frozenset" || value.kind === "dict"
            ? value.length
            : null,
        ),
      ).toEqual(testCase.lengths);
      expect(
        evidence.normalized_result.code_objects
          .filter((object) => object.name === "f")
          .map((object) => object.flags),
      ).toContain(0);

      const rawPath = join(root, `raw-${testCase.name}.pyc`);
      await writeFile(
        rawPath,
        Buffer.concat([
          pythonPycHeader(testCase.magic),
          marshalCode(testCase.layout, {
            name: "f",
            flags: 0x40,
            freevars: testCase.freevars,
            cellvars: testCase.cellvars,
          }),
        ]),
      );
      const rawResult = await cli.run({
        arguments: ["inspect-python-pyc", rawPath, "--json"],
      });
      expect(rawResult.exitCode, rawResult.stderr).toBe(0);
      const rawEvidence = completePycEvidenceSchema.parse(rawResult.json);
      expect(rawEvidence.normalized_result.code_objects[0]?.flags).toBe(0x40);
    }
  },
);

cliTest(
  "resolves a relative pyc path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-rel-");
    const path = join(root, "sample.pyc");
    const bytes = Buffer.concat([
      pythonPycHeader(3394),
      marshalCode("py37", {
        flags: 0,
        consts: [
          ...[42n, -1n, -(1n << 63n), (1n << 63n) - 1n].map(marshalInt64),
          Buffer.from([0x69, 0xd6, 0xff, 0xff, 0xff]),
        ],
      }),
    ]);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-python-pyc", "sample.pyc", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePycEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.header.python_version).toBe("3.7");
    expect(evidence.subject?.local_path).toBe(path);
    expect(evidence.normalized_result.artifact).toMatchObject({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(evidence.normalized_result.code_objects[0]).toMatchObject({
      flags: 0,
      consts: [
        { kind: "int", bits: 6, value: "42" },
        { kind: "int", bits: 1, value: "-1" },
        { kind: "int", bits: 64, value: "-9223372036854775808" },
        { kind: "int", bits: 63, value: "9223372036854775807" },
        { kind: "int", bits: 6, value: "-42" },
      ],
    });
  },
);

cliTest.skipIf(process.platform === "win32")(
  "reads the file the symlink path names, not its lexical sibling",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-link-");
    const target = join(root, "target");
    await mkdir(join(target, "child"), { recursive: true });
    await writeFile(join(target, "sample.pyc"), pythonPycFixture("py37"));
    await writeFile(join(root, "sample.pyc"), pythonPycFixture("py311"));
    await symlink(join(target, "child"), join(root, "link"));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", "link/../sample.pyc", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completePycEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.header.python_version).toBe("3.7");
    expect(evidence.subject?.local_path).toBe(`${root}/link/../sample.pyc`);
  },
);

cliTest(
  "reports a known pyc header truncated after its magic",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-bad-");
    const path = join(root, "broken.pyc");
    await writeFile(path, pythonPycHeader(3531).subarray(0, 8));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_python_pyc",
        failure_kind: "malformed",
        reason: expect.stringContaining("shorter than a 16-byte CPython"),
      },
    });
    expect(result.json).not.toHaveProperty("normalized_result");
  },
);

cliTest(
  "preserves whole Unicode scalars in bounded pyc previews through CLI and MCP",
  async ({ cli }) => {
    const cases = [
      {
        input: "a" + "😀".repeat(40),
        preview: "a" + "😀".repeat(39),
        bytes: 161,
        truncated: true,
      },
      {
        input: "a" + "😀".repeat(40) + "z",
        preview: "a" + "😀".repeat(39),
        bytes: 162,
        truncated: true,
      },
      {
        input: "a" + "😀".repeat(39),
        preview: "a" + "😀".repeat(39),
        bytes: 157,
        truncated: false,
      },
      {
        input: "😀".repeat(40),
        preview: "😀".repeat(40),
        bytes: 160,
        truncated: false,
      },
      {
        input: "z".repeat(81),
        preview: "z".repeat(80),
        bytes: 81,
        truncated: true,
      },
    ];
    const prefix = "a".repeat(79);
    const scalar = Buffer.from(prefix + "𐀀z");
    const separate = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80]),
      Buffer.from("z"),
    ]);
    const consts = [
      ...cases.map(({ input }) => Buffer.from(input, "utf8")),
      scalar,
      separate,
    ].map(marshalUtf8);
    const bytes = Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", { consts }),
    ]);
    const root = await createTestTempDirectory("rea-python-pyc-preview-");
    const path = join(root, "unicode.pyc");
    await writeFile(path, bytes);
    const response = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const report = completePycEvidenceSchema.parse(
      response.json,
    ).normalized_result;
    expect(report.coverage.status).toBe("complete");
    expect(report.code_objects[0]?.consts).toEqual([
      ...cases.map((entry) => ({
        kind: "str",
        value: entry.preview,
        bytes: entry.bytes,
        truncated: entry.truncated,
      })),
      { kind: "str", value: prefix, bytes: 84, truncated: true },
      { kind: "str", value: prefix + "\ud800", bytes: 86, truncated: true },
    ]);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected file MCP session");
    const mcp = await call("inspect_python_pyc", { path });
    expect(mcp.isError).not.toBe(true);
    expect(
      completePycEvidenceSchema.parse(mcp.structuredContent).normalized_result,
    ).toEqual(report);
  },
);

cliTest(
  "reports the pyc parser allowance that stopped inspection",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-pyc-parser-budget-");
    const path = join(directory, "limits.pyc");
    const name = Buffer.alloc(1000, 0x61);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(name.length);
    const namesObject = Buffer.concat([
      Buffer.from([0x29, 101, 0x61 | 0x80]),
      size,
      name,
      ...Array.from({ length: 100 }, () => Buffer.from([0x72, 0, 0, 0, 0])),
    ]);
    const bytes = Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", { namesObject }),
    ]);
    await writeFile(path, bytes);

    for (const [flag, field, boundary, maximum, resource] of [
      ["--max-depth", "max_depth", "max_depth", 1, "capacity"],
      [
        "--max-file-bytes",
        "max_file_bytes",
        "reported_string_bytes",
        bytes.length,
        "memory",
      ],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-python-pyc",
          path,
          flag,
          String(maximum),
          "--json",
        ],
      });
      expect(result.exitCode).toBe(1);
      expect.soft(result.json, flag).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: { resource, reported_limits: { boundary, maximum } },
        remediation: {
          action: expect.stringContaining(
            `Raise ${field} (${flag}) above ${maximum}`,
          ),
        },
      });
    }
  },
);
