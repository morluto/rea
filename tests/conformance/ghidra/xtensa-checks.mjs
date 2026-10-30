import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const XTENSA_LANGUAGE = "Xtensa:LE:32:default";
export const XTENSA_COMPILER_SPEC = "default";

const field = (text, expression, label) => {
  const matches = [...text.matchAll(expression)];
  assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
  return matches[0][1].trim();
};

/**
 * Parse the GNU or LLVM `readelf -h -s -n -W` fields the lane compares with
 * REA: header declarations, symbol values, and the `Xtensa_Info` note text.
 */
export function parseXtensaReadelf(text, names) {
  assert.equal(field(text, /^\s*Class:\s*(.+)$/gmu, "class"), "ELF32");
  const byteOrder = field(
    text,
    /^\s*Data:.*?,\s*(little|big) endian\s*$/gmu,
    "byte order",
  );
  assert.match(field(text, /^\s*Type:\s*(.+)$/gmu, "type"), /^EXEC\b/u);
  assert.match(field(text, /^\s*Machine:\s*(.+)$/gmu, "machine"), /Xtensa/u);
  const flags = Number(field(text, /^\s*Flags:\s*(0x[\da-f]+)/gmu, "flags"));
  const symbols = {};
  for (const name of names) {
    const value = field(
      text,
      new RegExp(
        `^\\s*\\d+:\\s+([\\da-f]+)\\s+\\d+\\s+(?:FUNC|OBJECT)\\s+GLOBAL\\s+\\S+\\s+\\d+\\s+${name}\\s*$`,
        "gmu",
      ),
      `symbol ${name}`,
    );
    symbols[name] = `0x${BigInt(`0x${value}`).toString(16)}`;
  }
  const note = field(
    text,
    /^\s*Xtensa_Info\s+0x[\da-f]+\s+.*?description data:\s*((?:[\da-f]{2}\s*)+)$/gmsu,
    "Xtensa_Info note",
  );
  const descriptor = Buffer.from(note.replaceAll(/\s+/gu, ""), "hex")
    .toString("latin1")
    .replace(/\0+$/u, "");
  const abiLine = descriptor
    .split("\n")
    .find((line) => line.startsWith("ABI="));
  assert.ok(abiLine, "Xtensa_Info note declares no ABI");
  return {
    xtensa: {
      elfClass: 32,
      byteOrder,
      type: 2,
      flags,
      abi: {
        status: "declared",
        abi: abiLine === "ABI=0" ? "windowed" : "call0",
      },
    },
    symbols,
    descriptor,
  };
}

/** Independent reader is a bounded lane prerequisite, never an REA provider. */
export async function inspectXtensaReadelf(path, names) {
  const command = process.env.REA_XTENSA_READELF ?? "readelf";
  const options = {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  };
  const version = await execute(command, ["--version"], options);
  assert.match(
    version.stdout,
    /\b(?:GNU readelf|LLVM)\b/u,
    "This lane requires GNU or LLVM readelf",
  );
  const result = await execute(
    command,
    ["-h", "-s", "-n", "-W", path],
    options,
  );
  assert.equal(result.stderr.trim(), "", "Unexpected readelf diagnostics");
  return {
    ...parseXtensaReadelf(result.stdout, names),
    command,
    version: version.stdout.split("\n")[0].trim(),
  };
}

/** Decoded fixture instructions, as annotated in xtensa-fixture.mjs. */
export function assertXtensaFixtureInstructions(instructions, addresses) {
  const at = (name) => instructions[name];
  for (const [name, mnemonic, bytes] of [
    ["entry", "entry", "364100"],
    ["l32r", "l32r", "a1feff"],
    ["call8", "call8", "a50000"],
    ["retw", "retw.n", "1df0"],
  ]) {
    assert.equal(at(name).status, "decoded", `${name} was not decoded`);
    assert.equal(at(name).architecture, XTENSA_LANGUAGE);
    assert.equal(at(name).mnemonic?.toLowerCase(), mnemonic);
    assert.equal(at(name).bytes, bytes);
  }
  assert.equal(at("call8").flow.kind, "call");
  assert.deepEqual(
    at("call8").flow.direct_destinations.map((value) => BigInt(value)),
    [BigInt(addresses.leaf)],
  );
  assert.equal(at("retw").flow.kind, "return");
  // The literal load reads the word below it; Ghidra records that read.
  assert.ok(
    at("l32r").references.some(
      (reference) =>
        BigInt(reference.target_address) === BigInt(addresses.literal),
    ),
    `l32r has no reference to its literal: ${JSON.stringify(at("l32r").references)}`,
  );
}

const RETURN = /^return\b(.*)$/su;
const ASSIGNMENT = /^(\w+)\s*=(?!=)(.*)$/su;
/** A cast Ghidra prints before an operand, such as `(int)` or `(uint *)`. */
const CAST =
  /^\(\s*[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*(?:\s*\*)*\s*\)\s*(?=[\w(])/u;
const INTEGER = /^(0x[\da-f]+|\d+)[lu]*$/iu;

const closingParenthesis = (text, open) => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/** Operands separated by `separator` outside parentheses. */
const topLevel = (text, separator) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
    else if (depth === 0 && text[index] === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
};

/** An operand without casts or enclosing parentheses: an integer or its text. */
const operand = (text) => {
  const value = text.trim();
  const cast = CAST.exec(value);
  if (cast !== null) return operand(value.slice(cast[0].length));
  if (
    value.startsWith("(") &&
    closingParenthesis(value, 0) === value.length - 1
  )
    return operand(value.slice(1, -1));
  const integer = INTEGER.exec(value);
  return integer === null ? value : BigInt(integer[1]);
};

/**
 * Whether `text` computes `expected`: an operand, or `[operator, left, right]`
 * for a commutative `+` or `*`. Expected trees nest `*` under `+` only.
 */
const computes = (text, expected) => {
  if (!Array.isArray(expected)) return operand(text) === expected;
  const value = operand(text);
  if (typeof value !== "string") return false;
  const [operator, left, right] = expected;
  const parts = topLevel(value, operator);
  return (
    parts.length === 2 &&
    ((computes(parts[0], left) && computes(parts[1], right)) ||
      (computes(parts[0], right) && computes(parts[1], left)))
  );
};

/** Parameter names and statements of a straight-line decompiled function. */
const decompiledFunction = (code, name) => {
  const match = new RegExp(
    `\\b${name}\\s*\\(([^)]*)\\)\\s*\\{([^{}]*)\\}`,
    "u",
  ).exec(code.replaceAll(/\/\*[^]*?\*\//gu, " "));
  assert.ok(match, `${name} is not one straight-line function: ${code}`);
  return {
    parameters: match[1]
      .split(",")
      .map((parameter) => /(\w+)\s*$/u.exec(parameter)?.[1])
      .filter((parameter) => parameter !== undefined && parameter !== "void"),
    statements: match[2]
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== ""),
  };
};

/** The single expression a straight-line function returns. */
const returnedExpression = (code, name) => {
  const { parameters, statements } = decompiledFunction(code, name);
  const returns = statements
    .map((statement) => RETURN.exec(statement))
    .filter((match) => match !== null);
  assert.equal(returns.length, 1, `${name} must return once: ${code}`);
  return { parameters, expression: returns[0][1] };
};

/** The statement returns `call`, or assigns it to a temporary returned later. */
const returnsResult = (statements, index, call) => {
  const direct = RETURN.exec(statements[index]);
  if (direct !== null) return operand(direct[1]) === call;
  const assignment = ASSIGNMENT.exec(statements[index]);
  if (assignment === null || operand(assignment[2]) !== call) return false;
  const [, temporary] = assignment;
  const reassigned = new RegExp(
    `^${temporary}\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)`,
    "u",
  );
  for (const statement of statements.slice(index + 1)) {
    const returned = RETURN.exec(statement);
    if (returned !== null) return operand(returned[1]) === temporary;
    if (reassigned.test(statement)) return false;
  }
  return false;
};

const display = (value) =>
  typeof value === "bigint" ? `0x${value.toString(16)}` : value;

/**
 * The caller calls `callee` once with exactly `args` and returns its result,
 * directly or through a temporary; Ghidra prints either form.
 */
const assertReturnedCall = (code, { caller, callee, args }) => {
  const { statements } = decompiledFunction(code, caller);
  const calls = statements.flatMap((statement, index) =>
    [...statement.matchAll(new RegExp(`\\b${callee}\\s*\\(`, "gu"))].map(
      (match) => ({
        index,
        start: match.index,
        open: match.index + match[0].length - 1,
      }),
    ),
  );
  assert.equal(calls.length, 1, `${caller} must call ${callee} once: ${code}`);
  const [{ index, start, open }] = calls;
  const statement = statements[index];
  const close = closingParenthesis(statement, open);
  assert.notEqual(close, -1, `${caller} has an unbalanced call: ${code}`);
  const list = statement.slice(open + 1, close);
  assert.deepEqual(
    list.trim() === "" ? [] : topLevel(list, ",").map(operand),
    args,
    `${caller} must pass ${args.map(display).join(", ")} to ${callee}: ${code}`,
  );
  assert.ok(
    returnsResult(statements, index, statement.slice(start, close + 1)),
    `${caller} must return the ${callee} result: ${code}`,
  );
};

/**
 * The windowed caller passes the l32r literal through call8 (a10 becomes the
 * callee's a2) and returns the callee's result; the leaf adds its addend.
 */
export function assertXtensaFixturePseudocode(entry, leaf, values) {
  const callee = returnedExpression(leaf, "rea_xtensa_leaf");
  assert.ok(
    computes(callee.expression, [
      "+",
      callee.parameters[0],
      BigInt(values.addend),
    ]),
    `rea_xtensa_leaf must return its argument plus ${values.addend}: ${leaf}`,
  );
  assertReturnedCall(entry, {
    caller: "rea_xtensa_entry",
    callee: "rea_xtensa_leaf",
    args: [BigInt(values.literal)],
  });
}

/**
 * The C caller passes the volatile global and the factor through call8 and
 * returns the result; the callee adds its l32r constant to the product.
 */
export function assertXtensaCFixturePseudocode(entry, scale, values) {
  const callee = returnedExpression(scale, "rea_xtensa_c_scale");
  const [value, factor] = callee.parameters;
  assert.ok(
    computes(callee.expression, [
      "+",
      ["*", value, factor],
      BigInt(values.constant),
    ]),
    `rea_xtensa_c_scale must return value * factor + ${display(BigInt(values.constant))}: ${scale}`,
  );
  assertReturnedCall(entry, {
    caller: "rea_xtensa_c_entry",
    callee: "rea_xtensa_c_scale",
    args: [values.global, BigInt(values.factor)],
  });
}
