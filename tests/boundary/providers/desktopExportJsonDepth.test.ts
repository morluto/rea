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
