import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";

import { projectForTest } from "../lib/test-projects.mjs";
import { mayGateTestToDarwin } from "./darwin-gate-candidates.mjs";

// Tests gated to macOS never run on the Linux lanes, so the macOS lane runs
// every one of them. A gate is a Vitest `skipIf`/`runIf` condition, or a
// `for`/`each` case list spread from a platform conditional, that statically
// excludes Linux and does not statically exclude macOS. The condition is
// evaluated from the parsed syntax with three-valued logic: a value that
// cannot be decided from literals, `process.platform` and module constants
// built from them, such as `process.arch`, stays unknown.

const UNKNOWN = Symbol("unknown");

const known = (value) => value !== UNKNOWN;

/** Top-level `const name = expression` bindings, the only names a gate may use. */
const moduleConstants = (program) => {
  const constants = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "const") continue;
    for (const { id, init } of declaration.declarations)
      if (id.type === "Identifier" && init) constants.set(id.name, init);
  }
  return constants;
};

const isProcessPlatform = (node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === "process" &&
  node.property.type === "Identifier" &&
  node.property.name === "platform";

/** Evaluate `node` on `platform`, returning UNKNOWN where syntax cannot decide. */
const evaluate = (node, platform, constants, resolving = new Set()) => {
  const visit = (child) => evaluate(child, platform, constants, resolving);
  switch (node.type) {
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return visit(node.expression);
    case "Identifier": {
      const init = constants.get(node.name);
      if (init === undefined || resolving.has(node.name)) return UNKNOWN;
      resolving.add(node.name);
      const value = visit(init);
      resolving.delete(node.name);
      return value;
    }
    case "MemberExpression":
      return isProcessPlatform(node) ? platform : UNKNOWN;
    case "UnaryExpression": {
      if (node.operator !== "!") return UNKNOWN;
      const value = visit(node.argument);
      return typeof value === "boolean" ? !value : UNKNOWN;
    }
    case "BinaryExpression": {
      const negated = node.operator === "!==" || node.operator === "!=";
      if (!negated && node.operator !== "===" && node.operator !== "==")
        return UNKNOWN;
      const left = visit(node.left);
      const right = visit(node.right);
      if (!known(left) || !known(right)) return UNKNOWN;
      return negated ? left !== right : left === right;
    }
    case "LogicalExpression": {
      const left = visit(node.left);
      const right = visit(node.right);
      if (node.operator === "&&") {
        if (left === false || right === false) return false;
        return left === true && right === true ? true : UNKNOWN;
      }
      if (node.operator === "||") {
        if (left === true || right === true) return true;
        return left === false && right === false ? false : UNKNOWN;
      }
      return UNKNOWN;
    }
    case "CallExpression": {
      // `["darwin", "linux"].includes(process.platform)`
      const { callee } = node;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "includes" ||
        callee.object.type !== "ArrayExpression" ||
        node.arguments.length !== 1
      )
        return UNKNOWN;
      const items = callee.object.elements.map((item) =>
        item === null ? UNKNOWN : visit(item),
      );
      const needle = visit(node.arguments[0]);
      if (!known(needle) || !items.every(known)) return UNKNOWN;
      return items.includes(needle);
    }
    default:
      return UNKNOWN;
  }
};

/** Whether a gate certainly skips on `platform`. */
const skipsOn = (gate, platform, constants) => {
  const value = evaluate(gate.condition, platform, constants);
  return gate.kind === "skipIf" ? value === true : value === false;
};

const isEmptyArray = (node) =>
  node.type === "ArrayExpression" && node.elements.length === 0;

const calleeMethod = (node) =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier"
    ? node.callee.property.name
    : undefined;

/**
 * Whether one test module has a test that runs on macOS but never on Linux.
 * `source` is TypeScript module text; a syntax error is thrown, not ignored.
 */
export const isDarwinGatedTestSource = (source) => {
  if (!mayGateTestToDarwin(source)) return false;
  const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const constants = moduleConstants(tree.program);
  let gated = false;
  traverseFast(tree.program, (node) => {
    if (gated) return;
    const method = calleeMethod(node);
    if ((method === "skipIf" || method === "runIf") && node.arguments[0]) {
      const gate = { kind: method, condition: node.arguments[0] };
      gated =
        skipsOn(gate, "linux", constants) &&
        !skipsOn(gate, "darwin", constants);
      return;
    }
    if ((method === "for" || method === "each") && node.arguments[0])
      traverseFast(node.arguments[0], (child) => {
        // `...(process.platform === "darwin" ? [cases] : [])`. The candidate
        // filter admits only a conditional that names the platform literal.
        if (gated || child.type !== "ConditionalExpression") return;
        const linux = evaluate(child.test, "linux", constants);
        const darwin = evaluate(child.test, "darwin", constants);
        if (typeof linux !== "boolean" || typeof darwin !== "boolean") return;
        if (linux === darwin) return;
        const onLinux = linux ? child.consequent : child.alternate;
        const onDarwin = darwin ? child.consequent : child.alternate;
        gated = isEmptyArray(onLinux) && !isEmptyArray(onDarwin);
      });
  });
  return gated;
};

/** Tracked test paths in `root` whose modules gate a test to macOS, sorted. */
export const darwinGatedTests = (root) => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.test.ts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0);
  const gated = [];
  for (const path of tracked) {
    let source;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch (cause) {
      // A tracked deletion that is not yet committed has nothing to run.
      if (cause?.code === "ENOENT") continue;
      throw cause;
    }
    let isGated;
    try {
      isGated = isDarwinGatedTestSource(source);
    } catch (cause) {
      throw new Error(`Could not parse ${path}`, { cause });
    }
    if (!isGated) continue;
    // A test path the runner cannot select by shell word, or that no Vitest
    // project owns, would silently drop from the run.
    if (/\s/u.test(path))
      throw new Error(`Darwin-gated test path contains whitespace: ${path}`);
    projectForTest(path);
    gated.push(path);
  }
  return gated.sort();
};

const main = () => {
  const tests = darwinGatedTests(process.cwd());
  if (tests.length === 0)
    throw new Error("No darwin-gated test files were discovered.");
  process.stdout.write(`${tests.join("\n")}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
