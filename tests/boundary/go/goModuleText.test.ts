import { expect, it } from "vitest";
import { parseGoModuleBytes } from "../../../src/go/GoModuleText.js";

it("preserves module identity and ordered settings with Go quoting", () => {
  const source = [
    "path\texample.invalid/app",
    "mod\texample.invalid/app\t(devel)\t",
    "dep\texample.invalid/lib\tv1.2.3\th1:bytes",
    "=>\t../local lib\t\t",
    "build\tGOOS=linux",
    "build\tGOOS=custom",
    "build\t__proto__=kept",
    'build\t"key=quoted"="literal路𐐷\\a\\v\\xC3\\xA9\\303\\251\\u263a\\U0001F680 end"',
    "build\traw=`a\rb`",
    "",
  ].join("\n");
  expect(parseGoModuleBytes(Buffer.from(source))).toEqual({
    path: "example.invalid/app",
    main: {
      path: "example.invalid/app",
      version: "(devel)",
      sum: "",
      replacement: null,
    },
    dependencies: [
      {
        path: "example.invalid/lib",
        version: "v1.2.3",
        sum: "h1:bytes",
        replacement: { path: "../local lib", version: "", sum: "" },
      },
    ],
    settings: [
      { key: "GOOS", value: "linux" },
      { key: "GOOS", value: "custom" },
      { key: "__proto__", value: "kept" },
      { key: "key=quoted", value: "literal路𐐷\x07\x0béé☺🚀 end" },
      { key: "raw", value: "ab" },
    ],
    complete: true,
    unparsed_lines: [],
    unparsed_line_bytes_base64: [],
  });
});

it("keeps the first valid module facts and preserves undecoded text in order", () => {
  const unparsed = [
    "path\tsecond",
    "mod\tsecond\tv2",
    "dep\tmalformed",
    "=>\tlocal\t\t",
    'build\tbad="\\xff"',
    "future\tdata",
    "build\tGOARCH=amd64",
  ];
  const source = [
    "path\tfirst",
    "mod\tfirst\tv1",
    ...unparsed.slice(0, 2),
    "dep\tdependency\tv3",
    ...unparsed.slice(2),
  ].join("\n");
  expect(parseGoModuleBytes(Buffer.from(source))).toEqual({
    path: "first",
    main: { path: "first", version: "v1", sum: null, replacement: null },
    dependencies: [
      { path: "dependency", version: "v3", sum: null, replacement: null },
    ],
    settings: [],
    unparsed_lines: unparsed,
    unparsed_line_bytes_base64: [],
    complete: false,
  });
});

it("retains byte-valued producer settings and parses surrounding UTF-8 records", () => {
  const setting = Buffer.concat([
    Buffer.from("build\t-tags="),
    Buffer.from([0xff]),
  ]);
  const trailing = Buffer.from([0xfe]);
  const parsed = parseGoModuleBytes(
    Buffer.concat([
      Buffer.from("path\tapp\nmod\tapp\t(devel)\t\nbuild\tGOOS=linux\n"),
      setting,
      Buffer.from("\nbuild\tGOARCH=amd64\n"),
      trailing,
    ]),
  );
  expect(parsed).toEqual({
    path: "app",
    main: { path: "app", version: "(devel)", sum: "", replacement: null },
    dependencies: [],
    settings: [
      { key: "GOOS", value: "linux" },
      { key: "GOARCH", value: "amd64" },
    ],
    unparsed_lines: [],
    unparsed_line_bytes_base64: [
      setting.toString("base64"),
      trailing.toString("base64"),
    ],
    complete: false,
  });
});

const replacement = { path: "local", version: "", sum: "" };

it.each([
  { prefix: "mod\t", keepsOwner: false },
  { prefix: "dep\t", keepsOwner: false },
  { prefix: "=>\t", keepsOwner: false },
  { prefix: "build\t-tags=", keepsOwner: true },
  { prefix: "future\t", keepsOwner: true },
])(
  "handles replacement ownership through undecodable $prefix",
  ({ prefix, keepsOwner }) => {
    const invalid = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xff]),
      Buffer.from(keepsOwner ? "" : "	v2	"),
    ]);
    const replacementLine = "=>\tlocal\t\t";
    const source = Buffer.concat([
      Buffer.from("dep\tfirst\tv1\n"),
      invalid,
      Buffer.from("\n" + replacementLine + "\n"),
    ]);
    expect(parseGoModuleBytes(source)).toMatchObject({
      dependencies: [
        {
          path: "first",
          version: "v1",
          sum: null,
          replacement: keepsOwner ? replacement : null,
        },
      ],
      unparsed_lines: keepsOwner ? [] : [replacementLine],
      unparsed_line_bytes_base64: [invalid.toString("base64")],
      complete: false,
    });
  },
);
