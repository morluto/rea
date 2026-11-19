import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import {
  detectStateFormat,
  textualView,
} from "../../../src/domain/desktop/stateFormats.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const arrays = "[".repeat(1500) + "1" + "]".repeat(1500);
const objects = '{"a":'.repeat(1500) + "1" + "}".repeat(1500);
const cases = [
  ["discarded arrays", `{"value":${arrays},"value":"done"}`, true],
  ["discarded objects", `{"value":${objects},"value":"done"}`, true],
  ["escaped duplicate key", `{"val\\u0075e":${arrays},"value":"done"}`, true],
  ["retained deep value", `{"value":${arrays}}`, false],
  [
    "retained deep inexact number",
    `{"value":${"[".repeat(600)}9007199254740993${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep overwritten inexact number",
    `{"value":${"[".repeat(600)}{"x":9007199254740993,"x":1}${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep empty-key overwrite",
    `{"value":${"[".repeat(600)}{"":9007199254740993,"":1}${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep multiple inexact keys with one overwritten",
    `{"value":${"[".repeat(600)}{"a":9007199254740993,"b":9007199254740993,"a":1}${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep multiple inexact keys all overwritten",
    `{"value":${"[".repeat(600)}{"a":9007199254740993,"b":9007199254740993,"a":1,"b":2}${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep inexact key replaced by inexact",
    `{"value":${"[".repeat(600)}{"a":9007199254740993,"a":9007199254740995}${"]".repeat(600)}}`,
    false,
  ],
  [
    "deep escaped duplicate overwritten",
    `{"value":${"[".repeat(600)}{"\\u0061":9007199254740993,"a":1}${"]".repeat(600)}}`,
    false,
  ],
  [
    "discarded deep inexact subtree",
    `{"value":${"[".repeat(600)}9007199254740993${"]".repeat(600)},"value":"done"}`,
    true,
  ],
  ["last admitted depth", "[".repeat(500) + "1" + "]".repeat(500), true],
  ["empty container at limit", "[".repeat(501) + "]".repeat(501), true],
  ["empty container over limit", "[".repeat(502) + "]".repeat(502), false],
  ["trailing comma", `{"value":${arrays},"value":"done",}`, false],
  ["missing value", `{"value":${arrays},"value":}`, false],
  ["wrong closing bracket", `{"value":${arrays},"value":"done"]`, false],
] as const;

it.each(cases)("reads JSON with %s", async (_name, text, readable) => {
  const root = await createTestTempDirectory("desktop-json-depth-");
  const script = join(root, "read.py");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  await writeFile(
    script,
    `${imports}${PYTHON_HELPERS}
text = json.load(sys.stdin)
print(json.dumps(_text_view("state.json", text, len(text.encode("utf-8")))))
`,
  );
  const output = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-X", "utf8", script],
      { input: JSON.stringify(text), encoding: "utf8" },
    ),
  ) as { format: string; view: unknown; error?: string };
  const bytes = Buffer.from(text);
  const format = detectStateFormat("state.json", bytes);
  if (format !== "json" && format !== "text")
    throw new Error(`Unexpected native format ${format}`);
  const native = textualView(format, bytes);
  expect(format === "json" && native.ok).toBe(readable);
  expect(output.format).toBe(format);
  if (native.ok) {
    expect(output.error).toBeUndefined();
    if (format === "json") expect(output).toMatchObject({ truncated: false });
    // Compare JSON values on their wire form, independent of object prototypes.
    expect(JSON.stringify(output.view)).toBe(JSON.stringify(native.value));
    if (
      readable &&
      (_name.startsWith("discarded") || _name === "escaped duplicate key")
    )
      expect(output.view).toEqual({ value: "done" });
  } else {
    expect(output.view).toBeNull();
    expect(output.error).toBe(native.error);
  }
});

it("bounds construction before refusing retained excessive JSON depth", async () => {
  const root = await createTestTempDirectory("desktop-json-construction-");
  const script = join(root, "bounded.py");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  await writeFile(
    script,
    `${imports}${PYTHON_HELPERS}
import tracemalloc
text = "[" * 20_000 + "0" + "]" * 20_000
recursion_limit = sys.getrecursionlimit()
tracemalloc.start()
entry = _json_view(text, len(text))
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
print(json.dumps({"entry": entry, "peak": peak, "recursion_unchanged": sys.getrecursionlimit() == recursion_limit}))
`,
  );
  const output = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-X", "utf8", script],
      { encoding: "utf8" },
    ),
  ) as { entry: unknown; peak: number; recursion_unchanged: boolean };
  expect(output.entry).toEqual({
    format: "json",
    view: null,
    error: "nested deeper than the 500 levels a JSON view keeps",
  });
  expect(output.recursion_unchanged).toBe(true);
  // Python heap only, excluding source construction and interpreter/OS memory.
  // A value retained only to refuse it must not allocate every input container.
  expect(output.peak).toBeLessThan(1024 * 1024);
});

it("bounds allocations when a very deep value is overwritten", async () => {
  const root = await createTestTempDirectory("desktop-json-memory-");
  const script = join(root, "read.py");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  await writeFile(
    script,
    `${imports}\nimport tracemalloc\n${PYTHON_HELPERS}
text = '{"value":' + '[' * 200000 + '1' + ']' * 200000 + ',"value":"done"}'
tracemalloc.start()
result = _json_view(text, len(text))
_, peak = tracemalloc.get_traced_memory()
print(json.dumps({"view": result["view"], "peak": peak}))
`,
  );
  const measured = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", script],
      { encoding: "utf8", timeout: 30000 },
    ),
  ) as { view: unknown; peak: number };
  expect(measured.view).toEqual({ value: "done" });
  expect(measured.peak).toBeLessThan(8 * 1024 * 1024);
});

it("bounds a wide container already beyond the retained view depth", async () => {
  const root = await createTestTempDirectory("desktop-json-wide-depth-");
  const script = join(root, "read.py");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  await writeFile(
    script,
    `${imports}\nimport tracemalloc\n${PYTHON_HELPERS}
text = '[' * 501 + ','.join(['"abc"'] * 600000) + ']' * 501
tracemalloc.start()
result = _json_view(text, len(text))
_, peak = tracemalloc.get_traced_memory()
print(json.dumps({"error": result.get("error"), "peak": peak}))
`,
  );
  const measured = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", script],
      { encoding: "utf8", timeout: 30000 },
    ),
  ) as { error: string; peak: number };
  expect(measured.error).toBe(
    "nested deeper than the 500 levels a JSON view keeps",
  );
  expect(measured.peak).toBeLessThan(8 * 1024 * 1024);
});
