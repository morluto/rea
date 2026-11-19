/** ECMAScript WhiteSpace and LineTerminator, used when recognizing and reading key files. */
export const DESKTOP_SYNTAX_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const DESKTOP_LINE_BREAK = String.raw`\r?\n`;
export const KEYFILE_GROUP = String.raw`^\[([^\]]+)\]$`;
export const KEYFILE_COMMENT_PREFIXES = "#;";
export const KEYFILE_VALUE_PADDING = " \t";
