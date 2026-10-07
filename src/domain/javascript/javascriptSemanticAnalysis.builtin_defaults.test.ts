import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each(["namespace", "default", "named-default"])(
  "retains Node built-in effects from %s imports",
  (mode) => {
    const imports = ["fs", "child_process", "timers", "http"]
      .map((name, index) => {
        const declaration =
          mode === "namespace"
            ? `* as m${String(index)}`
            : mode === "default"
              ? `m${String(index)}`
              : `{default as m${String(index)}}`;
        return `import ${declaration} from 'node:${name}';`;
      })
      .join("\n");
    const ir = analyzeJavaScriptSemantics(`${imports}
    const text = m0.readFileSync('config.json','utf8');
    const stream = m0.createReadStream('config.json'); stream.destroy();
    const child = m1.spawn('/usr/bin/tool', ['--version']);
    const timer = m2.setTimeout(work,1000); m2.clearTimeout(timer);
    const request = m3.get('http://localhost/');
  `);
    expect(ir.configurationOperations).toHaveLength(1);
    expect(ir.resourceOperations).toHaveLength(2);
    expect(ir.childProcessSpawns).toHaveLength(1);
    expect(ir.timerOperations).toHaveLength(2);
    expect(ir.requestOperations).toHaveLength(1);
  },
);

it.each([
  "import fs from './fs.js'; fs.createReadStream('config.json');",
  "import {constants as fs} from 'node:fs'; fs.createReadStream('config.json');",
  "function run(fs) { fs.createReadStream('config.json'); }",
])("does not invent a built-in namespace for %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).resourceOperations).toEqual([]);
});
