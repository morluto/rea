import { describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../resources/index.js";
import { createYaraIncludeRewriter } from "./YaraRuleIncludeRewrite.js";

const rewrite = (
  source: string | Buffer,
  sourcePath: string,
  platform: NodeJS.Platform = "linux",
  chunkSize?: number,
  maxOutputBytes?: number,
): Buffer => {
  const input =
    typeof source === "string" ? Buffer.from(source, "utf8") : source;
  const rewriter = createYaraIncludeRewriter(
    sourcePath,
    platform,
    maxOutputBytes,
  );
  if (chunkSize === undefined) {
    return Buffer.concat([rewriter.push(input), rewriter.finish()]);
  }
  const parts: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    parts.push(rewriter.push(input.subarray(offset, offset + chunkSize)));
  }
  parts.push(rewriter.finish());
  return Buffer.concat(parts);
};

describe("createYaraIncludeRewriter", () => {
  it("prefixes relative POSIX includes without collapsing parent components and keeps absolute ones", () => {
    const input = [
      'include "common.yar"',
      'include\t"sub/nested.yar"',
      'include "../shared/base.yar"',
      'include "link/../common.yar"',
      'include "/abs/other.yar"',
      "rule Main { condition: true }",
    ].join("\n");
    const output = rewrite(input, "/rules/packers/main.yar", "linux").toString(
      "utf8",
    );
    expect(output).toBe(
      [
        'include "/rules/packers/common.yar"',
        'include\t"/rules/packers/sub/nested.yar"',
        'include "/rules/packers/../shared/base.yar"',
        'include "/rules/packers/link/../common.yar"',
        'include "/abs/other.yar"',
        "rule Main { condition: true }",
      ].join("\n"),
    );
    expect(
      rewrite('include "root.yar"\n', "/main.yar", "linux").toString("utf8"),
    ).toBe('include "/root.yar"\n');
  });

  it("resolves relative Windows includes with win32 path semantics", () => {
    const input = [
      'include "common.yar"',
      'include "..\\shared\\base.yar"',
      'include "D:\\abs\\other.yar"',
    ].join("\r\n");
    const output = rewrite(
      input,
      "C:\\rules\\packers\\main.yar",
      "win32",
    ).toString("utf8");
    expect(output).toBe(
      [
        'include "C:\\rules\\packers\\common.yar"',
        'include "C:\\rules\\shared\\base.yar"',
        'include "D:\\abs\\other.yar"',
      ].join("\r\n"),
    );
  });

  it("skips comments, strings, and regex literals without confusing division", () => {
    const input = [
      '// include "line_comment.yar"',
      '/* include "block_comment.yar" */',
      "rule Demo {",
      "  strings:",
      '    $s = "include \\"in_string.yar\\""',
      '    $r = /include "in_regex.yar"/',
      "  condition:",
      '    filesize / 2 > 0 and $s matches /include "in_matches.yar"/',
      "}",
      'include "real.yar"',
    ].join("\n");
    const output = rewrite(input, "/rules/main.yar", "linux").toString("utf8");
    expect(output).toContain('// include "line_comment.yar"');
    expect(output).toContain('/* include "block_comment.yar" */');
    expect(output).toContain('$s = "include \\"in_string.yar\\""');
    expect(output).toContain('$r = /include "in_regex.yar"/');
    expect(output).toContain('$s matches /include "in_matches.yar"/');
    expect(output).toContain('include "/rules/real.yar"');
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("preserves regex arguments to module functions and distinguishes division from regex literals", () => {
    const input = [
      'import "pe"',
      "rule ModuleRegex {",
      "  condition:",
      '    pe.exports(/include "common.yar"/) and',
      '    pe.imports("kernel32.dll", /include "second.yar"/) and',
      '    pe.exports(/* comment */ /include "after_comment.yar"/) and',
      "    (filesize / 2) > 0 and",
      "    pe.sections[0].raw_data_size / 2 > 0 and",
      "    filesize / 2 + 10 / 2 > 0 and",
      '    not /include "after_not.yar"/',
      "}",
      'include "real.yar"',
    ].join("\n");
    const whole = rewrite(input, "/rules/main.yar", "linux").toString("utf8");
    const streamed = rewrite(input, "/rules/main.yar", "linux", 1).toString(
      "utf8",
    );
    expect(streamed).toBe(whole);
    expect(whole).toContain('pe.exports(/include "common.yar"/)');
    expect(whole).toContain(
      'pe.imports("kernel32.dll", /include "second.yar"/)',
    );
    expect(whole).toContain(
      'pe.exports(/* comment */ /include "after_comment.yar"/)',
    );
    expect(whole).toContain("(filesize / 2) > 0");
    expect(whole).toContain("pe.sections[0].raw_data_size / 2 > 0");
    expect(whole).toContain("filesize / 2 + 10 / 2 > 0");
    expect(whole).toContain('not /include "after_not.yar"/');
    expect(whole).toContain('include "/rules/real.yar"');
    expect(whole.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("only rewrites top-level include directives outside rule bodies", () => {
    const input = [
      "rule Body {",
      "  strings:",
      "    $h = { 4D 5A }",
      "  condition:",
      '    $h and pe.exports(/include "inside_rule.yar"/)',
      "}",
      'include "top_level.yar"',
    ].join("\n");
    const output = rewrite(input, "/rules/main.yar", "linux").toString("utf8");
    expect(output).toContain('pe.exports(/include "inside_rule.yar"/)');
    expect(output).toContain('include "/rules/top_level.yar"');
  });

  it("produces identical output across 1-byte chunk boundaries and preserves non-UTF-8 bytes", () => {
    const prefix = Buffer.from("// ", "utf8");
    const rawBytes = Buffer.from([0xff, 0xfe, 0x80]);
    const rest = Buffer.from(
      '\ninclude "common.yar"\nrule R { condition: true }\n',
      "utf8",
    );
    const input = Buffer.concat([prefix, rawBytes, rest]);
    const whole = rewrite(input, "/rules/main.yar", "linux");
    const streamed = rewrite(input, "/rules/main.yar", "linux", 1);
    expect(streamed.equals(whole)).toBe(true);
    expect(streamed.subarray(3, 6).equals(rawBytes)).toBe(true);
    expect(streamed.toString("latin1")).toContain(
      'include "/rules/common.yar"',
    );
  });

  it("preserves non-UTF-8 bytes inside relative and absolute include filenames", () => {
    const rawRel = Buffer.from([
      0x66, 0x69, 0x6c, 0x65, 0xff, 0xfe, 0x2e, 0x79, 0x61, 0x72,
    ]);
    const rawAbs = Buffer.from([
      0x2f, 0x61, 0x62, 0x73, 0x2f, 0x80, 0xff, 0x2e, 0x79, 0x61, 0x72,
    ]);
    const input = Buffer.concat([
      Buffer.from('include "', "utf8"),
      rawRel,
      Buffer.from('"\ninclude "', "utf8"),
      rawAbs,
      Buffer.from('"\nrule R { condition: true }\n', "utf8"),
    ]);
    const expected = Buffer.concat([
      Buffer.from('include "/rules/', "utf8"),
      rawRel,
      Buffer.from('"\ninclude "', "utf8"),
      rawAbs,
      Buffer.from('"\nrule R { condition: true }\n', "utf8"),
    ]);
    const whole = rewrite(input, "/rules/main.yar", "linux");
    const streamed = rewrite(input, "/rules/main.yar", "linux", 1);
    expect(whole.equals(expected)).toBe(true);
    expect(streamed.equals(expected)).toBe(true);
  });

  it("stops before emitting rewritten bytes past maxOutputBytes on POSIX and Windows", () => {
    const longDir = `/rules/${"nested/".repeat(20)}main.yar`;
    const input = 'include "a.yar"\ninclude "b.yar"\n';
    const expected = rewrite(input, longDir, "linux");
    expect(expected.length).toBeGreaterThan(Buffer.byteLength(input));

    expect(
      rewrite(input, longDir, "linux", undefined, expected.length).equals(
        expected,
      ),
    ).toBe(true);
    expect(() =>
      rewrite(input, longDir, "linux", undefined, expected.length - 1),
    ).toThrow(ArtifactReaderFailure);
    expect(() =>
      rewrite(input, longDir, "linux", 1, expected.length - 1),
    ).toThrow(
      expect.objectContaining({
        reason: "limit",
        boundary: "file-size",
      }),
    );

    const winLongPath = `C:\\rules\\${"nested\\".repeat(20)}main.yar`;
    const winExpected = rewrite(input, winLongPath, "win32");
    expect(winExpected.length).toBeGreaterThan(Buffer.byteLength(input));
    expect(
      rewrite(
        input,
        winLongPath,
        "win32",
        undefined,
        winExpected.length,
      ).equals(winExpected),
    ).toBe(true);
    expect(() =>
      rewrite(input, winLongPath, "win32", undefined, winExpected.length - 1),
    ).toThrow(ArtifactReaderFailure);
  });
});
