import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { detectStateFormat } from "../../../src/domain/desktop/stateFormats.js";

/** The exported module's view format for each file, run with only its standard library imports. */
const pythonFormats = (files: readonly (readonly [string, string])[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
for name, text in json.load(sys.stdin):
    print(_text_view(name, text)["format"])
`;
  return execFileSync("python3", ["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split("\n");
};

it("detects key files by the state view's rule rather than a name or any group header", () => {
  const files = [
    ["list.txt", "Groceries\n[x]\nmilk\n"],
    ["settings.ini", "free text\n"],
    ["app.conf", "wrap=false\n"],
    ["settings", "# saved\n[ui]\nwrap=false\n\n; end\n"],
    ["notes.rc", "[a]\r\nkey = value\r\n"],
  ] as const;

  const formats = pythonFormats(files);

  expect(formats).toEqual(["text", "text", "text", "keyfile", "keyfile"]);
  expect(formats).toEqual(
    files.map(([name, text]) =>
      detectStateFormat(name, new TextEncoder().encode(text)),
    ),
  );
});

/** The exported module's UTF-16 seed respelling of each file, from /home/ada to /home/user, as hex. */
const pythonUtf16Respelled = (files: readonly string[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}
CAPTURED_HOME = "/home/ada"
${PYTHON_HELPERS}
for data in json.load(sys.stdin):
    print(_respelled_utf16(bytes.fromhex(data), Path("/home/user")).hex())
`;
  return execFileSync("python3", ["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split("\n");
};

const utf16 = (text: string, order: "le" | "be") => {
  const le = Buffer.from(`﻿${text}`, "utf16le");
  return order === "le" ? le : Buffer.from(le).swap16();
};

it("respells the captured home in UTF-16 seeds with a byte-order mark, keeping the mark and order", () => {
  const work = "# build\n20260216;1;/home/ada/.varicad\n";
  const files = [
    utf16(work, "le"),
    utf16(work, "be"),
    utf16("/home/adam/x\n", "le"),
    utf16("no home here\n", "le"),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from("/home/ada/plain\n"),
  ];

  const respelled = pythonUtf16Respelled(
    files.map((file) => file.toString("hex")),
  );

  const expected = "# build\n20260216;1;/home/user/.varicad\n";
  expect(respelled).toEqual([
    utf16(expected, "le").toString("hex"),
    utf16(expected, "be").toString("hex"),
    ...files.slice(2).map((file) => file.toString("hex")),
  ]);
});
