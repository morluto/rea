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
