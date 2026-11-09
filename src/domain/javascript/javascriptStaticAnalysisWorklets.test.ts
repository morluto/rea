import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const worklets = (source: string) => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_error_count).toBe(0);
  return analysis.references
    .filter(({ kind }) => kind === "worklet")
    .map(({ specifier, expression }) => ({ specifier, expression }));
};

const moduleUrl = 'new URL("./processor.js?v=2", import.meta.url)';

describe("worklet module load identity", () => {
  it.each([
    ["", "CSS.paintWorklet.addModule"],
    ["", "window.CSS.layoutWorklet.addModule"],
    ["", "globalThis.CSS.animationWorklet.addModule"],
    ["", "CSS?.paintWorklet?.addModule"],
    ["", 'CSS["paintWorklet"]["addModule"]'],
    ["", "new AudioContext().audioWorklet.addModule"],
    [
      "",
      "new window.AudioContext({ sampleRate: 48000 }).audioWorklet.addModule",
    ],
    ["const context = new AudioContext(); ", "context.audioWorklet.addModule"],
    [
      "const context = new OfflineAudioContext(1, 128, 44100); ",
      "context?.audioWorklet.addModule",
    ],
    [
      "const context = new AudioContext(); const alias = context; context.unrelated = 1; ",
      "alias.audioWorklet.addModule",
    ],
  ])("resolves a module-relative URL for %s%s", (prefix, callee) => {
    expect(worklets(`${prefix}${callee}(${moduleUrl});`)).toEqual([
      { specifier: "./processor.js?v=2", expression: null },
    ]);
  });

  it.each([
    'const CSS = vendor; CSS.paintWorklet.addModule("./p.js");',
    'import CSS from "vendor"; CSS.paintWorklet.addModule("./p.js");',
    'vendor.paintWorklet.addModule("./p.js");',
    'CSS.otherWorklet.addModule("./p.js");',
    'CSS.paintWorklet[method]("./p.js");',
    'CSS.paintWorklet.addModule = load; CSS.paintWorklet.addModule("./p.js");',
    'CSS.paintWorklet = vendor; CSS.paintWorklet.addModule("./p.js");',
    'function load(context) { return context.audioWorklet.addModule("./p.js"); }',
    'class Player { load() { return this.context.audioWorklet.addModule("./p.js"); } }',
    'const context = new Vendor(); context.audioWorklet.addModule("./p.js");',
    'const AudioContext = Vendor; new AudioContext().audioWorklet.addModule("./p.js");',
    'import { AudioContext } from "vendor"; new AudioContext().audioWorklet.addModule("./p.js");',
    'let context = new AudioContext(); context = vendor; context.audioWorklet.addModule("./p.js");',
    'const context = new AudioContext(); context.audioWorklet = vendor; context.audioWorklet.addModule("./p.js");',
    'const context = new AudioContext(); context.audioWorklet.addModule = load; context.audioWorklet.addModule("./p.js");',
    'const context = new AudioContext(); Object.assign(context.audioWorklet, { addModule: load }); context.audioWorklet.addModule("./p.js");',
    'const context = new AudioContext(); patch(context); context.audioWorklet.addModule("./p.js");',
    'AudioWorklet.prototype.addModule = load; new AudioContext().audioWorklet.addModule("./p.js");',
    'Worklet.prototype.addModule = load; new AudioContext().audioWorklet.addModule("./p.js");',
    'AudioContext.prototype.audioWorklet = vendor; new AudioContext().audioWorklet.addModule("./p.js");',
    'eval(code); new AudioContext().audioWorklet.addModule("./p.js");',
  ])("does not attribute a replaced or unproven API: %s", (source) => {
    expect(worklets(source)).toEqual([]);
  });

  it.each([
    "CSS.paintWorklet.addModule",
    "new AudioContext().audioWorklet.addModule",
  ])(
    "retains the expression when the module-relative URL is unknown: %s",
    (callee) => {
      for (const argument of [
        '"./processor.js"',
        'new URL("./processor.js", document.baseURI)',
        'new URL("/processor.js", import.meta.url)',
        "URL.createObjectURL(blob)",
      ]) {
        const expression = `${callee}(${argument})`;
        expect(worklets(`${expression};`)).toEqual([
          { specifier: null, expression },
        ]);
      }
    },
  );
});
