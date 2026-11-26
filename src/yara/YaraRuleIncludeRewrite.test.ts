import { describe, expect, it } from "vitest";

import { createYaraIncludeRewriter } from "./YaraRuleIncludeRewrite.js";

const rewrite = (
  source: string | Buffer,
  sourcePath: string,
  platform: NodeJS.Platform = "linux",
  chunkSize?: number,
): Buffer => {
  const input =
    typeof source === "string" ? Buffer.from(source, "utf8") : source;
  const rewriter = createYaraIncludeRewriter(sourcePath, platform);
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
  it("resolves relative POSIX includes against the rule file directory and keeps absolute ones", () => {
    const input = [
      'include "common.yar"',
      'include\t"sub/nested.yar"',
      'include "../shared/base.yar"',
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
        'include "/rules/shared/base.yar"',
        'include "/abs/other.yar"',
        "rule Main { condition: true }",
      ].join("\n"),
    );
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
});
