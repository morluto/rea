// Shared Darwin gate facts for CI planning and Apple test discovery.
//
// The planning job runs before dependencies are installed, so it cannot load
// the Babel parser used by darwin-gated-tests.mjs. This module is the
// dependency-free owner of the gate expression facts both sides evaluate:
// Apple discovery converts its Babel AST to these facts, and planning parses
// the narrow top-level registration grammar directly into the same facts.
// A gate value that cannot be decided from string or boolean literals,
// `process.platform`, and module constants built from them stays unknown.
// Template literals are unknown, matching Apple discovery.

export const UNKNOWN = Symbol("unknown");

const known = (value) => value !== UNKNOWN;
const unknownExpression = { type: "unknown" };

/** Evaluate a gate expression fact on `platform`. */
export const evaluateGateExpression = (
  expression,
  platform,
  constants,
  resolving = new Set(),
) => {
  const visit = (child) =>
    evaluateGateExpression(child, platform, constants, resolving);
  switch (expression.type) {
    case "literal":
      return expression.value;
    case "identifier": {
      const init = constants.get(expression.name);
      if (init === undefined || resolving.has(expression.name)) return UNKNOWN;
      resolving.add(expression.name);
      const value = visit(init);
      resolving.delete(expression.name);
      return value;
    }
    case "platform":
      return platform;
    case "unary": {
      const value = visit(expression.argument);
      return typeof value === "boolean" ? !value : UNKNOWN;
    }
    case "binary": {
      const negated =
        expression.operator === "!==" || expression.operator === "!=";
      if (
        !negated &&
        expression.operator !== "===" &&
        expression.operator !== "=="
      )
        return UNKNOWN;
      const left = visit(expression.left);
      const right = visit(expression.right);
      if (!known(left) || !known(right)) return UNKNOWN;
      return negated ? left !== right : left === right;
    }
    case "logical": {
      const left = visit(expression.left);
      const right = visit(expression.right);
      if (expression.operator === "&&") {
        if (left === false || right === false) return false;
        return left === true && right === true ? true : UNKNOWN;
      }
      if (expression.operator === "||") {
        if (left === true || right === true) return true;
        return left === false && right === false ? false : UNKNOWN;
      }
      return UNKNOWN;
    }
    case "includes": {
      const items = expression.items.map(visit);
      const needle = visit(expression.needle);
      if (!known(needle) || !items.every(known)) return UNKNOWN;
      return items.includes(needle);
    }
    default:
      return UNKNOWN;
  }
};

/** Whether a gate certainly skips on `platform`. */
export const gateSkipsOn = (kind, expression, platform, constants) => {
  const value = evaluateGateExpression(expression, platform, constants);
  return kind === "skipIf" ? value === true : value === false;
};

const arrayEmptiness = (
  expression,
  platform,
  constants,
  resolving = new Set(),
) => {
  switch (expression.type) {
    case "array": {
      let uncertain = false;
      for (const element of expression.elements) {
        if (!element.spread) return false;
        const emptiness = arrayEmptiness(
          element.expression,
          platform,
          constants,
          resolving,
        );
        if (emptiness === false) return false;
        if (emptiness === UNKNOWN) uncertain = true;
      }
      return uncertain ? UNKNOWN : true;
    }
    case "conditional": {
      const test = evaluateGateExpression(expression.test, platform, constants);
      if (typeof test !== "boolean") return UNKNOWN;
      return arrayEmptiness(
        test ? expression.consequent : expression.alternate,
        platform,
        constants,
        resolving,
      );
    }
    case "identifier": {
      const init = constants.get(expression.name);
      if (init === undefined || resolving.has(expression.name)) return UNKNOWN;
      resolving.add(expression.name);
      const emptiness = arrayEmptiness(init, platform, constants, resolving);
      resolving.delete(expression.name);
      return emptiness;
    }
    default:
      return UNKNOWN;
  }
};

class ParseError extends Error {}

const isIdentifierStart = (char) => /[A-Za-z_$]/u.test(char);
const isIdentifierPart = (char) => /[A-Za-z0-9_$]/u.test(char);
const REGEX_KEYWORDS = new Set([
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
]);
const PUNCTUATORS = [
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>>=",
  ">>=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**",
  "<<",
  ">>>",
  ">>",
  "&=",
  "|=",
  "^=",
];

const tokenize = (source) => {
  const tokens = [];
  let index = 0;
  const fail = () => {
    throw new ParseError("Could not tokenize test source");
  };
  const regexAllowed = () => {
    const previous = tokens.at(-1);
    if (previous === undefined) return true;
    if (previous.type === "id") return REGEX_KEYWORDS.has(previous.value);
    if (previous.type !== "punct") return false;
    return !["++", "--", ")", "]", "}"].includes(previous.value);
  };
  const scanString = (quote) => {
    index += 1;
    let value = "";
    while (index < source.length) {
      const char = source[index];
      if (char === quote) {
        index += 1;
        return value;
      }
      if (char === "\n" || char === "\r") fail();
      if (char !== "\\") {
        value += char;
        index += 1;
        continue;
      }
      index += 1;
      if (index >= source.length) fail();
      const escaped = source[index];
      index += 1;
      value +=
        escaped === "n"
          ? "\n"
          : escaped === "r"
            ? "\r"
            : escaped === "t"
              ? "\t"
              : escaped;
    }
    fail();
  };
  const scanTemplate = () => {
    index += 1;
    let hasExpression = false;
    while (index < source.length) {
      const char = source[index];
      if (char === "`") {
        index += 1;
        return hasExpression;
      }
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "$" && source[index + 1] === "{") {
        hasExpression = true;
        index += 2;
        let depth = 1;
        while (index < source.length && depth > 0) {
          const inner = source[index];
          if (inner === '"' || inner === "'") {
            scanString(inner);
            continue;
          }
          if (inner === "`") {
            scanTemplate();
            continue;
          }
          if (inner === "/" && source[index + 1] === "/") {
            while (index < source.length && source[index] !== "\n") index += 1;
            continue;
          }
          if (inner === "/" && source[index + 1] === "*") {
            const end = source.indexOf("*/", index + 2);
            if (end === -1) fail();
            index = end + 2;
            continue;
          }
          if (inner === "{") depth += 1;
          if (inner === "}") depth -= 1;
          index += 1;
        }
        if (depth !== 0) fail();
        continue;
      }
      index += 1;
    }
    fail();
  };
  const scanRegex = () => {
    index += 1;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      if (char === "/" && !inClass) {
        index += 1;
        while (index < source.length && isIdentifierPart(source[index]))
          index += 1;
        return;
      }
      if (char === "\n" || char === "\r") fail();
      index += 1;
    }
    fail();
  };
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) fail();
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      tokens.push({ type: "string", value: scanString(char) });
      continue;
    }
    if (char === "`") {
      tokens.push({ type: "template", value: scanTemplate() });
      continue;
    }
    if (char === "/" && regexAllowed()) {
      scanRegex();
      tokens.push({ type: "regex", value: "/" });
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index]))
        index += 1;
      tokens.push({ type: "id", value: source.slice(start, index) });
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const start = index;
      index += 1;
      while (
        index < source.length &&
        (isIdentifierPart(source[index]) || source[index] === ".")
      )
        index += 1;
      tokens.push({ type: "number", value: source.slice(start, index) });
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (punctuator !== undefined) {
      tokens.push({ type: "punct", value: punctuator });
      index += punctuator.length;
      continue;
    }
    tokens.push({ type: "punct", value: char });
    index += 1;
  }
  return tokens;
};

const REGISTRATIONS = new Set(["describe", "it", "test"]);
const HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const CHAIN_MODIFIERS = new Set(["concurrent", "fails", "only", "sequential"]);
const BINARY_PRECEDENCE = new Map([
  ["||", 1],
  ["&&", 2],
  ["===", 3],
  ["!==", 3],
  ["==", 3],
  ["!=", 3],
  ["<", 4],
  [">", 4],
  ["<=", 4],
  [">=", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
]);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.position = 0;
    this.constants = new Map();
  }

  peek(offset = 0) {
    return this.tokens[this.position + offset];
  }

  next() {
    const token = this.peek();
    if (token === undefined) throw new ParseError("Unexpected end of source");
    this.position += 1;
    return token;
  }

  at(value) {
    return this.peek()?.value === value;
  }

  match(value) {
    if (!this.at(value)) return false;
    this.position += 1;
    return true;
  }

  expect(value) {
    if (!this.match(value)) throw new ParseError(`Expected ${value}`);
  }

  expectIdentifier() {
    const token = this.next();
    if (token.type !== "id") throw new ParseError("Expected identifier");
    return token.value;
  }

  skipBalanced(open, close) {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.value === open) depth += 1;
      if (token.value === close) depth -= 1;
    }
  }

  skipToSemicolon() {
    let depth = 0;
    while (this.peek() !== undefined) {
      const token = this.next();
      if (["(", "[", "{"].includes(token.value)) depth += 1;
      if ([")", "]", "}"].includes(token.value)) depth -= 1;
      if (token.value === ";" && depth === 0) return;
      if (depth < 0) throw new ParseError("Unbalanced statement");
    }
  }

  skipDeclaration() {
    let depth = 0;
    let sawBrace = false;
    while (this.peek() !== undefined) {
      const token = this.next();
      if (["(", "["].includes(token.value)) depth += 1;
      if ([")", "]"].includes(token.value)) depth -= 1;
      if (token.value === "{") {
        depth += 1;
        sawBrace = true;
      }
      if (token.value === "}") {
        depth -= 1;
        if (sawBrace && depth === 0) {
          this.match(";");
          return;
        }
      }
      if (token.value === ";" && depth === 0) return;
      if (depth < 0) throw new ParseError("Unbalanced declaration");
    }
  }

  skipType() {
    let angleDepth = 0;
    let depth = 0;
    while (this.peek() !== undefined) {
      const token = this.peek();
      if (depth === 0 && angleDepth === 0) {
        if (
          [
            "=",
            ";",
            ",",
            ")",
            "]",
            "}",
            "===",
            "!==",
            "==",
            "!=",
            "&&",
            "||",
            "??",
            "=>",
          ].includes(token.value)
        )
          return;
      }
      this.next();
      if (token.value === "<") angleDepth += 1;
      if (token.value === ">") angleDepth = Math.max(0, angleDepth - 1);
      if (["(", "[", "{"].includes(token.value)) depth += 1;
      if ([")", "]", "}"].includes(token.value)) depth -= 1;
    }
  }

  parseExpression() {
    const expression = this.parseBinary(1);
    if (!this.match("?")) return expression;
    const consequent = this.parseExpression();
    this.expect(":");
    const alternate = this.parseExpression();
    return { type: "conditional", test: expression, consequent, alternate };
  }

  parseBinary(minimumPrecedence) {
    let left = this.parseUnary();
    while (true) {
      const operator = this.peek()?.value;
      const precedence = BINARY_PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minimumPrecedence)
        return left;
      this.next();
      const right = this.parseBinary(precedence + 1);
      if (["===", "!==", "==", "!="].includes(operator))
        left = { type: "binary", operator, left, right };
      else if (operator === "&&" || operator === "||")
        left = { type: "logical", operator, left, right };
      else left = unknownExpression;
    }
  }

  parseUnary() {
    if (this.match("!")) return { type: "unary", argument: this.parseUnary() };
    if (["-", "+", "~"].includes(this.peek()?.value)) {
      this.next();
      this.parseUnary();
      return unknownExpression;
    }
    if (["typeof", "void", "delete"].includes(this.peek()?.value)) {
      this.next();
      this.parseUnary();
      return unknownExpression;
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePrimary() {
    const token = this.next();
    if (token.type === "string") return { type: "literal", value: token.value };
    if (
      token.type === "template" ||
      token.type === "number" ||
      token.type === "regex"
    )
      return unknownExpression;
    if (token.type === "id") {
      if (token.value === "true") return { type: "literal", value: true };
      if (token.value === "false") return { type: "literal", value: false };
      if (token.value === "null" || token.value === "undefined")
        return unknownExpression;
      return { type: "identifier", name: token.value };
    }
    if (token.value === "(") {
      const expression = this.parseExpression();
      this.expect(")");
      return expression;
    }
    if (token.value === "[") {
      const elements = [];
      while (!this.at("]")) {
        const spread = this.match("...");
        elements.push({ spread, expression: this.parseExpression() });
        if (!this.match(",")) break;
      }
      this.expect("]");
      return { type: "array", elements };
    }
    if (token.value === "{") {
      this.position -= 1;
      this.skipBalanced("{", "}");
      return unknownExpression;
    }
    throw new ParseError("Expected expression");
  }

  parsePostfix(expression) {
    let current = expression;
    while (true) {
      if (this.match(".") || this.match("?.")) {
        const property = this.expectIdentifier();
        current =
          current.type === "identifier" &&
          current.name === "process" &&
          property === "platform"
            ? { type: "platform" }
            : { type: "member", object: current, property };
        continue;
      }
      if (this.at("(")) {
        this.next();
        const args = [];
        while (!this.at(")")) {
          args.push(this.parseExpression());
          if (!this.match(",")) break;
        }
        this.expect(")");
        current =
          current.type === "member" &&
          current.property === "includes" &&
          current.object.type === "array" &&
          args.length === 1
            ? {
                type: "includes",
                items: current.object.elements.map((element) =>
                  element.spread ? unknownExpression : element.expression,
                ),
                needle: args[0],
              }
            : unknownExpression;
        continue;
      }
      if (this.at("[")) {
        this.skipBalanced("[", "]");
        current = unknownExpression;
        continue;
      }
      if (this.at("!") && this.peek(1)?.value !== "=") {
        this.next();
        continue;
      }
      if (this.at("as") || this.at("satisfies")) {
        this.next();
        this.skipType();
        continue;
      }
      return current;
    }
  }

  parseVariableDeclaration() {
    const kind = this.expectIdentifier();
    while (true) {
      let name;
      if (this.peek()?.type === "id") name = this.next().value;
      else if (this.at("{")) this.skipBalanced("{", "}");
      else if (this.at("[")) this.skipBalanced("[", "]");
      else throw new ParseError("Expected variable name");
      if (this.match(":")) this.skipType();
      if (this.match("=")) {
        const expression = this.parseExpression();
        if (kind === "const" && name !== undefined)
          this.constants.set(name, expression);
      }
      if (!this.match(",")) break;
    }
    this.expect(";");
  }

  scanExpressionStatement() {
    let depth = 0;
    let hasCall = false;
    let previous;
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token.value === "(" && depth === 0) {
        if (
          previous?.type === "id" ||
          previous?.value === ")" ||
          previous?.value === "]"
        )
          hasCall = true;
      }
      if (["(", "[", "{"].includes(token.value)) depth += 1;
      if ([")", "]", "}"].includes(token.value)) depth -= 1;
      if (token.value === ";" && depth === 0) return hasCall;
      if (depth < 0) throw new ParseError("Unbalanced statement");
      previous = token;
    }
    throw new ParseError("Unterminated statement");
  }

  parseRegistration() {
    this.expectIdentifier();
    const gates = [];
    let cases;
    let unconditionalSkip = false;
    while (true) {
      if (this.match(".")) {
        const member = this.expectIdentifier();
        if (member === "skipIf" || member === "runIf") {
          this.expect("(");
          gates.push({ kind: member, expression: this.parseExpression() });
          this.match(",");
          this.expect(")");
          continue;
        }
        if (member === "for" || member === "each") {
          if (cases !== undefined) return false;
          this.expect("(");
          cases = this.parseExpression();
          this.match(",");
          this.expect(")");
          continue;
        }
        if (member === "skip" || member === "todo") {
          unconditionalSkip = true;
          continue;
        }
        if (CHAIN_MODIFIERS.has(member)) continue;
        return false;
      }
      if (this.at("(")) {
        this.skipBalanced("(", ")");
        this.match(";");
        break;
      }
      return false;
    }
    if (unconditionalSkip) return false;
    if (gates.length === 0 && cases === undefined) return false;
    const runsOn = (platform) => {
      const gateSkips = gates.some((gate) =>
        gateSkipsOn(gate.kind, gate.expression, platform, this.constants),
      );
      if (gateSkips) return false;
      if (cases === undefined) return true;
      const emptiness = arrayEmptiness(cases, platform, this.constants);
      if (emptiness === true) return false;
      if (emptiness === false) return true;
      return UNKNOWN;
    };
    if (runsOn("linux") !== false) return false;
    if (runsOn("darwin") === false) return false;
    if (
      cases !== undefined &&
      arrayEmptiness(cases, "darwin", this.constants) !== false
    )
      return false;
    return true;
  }

  parseTopLevel() {
    let gated = false;
    while (this.peek() !== undefined) {
      const token = this.peek();
      if (this.match(";")) continue;
      if (token.type === "string" || token.type === "template") {
        this.next();
        this.match(";");
        continue;
      }
      if (token.value === "import") {
        this.skipToSemicolon();
        continue;
      }
      if (token.value === "export") {
        const next = this.peek(1)?.value;
        if (["const", "let", "var"].includes(next)) {
          this.next();
          this.parseVariableDeclaration();
        } else this.skipDeclaration();
        continue;
      }
      if (["const", "let", "var"].includes(token.value)) {
        this.parseVariableDeclaration();
        continue;
      }
      if (
        [
          "abstract",
          "async",
          "class",
          "declare",
          "enum",
          "function",
          "interface",
          "namespace",
          "type",
        ].includes(token.value)
      ) {
        this.skipDeclaration();
        continue;
      }
      if (token.type !== "id") throw new ParseError("Unsupported statement");
      if (REGISTRATIONS.has(token.value)) {
        if (!this.parseRegistration()) return false;
        gated = true;
        continue;
      }
      if (HOOKS.has(token.value) || token.value === "vi") {
        this.scanExpressionStatement();
        continue;
      }
      if (this.scanExpressionStatement()) return false;
    }
    return gated;
  }
}

/** Whether every test a module registers certainly skips on Linux. */
export const isMacOsOnlyTestSource = (source) => {
  try {
    return new Parser(tokenize(source)).parseTopLevel();
  } catch {
    return false;
  }
};
