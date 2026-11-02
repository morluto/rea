import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  detectRecoveryObfuscatorFacts,
  recoveryObfuscatorLimitation,
} from "./RecoveryObfuscatorDetection.js";

const FIXTURE_DIRECTORY = join(
  import.meta.dirname,
  "../../../tests/fixtures/javascript-recovery",
);
const fixturePath = join(FIXTURE_DIRECTORY, "obfuscator-signature-fixture.js");
const expectationsPath = join(
  FIXTURE_DIRECTORY,
  "obfuscator-signature-expectations.json",
);

type FixtureExpectations = {
  sha256: string;
  bytes: number;
  identifiers: number;
  decoder_calls: number;
};

it("matches the recorded javascript-obfuscator fixture identity and facts", () => {
  const bytes = readFileSync(fixturePath);
  const expectations = JSON.parse(
    readFileSync(expectationsPath, "utf8"),
  ) as FixtureExpectations;
  expect(bytes.length).toBe(expectations.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    expectations.sha256,
  );
  const facts = detectRecoveryObfuscatorFacts(bytes);
  expect(facts).toEqual({
    identifiers: expectations.identifiers,
    decoderCalls: expectations.decoder_calls,
  });
});

it("does not detect ordinary minified bundle code", () => {
  const bundle = [
    "const e=Symbol.for('react.element');",
    "function t(n,r,o){return n[r]=(n[r]||0)+o,n}",
    "class c{constructor(){this.items=[]}add(i){this.items.push(i)}}",
    "const s=new Intl.NumberFormat('en-US',{style:'currency'}).format(42);",
    "for(const[k,v]of Object.entries({a:1,b:2}))t({},k,v);",
  ].join("\n");
  expect(detectRecoveryObfuscatorFacts(Buffer.from(bundle))).toBeUndefined();
});

it("does not detect sparse _0x names without string-array decoder calls", () => {
  const code = Array.from(
    { length: 8 },
    (_, index) => `const _0x${index.toString(16).padStart(4, "0")}=void 0;`,
  ).join("\n");
  expect(detectRecoveryObfuscatorFacts(Buffer.from(code))).toBeUndefined();
});

it("does not detect decoder calls when identifiers stay below the threshold", () => {
  const code = ["_0x000a(0x1);", "_0x000a(0x2);", "_0x000a(0x3);"].join("\n");
  expect(detectRecoveryObfuscatorFacts(Buffer.from(code))).toBeUndefined();
});

it("detects both patterns at the thresholds and reports observed counts", () => {
  const declarations = Array.from(
    { length: 5 },
    (_, index) => `const _0x${index.toString(16).padStart(4, "0")}=void 0;`,
  );
  const code = [...declarations, "_0x0005(0x1);", "_0x0005(0x2);"].join("\n");
  expect(detectRecoveryObfuscatorFacts(Buffer.from(code))).toEqual({
    identifiers: 7,
    decoderCalls: 2,
  });
});

it("preserves counts for multi-byte UTF-8 input", () => {
  const declarations = Array.from(
    { length: 5 },
    (_, index) =>
      `const _0x${index.toString(16).padStart(4, "0")}="\u00e9\u4e2d\u6587";`,
  );
  const code = [...declarations, "_0x0005(0x1);", "_0x0005(0x2);"].join("\n");
  expect(detectRecoveryObfuscatorFacts(Buffer.from(code))).toEqual({
    identifiers: 7,
    decoderCalls: 2,
  });
});

it("names the observed facts, the external pipeline and re-ingestion in the limitation", () => {
  const limitation = recoveryObfuscatorLimitation("bundle.js", {
    identifiers: 92,
    decoderCalls: 26,
  });
  expect(limitation).toContain("bundle.js");
  expect(limitation).toContain("92 _0x-hex identifier");
  expect(limitation).toContain("26 string-array decoder-call occurrences");
  expect(limitation).toContain("Structural splitting is limited");
  expect(limitation).toContain("webcrack");
  expect(limitation).toContain("obfuscator-io-deobfuscator");
  expect(limitation).toContain("humanify");
  expect(limitation).toContain("re-ingesting that output");
  expect(limitation).toContain("REA does not install or run these tools");
});
