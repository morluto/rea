/**
 * Rule sources with the include paths libyara actually asked to open, recorded
 * with yara-python 4.5.4 (libyara 4.5.4) through `yara.compile(source=...,
 * include_callback=...)`: the callback runs when the lexer starts a
 * directive, so `opened` is yara's own answer, not the scanner's. Paths
 * named `s*.yar` are sentinels after the case, showing yara lexed past it;
 * `n*.yar` must never be opened; `t*.yar` must be.
 */
export const YARA_INCLUDE_LEXER_CASES: readonly {
  readonly name: string;
  readonly text: string;
  readonly opened: readonly string[];
}[] = [
  {
    name: "top-level",
    text: 'include "t1.yar"\nrule A { condition: true }\n',
    opened: ["t1.yar"],
  },
  {
    name: "rule-body",
    text: 'rule A { condition: true or include "t2.yar" true }\n',
    opened: ["t2.yar"],
  },
  {
    name: "after-dot",
    text: 'import "pe"\nrule A { condition: pe.include "t3.yar" }\n',
    opened: ["t3.yar"],
  },
  {
    name: "after-paren",
    text: 'rule A { condition: (include "t4.yar" true) }\n',
    opened: ["t4.yar"],
  },
  {
    name: "tab-separated",
    text: 'include\t\t"t5.yar"\nrule A { condition: true }\n',
    opened: ["t5.yar"],
  },
  {
    name: "line-comment",
    text: '// include "n1.yar"\nrule A { condition: true }\ninclude "s1.yar"\n',
    opened: ["s1.yar"],
  },
  {
    name: "block-comment",
    text: '/* include "n2.yar"\n include "n3.yar" */\nrule A { condition: true }\ninclude "s2.yar"\n',
    opened: ["s2.yar"],
  },
  {
    name: "text-string",
    text: 'rule A { strings: $a = "include \\"n4.yar\\"" condition: $a }\ninclude "s3.yar"\n',
    opened: ["s3.yar"],
  },
  {
    name: "regex",
    text: 'rule A { strings: $a = /include "n5.yar"/ condition: $a }\ninclude "s4.yar"\n',
    opened: ["s4.yar"],
  },
  {
    name: "regex-escaped-slash",
    text: 'rule A { strings: $a = /a\\/include "n6.yar"/is condition: $a }\ninclude "s5.yar"\n',
    opened: ["s5.yar"],
  },
  {
    name: "hex-comment",
    text: 'rule A { strings: $a = { 4D 5A /* include "n7.yar" */ } condition: $a }\ninclude "s6.yar"\n',
    opened: ["s6.yar"],
  },
  {
    name: "string-identifier",
    text: 'rule A { strings: $include = "a" condition: $include }\ninclude "s7.yar"\n',
    opened: ["s7.yar"],
  },
  {
    name: "longer-identifier",
    text: 'rule A { condition: true }\nrule xinclude { condition: true }\ninclude "s8.yar"\n',
    opened: ["s8.yar"],
  },
  {
    name: "no-space",
    text: 'rule A { strings: $a = "x" condition: $a }\ninclude"n8.yar"\n',
    opened: [],
  },
  {
    name: "newline-before-quote",
    text: 'rule A { condition: true }\ninclude\n"n9.yar"\n',
    opened: [],
  },
  {
    name: "after-hex-number",
    text: 'rule A { condition: 0xABinclude "t6.yar" == 171 }\n',
    opened: ["t6.yar"],
  },
  {
    name: "after-octal-number",
    text: 'rule A { condition: 0o17include "t7.yar" == 15 }\n',
    opened: ["t7.yar"],
  },
  {
    name: "after-size-unit",
    text: 'rule A { condition: filesize < 5MBinclude "t8.yar" }\n',
    opened: ["t8.yar"],
  },
  {
    name: "after-decimal",
    text: 'rule A { condition: 5include "t9.yar" == 5 }\n',
    opened: ["t9.yar"],
  },
  {
    name: "after-float",
    text: 'rule A { condition: 1.5include "t10.yar" == 1.5 }\n',
    opened: ["t10.yar"],
  },
  {
    name: "zero-x-identifier",
    text: 'rule A { condition: 0xinclude "n10.yar" }\n',
    opened: [],
  },
  {
    name: "regex-flag-i",
    text: 'rule A { strings: $a = /x/include "n11.yar" condition: $a }\n',
    opened: [],
  },
  {
    name: "regex-flags-is",
    text: 'rule A { strings: $a = /x/isinclude "t11.yar" condition: $a }\n',
    opened: ["t11.yar"],
  },
  {
    name: "regex-then-space",
    text: 'rule A { strings: $a = /x/ include "t12.yar" condition: $a }\n',
    opened: ["t12.yar"],
  },
];
