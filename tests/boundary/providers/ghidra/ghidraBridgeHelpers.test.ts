import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { literalSubstringPredicate } from "../../../../src/domain/analysisSearch.js";
import { decodeStrictUtf8 } from "../../../../src/domain/strictUtf8.js";
import { ghidraAsciiLiteralCandidate } from "../../../../src/ghidra/GhidraLiteralSearch.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../../support/workspace/workspaceFixture.js";
import {
  compileBridgeProbe,
  discoverJdk21Toolchain,
  encodeUtf16Hex,
  runBridgeProbe,
  type CompiledBridgeProbe,
} from "./ghidraBridgeHelpers.fixture.js";

const jdk = await discoverJdk21Toolchain();

let workspace: TestWorkspace | undefined;
let probe: CompiledBridgeProbe | undefined;

const requireProbe = (): CompiledBridgeProbe => {
  if (probe === undefined) {
    throw new Error("Compiled bridge helper probe was not initialized");
  }
  return probe;
};

const splitProbeLines = (output: string): string[] =>
  output.trim().split(/\r?\n/u);

beforeAll(async () => {
  if (jdk === undefined) return;
  workspace = await createTestWorkspace("rea-ghidra-bridge-helpers-");
  probe = await compileBridgeProbe(jdk, workspace.root);
}, 60_000);

afterAll(async () => {
  if (workspace !== undefined) {
    await removeTestWorkspace(workspace.root);
    workspace = undefined;
  }
  probe = undefined;
});

describe.skipIf(jdk === undefined)(
  "ReaGhidraBridge literalCandidateMatcher and foldAsciiCandidateChar",
  () => {
    it("folds ASCII letters, U+017F, and U+212A while rejecting other non-ASCII chars", async () => {
      const cases: readonly [string, number][] = [
        ["a", "a".charCodeAt(0)],
        ["A", "a".charCodeAt(0)],
        ["z", "z".charCodeAt(0)],
        ["Z", "z".charCodeAt(0)],
        ["0", "0".charCodeAt(0)],
        [":", ":".charCodeAt(0)],
        ["\u017f", "s".charCodeAt(0)],
        ["\u212a", "k".charCodeAt(0)],
        ["\u00e9", -1],
        ["\u0130", -1],
        ["\u0131", -1],
        ["\u00df", -1],
        ["\ud800", -1],
        ["\udfff", -1],
      ];
      const stdin = cases
        .map(([char]) => char.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("\n");
      const stdout = await runBridgeProbe(requireProbe(), "fold-char", stdin);
      const observed = splitProbeLines(stdout).map(Number);
      expect(observed).toEqual(cases.map(([, expected]) => expected));
    });

    it("keeps literalCandidateMatcher sound and consistent with JS /iu across Unicode folds and surrogates", async () => {
      const patterns = [
        "a",
        "ABC.[x]",
        "s",
        "\u017f",
        "k",
        "\u212a",
        "\u017f.\u212a",
        "\u0130",
        "\u0131",
        "\u03a3",
        "\u03c3",
        "\u03c2",
        "\u00df",
        "ss",
        "\ud801\udc00",
        "\ud801\udc28",
        "\ud83d\ude00",
        "\ud800",
        "\udfff",
        "pre\ud800mid",
      ];
      const values = [
        "",
        "a",
        "A",
        "prefix_abc.[X]_suffix",
        "s",
        "S",
        "\u017f",
        "k",
        "K",
        "\u212a",
        "x\u017f.Ky",
        "i",
        "I",
        "\u0130",
        "\u0131",
        "\u03a3",
        "\u03c3",
        "\u03c2",
        "\u00df",
        "SS",
        "\ud801\udc00",
        "\ud801\udc28",
        "wrap_\ud83d\ude00_end",
        "\ud800",
        "pre\ud800mid",
        "\udfff",
        "ascii_only_string",
      ];

      const pairs: {
        readonly pattern: string;
        readonly candidate: string | null;
        readonly value: string;
      }[] = [];
      for (const pattern of patterns) {
        const candidate = ghidraAsciiLiteralCandidate(pattern);
        for (const value of values) {
          pairs.push({ pattern, candidate, value });
        }
      }
      const stdin = pairs
        .map(({ candidate, value }) =>
          candidate === null
            ? `0||${encodeUtf16Hex(value)}`
            : `1|${encodeUtf16Hex(candidate)}|${encodeUtf16Hex(value)}`,
        )
        .join("\n");
      const stdout = await runBridgeProbe(
        requireProbe(),
        "literal-batch",
        stdin,
      );
      const observed = splitProbeLines(stdout);
      expect(observed).toHaveLength(pairs.length);

      for (let index = 0; index < pairs.length; index += 1) {
        const { pattern, candidate, value } = pairs[index]!;
        const matched = observed[index] === "1";
        const jsMatches = literalSubstringPredicate(pattern, false)(value);
        if (jsMatches) {
          expect(matched).toBe(true);
        }
        const valueIsAscii = [...value].every((ch) => ch.charCodeAt(0) <= 127);
        if (valueIsAscii) {
          expect(matched).toBe(jsMatches);
        }
        if (candidate === null) {
          expect(matched).toBe(!valueIsAscii);
        }
      }
    });

    it("handles empty, invalid non-ASCII, and case-sensitive literal matchers", async () => {
      const invalidAndEdge = await runBridgeProbe(
        requireProbe(),
        "literal-batch",
        [
          `1||${encodeUtf16Hex("anything")}`,
          `1|${encodeUtf16Hex("é")}|${encodeUtf16Hex("é")}`,
          `1|${encodeUtf16Hex("abc")}|${encodeUtf16Hex("ab")}`,
        ].join("\n"),
      );
      expect(splitProbeLines(invalidAndEdge)).toEqual([
        "1",
        "ERR:invalid_request:ASCII candidate contains a non-ASCII character",
        "0",
      ]);

      const direct = await runBridgeProbe(
        requireProbe(),
        "literal-direct",
        [
          `${encodeUtf16Hex("AbC")}|${encodeUtf16Hex("xxAbCyy")}`,
          `${encodeUtf16Hex("AbC")}|${encodeUtf16Hex("xxabcyy")}`,
          `${encodeUtf16Hex("\ud800")}|${encodeUtf16Hex("a\ud800b")}`,
          `${encodeUtf16Hex("\ud83d\ude00")}|${encodeUtf16Hex("a\ud83d\ude00b")}`,
        ].join("\n"),
      );
      expect(splitProbeLines(direct)).toEqual(["1", "0", "1", "1"]);
    });
  },
);

describe.skipIf(jdk === undefined)(
  "ReaGhidraBridge writeResponse and SurrogateEscapingWriter",
  () => {
    it("streams valid UTF-8 NDJSON through writeResponse for surrogates and control chars", async () => {
      const payloads: readonly {
        readonly mode: "string-writer" | "char-array";
        readonly kind: "success" | "failure";
        readonly key: string;
        readonly value: string;
      }[] = [
        {
          mode: "string-writer",
          kind: "success",
          key: "pair",
          value: "emoji-\ud83d\ude00-deseret-\ud801\udc00-end",
        },
        {
          mode: "char-array",
          kind: "success",
          key: "pair_chars",
          value: "emoji-\ud83d\ude00-deseret-\ud801\udc00-end",
        },
        {
          mode: "string-writer",
          kind: "success",
          key: "lone_high_\ud800",
          value: "hi-\ud800-lo-\udfff-rev-\udc00\ud800-slash-\\\ud800",
        },
        {
          mode: "char-array",
          kind: "success",
          key: "lone_chars",
          value: "hi-\ud800-lo-\udfff-slash-\\\ud83d\ude00",
        },
        {
          mode: "string-writer",
          kind: "success",
          key: "controls",
          value: "\u0000\u0001\b\t\n\f\r\u001f\"\\<>&='\u2028\u2029é逆向",
        },
        {
          mode: "string-writer",
          kind: "failure",
          key: "invalid_request",
          value: "bad-\u0000-\ud800-\ud83d\ude00-\n",
        },
      ];

      const stdin = payloads
        .map(
          ({ mode, kind, key, value }) =>
            `${mode}|${kind}|${encodeUtf16Hex(key)}|${encodeUtf16Hex(value)}`,
        )
        .join("\n");
      const stdout = await runBridgeProbe(
        requireProbe(),
        "write-response",
        stdin,
      );
      const lines = splitProbeLines(stdout);
      expect(lines).toHaveLength(payloads.length);

      for (let index = 0; index < payloads.length; index += 1) {
        const expected = payloads[index]!;
        const wireBytes = Buffer.from(lines[index]!, "base64");
        const wireText = decodeStrictUtf8(wireBytes, "preserve");
        expect(wireText.endsWith("\n")).toBe(true);
        const frame = wireText.replace(/\r?\n$/u, "");
        expect(frame).not.toContain("\n");
        expect(frame).not.toContain("\r");
        expect(frame).not.toContain("\u0000");

        if (expected.value.includes("\ud800")) {
          expect(frame).toContain("\\ud800");
        }
        if (expected.value.includes("\udfff")) {
          expect(frame).toContain("\\udfff");
        }
        if (expected.value.includes("\ud83d\ude00")) {
          expect(frame).toContain("\\ud83d\\ude00");
        }
        if (expected.value.includes("\u0000")) {
          expect(frame).toContain("\\u0000");
        }

        const parsed: unknown = JSON.parse(frame);
        if (expected.kind === "failure") {
          expect(parsed).toEqual({
            id: 7,
            ok: false,
            error: { code: expected.key, message: expected.value },
          });
        } else {
          expect(parsed).toEqual({
            id: 1,
            ok: true,
            result: { [expected.key]: expected.value },
          });
        }
      }
    });

    it("exercises SurrogateEscapingWriter write/append/flush/close and writeResponse failures", async () => {
      const writerOut = await runBridgeProbe(
        requireProbe(),
        "surrogate-writer",
      );
      const writerEntries = Object.fromEntries(
        splitProbeLines(writerOut).map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
      );
      expect(writerEntries.no_early_flush).toBe("true");
      expect(writerEntries.bounds_checks).toBe("true");
      const decoded = Buffer.from(
        writerEntries.after_flush ?? "",
        "base64",
      ).toString("utf8");
      expect(decoded).toBe(
        "A\\ud800\\udfffb\\ud83d\\ude00c\\ud801d-\\udc00-e-nullS\\ud800B\\udffful1\\ud8002q\\udc01r!",
      );

      const failureOut = await runBridgeProbe(requireProbe(), "write-failures");
      const failures = splitProbeLines(failureOut);
      expect(failures).toEqual([
        "unwrap_write_io=OK:simulated write failure",
        "newline_io=OK:simulated newline failure",
        "flush_io=OK:simulated flush failure",
        "rethrow_non_io_cause=OK:IllegalStateException",
        "rethrow_bare_json_io=OK:bare-json-io",
      ]);
    });
  },
);

describe.skipIf(jdk === undefined)(
  "ReaGhidraBridge resolveProcedureCandidatesDirect",
  () => {
    it("resolves qualified names with :: in the leaf before procedureInventory is cached", async () => {
      const expected: readonly [string, string][] = [
        ["ns::other::work", "0x1000"],
        ["ns::thunk_other::work", "0x2500"],
        ["thunk_other::work", "0x2500"],
        ["wrong::other::work", "0x1300"],
        [
          "other::work",
          "ERR:procedure_ambiguous:Ghidra procedure name is ambiguous: other::work; select an exact entry address from [0x1000, 0x1300]",
        ],
        ["ns::unique::leaf", "0x1600"],
        ["unique::leaf", "0x1600"],
        ["leaf", "null"],
        ["other::unique::leaf", "null"],
        ["work", "null"],
        ["missing::other::work", "null"],
        ["pkg::sub::inner::do::step", "0x1100"],
        ["inner::do::step", "0x1100"],
        ["do::step", "null"],
        ["step", "null"],
        ["ns::shared::op", "0x1400"],
        [
          "shared::op",
          "ERR:procedure_ambiguous:Ghidra procedure name is ambiguous: shared::op; select an exact entry address from [0x1400, 0x1500]",
        ],
        ["op", "0x1500"],
        ["ns::thunk_target::op", "0x2000"],
        ["thunk_target::op", "0x2000"],
        ["lib::target::op", "0x2100"],
        ["ns::thunk_thunk_nested::op", "0x2200"],
        ["thunk_thunk_nested::op", "0x2200"],
        ["thunk_ns::nested::op", "0x2400"],
        [
          "nested::op",
          "ERR:procedure_ambiguous:Ghidra procedure name is ambiguous: nested::op; select an exact entry address from [0x2300, 0x2400]",
        ],
        ["<EXTERNAL>::ext::work", "EXTERNAL:0x3000"],
        ["ext::work", "EXTERNAL:0x3000"],
        ["ns::thunk_ext::work", "0x3100"],
        ["FUN_00401000", "0x401000"],
        ["ns::thunk_FUN_00401000", "0x402000"],
        ["ns:::triple", "0x4100"],
        ["ns:::colon_leaf", "0x4200"],
        ["alias_ns::sub::leaf", "0x1000"],
        ["sub::leaf", "0x1000"],
        ["ns::inner::body_label", "null"],
        [
          "dup::a::b",
          "ERR:procedure_ambiguous:Ghidra procedure name is ambiguous: dup::a::b; select an exact entry address from [0x5000, 0x5100]",
        ],
      ];

      const stdin = expected.map(([query]) => query).join("\n");
      const stdout = await runBridgeProbe(
        requireProbe(),
        "resolve-procedures",
        stdin,
      );
      const rows = splitProbeLines(stdout);
      expect(rows).toHaveLength(expected.length);

      for (let index = 0; index < expected.length; index += 1) {
        const [expectedQuery, expectedOutcome] = expected[index]!;
        const [query, uncached, cached] = rows[index]!.split("\t");
        expect(query).toBe(expectedQuery);
        expect(uncached).toBe(expectedOutcome);
        expect(cached).toBe(expectedOutcome);
      }
    });
  },
);
