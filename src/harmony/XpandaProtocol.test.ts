import { describe, expect, it } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  classifyProducerError,
  parseXpandaDecompile,
  parseXpandaDisassembly,
  parseXpandaEnvelope,
  xpandaClassListSchema,
  xpandaExportSchema,
  xpandaLoadSchema,
  xpandaStringMatchesSchema,
} from "./XpandaProtocol.js";

/** Real producer reply shapes captured from xpanda 2.1.0 against md5.abc. */
const DECOMPILE_BODY = "/*\n* class name:L_GLOBAL;\n*/\n(function () {})();\n";
const GOLDEN = {
  load: {
    fileId: "md5-5411df7",
    path: "/private/xpanda/input.abc",
    cached: false,
    bytecodeVersion: "11.0.2.0",
    checksum: "0x5411df7",
    fileSizeBytes: 8016,
    classCount: 2,
    foreignClassCount: 1,
    lnpCount: 10,
    classesPreview: ["_ESSlotNumberAnnotation", "_GLOBAL"],
    previewTruncated: false,
    hint: "使用 abc_list_classes 分页浏览全部类;abc_decompile_class 反编译单个类。",
  },
  list: {
    fileId: "md5-5411df7",
    total: 2,
    filtered: 2,
    offset: 0,
    returned: 2,
    truncated: false,
    classes: [
      {
        name: "_ESSlotNumberAnnotation",
        methods: 0,
        fields: 0,
        external: false,
      },
      { name: "_GLOBAL", methods: 14, fields: 0, external: false },
    ],
  },
  decompile: `// xpanda-mcp class=_GLOBAL simplified=true degraded=false chars=${Buffer.byteLength(
    DECOMPILE_BODY,
  )}\n${DECOMPILE_BODY}`,
  disassemble:
    'method: func_main_0  vregs=0 args=3  blocks=1\n\nentry:\n\t0:definefunc || acc = 0, method:"#1#", 0\n\t8:returnundefined || ',
  strings: {
    fileId: "md5-5411df7",
    poolSize: 31,
    matched: 5,
    offset: 0,
    returned: 5,
    truncated: false,
    strings: [{ offset: "0x1fd", content: "md5" }],
  },
  export: {
    fileId: "md5-5411df7",
    outDir: "/tmp/exported",
    written: 1,
    skipped: 1,
    failed: 0,
    degradedClasses: [],
    files: ["_GLOBAL"],
    filesTruncated: false,
  },
} as const;

describe("xpanda producer JSON contracts", () => {
  it("parses captured abc_load replies", () => {
    expect(xpandaLoadSchema.parse(GOLDEN.load)).toMatchObject({
      fileId: "md5-5411df7",
      classCount: 2,
    });
  });

  it("parses captured abc_list_classes replies", () => {
    expect(xpandaClassListSchema.parse(GOLDEN.list)).toMatchObject({
      returned: 2,
      truncated: false,
    });
  });

  it("parses captured abc_export replies", () => {
    expect(xpandaExportSchema.parse(GOLDEN.export)).toMatchObject({
      written: 1,
      skipped: 1,
      failed: 0,
    });
  });

  it("parses captured abc_search_strings replies", () => {
    expect(xpandaStringMatchesSchema.parse(GOLDEN.strings)).toMatchObject({
      poolSize: 31,
      matched: 5,
    });
  });

  it("rejects JSON replies missing the documented fields", () => {
    expect(xpandaLoadSchema.safeParse({ fileId: "x" }).success).toBe(false);
  });
});

describe("xpanda MCP envelope", () => {
  it("returns producer text for successful envelopes", () => {
    expect(
      parseXpandaEnvelope("inspect_harmony_abc", "abc_load", {
        content: [{ type: "text", text: "{}" }],
      }),
    ).toBe("{}");
  });

  it("classifies isError envelopes through the producer error channel", () => {
    // abc_load failures are input errors on the selected path.
    expect(() =>
      parseXpandaEnvelope("inspect_harmony_abc", "abc_load", {
        content: [{ type: "text", text: "ERROR: Error: boom" }],
        isError: true,
      }),
    ).toThrow(AnalysisInputError);
    // Unknown producer failures stay adapter errors.
    expect(() =>
      parseXpandaEnvelope("inspect_harmony_abc", "abc_list_classes", {
        content: [{ type: "text", text: "ERROR: Error: boom" }],
        isError: true,
      }),
    ).toThrow(ProviderAdapterError);
  });

  it("fails typed on a malformed envelope instead of guessing", () => {
    expect(() =>
      parseXpandaEnvelope("inspect_harmony_abc", "abc_load", {
        content: [],
      }),
    ).toThrow(ProviderAdapterError);
  });
});

describe("producer error classification", () => {
  it("maps abc_load failures to the selected path", () => {
    const error = classifyProducerError(
      "inspect_harmony_abc",
      "abc_load",
      "ERROR: PandaParseException: Checksum check failed,the file may be encrypted...",
    );
    expect(error).toBeInstanceOf(AnalysisInputError);
    const input = error as AnalysisInputError;
    expect(input.issues[0]?.path).toEqual(["path"]);
    expect(input.userMessage).toContain("could not parse this file");
  });

  it("maps missing classes to the class_name issue", () => {
    const error = classifyProducerError(
      "decompile_harmony_abc_class",
      "abc_decompile_class",
      "ERROR: Error: 类未找到: NoSuchClass\n候选: \n - _GLOBAL",
    );
    expect(error).toBeInstanceOf(AnalysisInputError);
    expect((error as AnalysisInputError).issues[0]?.path).toEqual([
      "class_name",
    ]);
  });

  it("maps missing methods to the method_name issue with producer remedies", () => {
    const error = classifyProducerError(
      "disassemble_harmony_abc_method",
      "abc_disassemble_method",
      "ERROR: Error: 方法未找到: nope\n类 L_GLOBAL; 中的方法: \n - ff",
    );
    expect(error).toBeInstanceOf(AnalysisInputError);
    expect((error as AnalysisInputError).issues[0]?.path).toEqual([
      "method_name",
    ]);
    expect((error as AnalysisInputError).userMessage).toContain("方法未找到");
  });

  it("maps unimplemented conditional jumps to a capability boundary", () => {
    const error = classifyProducerError(
      "disassemble_harmony_abc_method",
      "abc_disassemble_method",
      "ERROR: Error: 反汇编失败: PandaInstruction not implemented: jeq",
    );
    expect(error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(
      (error as AnalysisCapabilityUnavailableError).remediationAction,
    ).toContain("degraded");
  });

  it("keeps unknown fileId reports as adapter sequencing violations", () => {
    const error = classifyProducerError(
      "inspect_harmony_abc",
      "abc_list_classes",
      "ERROR: Error: fileId 不存在: x 请先调用 abc_load",
    );
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).remediationAction).toContain(
      "Retry",
    );
  });
});

describe("abc_decompile_class text parsing", () => {
  it("parses a captured header and verifies the payload length", () => {
    const parsed = parseXpandaDecompile(
      "decompile_harmony_abc_class",
      GOLDEN.decompile,
    );
    expect(parsed).toMatchObject({
      className: "_GLOBAL",
      simplified: true,
      degraded: false,
      emptyResult: false,
      truncated: false,
      characters: Buffer.byteLength(DECOMPILE_BODY),
    });
    expect(parsed.content.startsWith("/*")).toBe(true);
  });

  it("parses a truncated transfer without fabricating the original length", () => {
    const content = "x".repeat(50_000);
    const text = `// xpanda-mcp class=C simplified=false degraded=true chars=90000 TRUNCATED\n${content}\n\n/* ...输出已截断 */`;
    const parsed = parseXpandaDecompile("decompile_harmony_abc_class", text);
    expect(parsed).toMatchObject({
      truncated: true,
      degraded: true,
      simplified: false,
      characters: 90_000,
    });
  });

  it("recognizes the producer's empty-decompilation marker", () => {
    const parsed = parseXpandaDecompile(
      "decompile_harmony_abc_class",
      "// 反编译结果为空(该类可能没有 func_main_0 入口或反编译失败)\n",
    );
    expect(parsed).toMatchObject({ emptyResult: true, content: "" });
  });

  it("fails typed when the header is missing", () => {
    expect(() =>
      parseXpandaDecompile("decompile_harmony_abc_class", "function () {}"),
    ).toThrow(ProviderAdapterError);
  });

  it("fails typed when the payload length contradicts the header", () => {
    expect(() =>
      parseXpandaDecompile(
        "decompile_harmony_abc_class",
        "// xpanda-mcp class=C simplified=true degraded=false chars=99\nshort",
      ),
    ).toThrow(ProviderAdapterError);
  });
});

describe("abc_disassemble_method text parsing", () => {
  it("parses a captured header and keeps the listing verbatim", () => {
    const parsed = parseXpandaDisassembly(
      "disassemble_harmony_abc_method",
      GOLDEN.disassemble,
    );
    expect(parsed).toMatchObject({
      methodName: "func_main_0",
      virtualRegisters: 0,
      arguments: 3,
      blocks: 1,
      truncated: false,
    });
    expect(parsed.text).toBe(GOLDEN.disassemble);
  });

  it("reports the producer's instruction-cap truncation", () => {
    const parsed = parseXpandaDisassembly(
      "disassemble_harmony_abc_method",
      `${GOLDEN.disassemble}\n/* ...已按 maxInstructions=1500 截断,可调大参数继续 */`,
    );
    expect(parsed.truncated).toBe(true);
  });

  it("fails typed when the header line is missing", () => {
    expect(() =>
      parseXpandaDisassembly(
        "disassemble_harmony_abc_method",
        "entry:\n\t0:nop",
      ),
    ).toThrow(ProviderAdapterError);
  });
});
