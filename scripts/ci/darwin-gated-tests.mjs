import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";

import { projectForTest } from "../lib/test-projects.mjs";
import { mayGateTestToDarwin } from "./darwin-gate-candidates.mjs";
import { evaluateGateExpression, gateSkipsOn } from "./darwin-gate-facts.mjs";

// Tests gated to macOS never run on the Linux lanes, so the macOS lane runs
// every one of them. A gate is a Vitest `skipIf`/`runIf` condition, or a
// `for`/`each` case list spread from a platform conditional, that statically
// excludes Linux and does not statically exclude macOS. The condition is
// evaluated from the parsed syntax with three-valued logic: a value that
// cannot be decided from literals, `process.platform` and module constants
// built from them, such as `process.arch`, stays unknown.

const isProcessPlatform = (node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === "process" &&
  node.property.type === "Identifier" &&
  node.property.name === "platform";

/** The shared gate fact for one Babel expression node. */
const gateExpression = (node) => {
  switch (node.type) {
    case "StringLiteral":
    case "BooleanLiteral":
      return { type: "literal", value: node.value };
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return gateExpression(node.expression);
    case "Identifier":
      return { type: "identifier", name: node.name };
    case "MemberExpression":
      return isProcessPlatform(node)
        ? { type: "platform" }
        : { type: "unknown" };
    case "UnaryExpression":
      return node.operator === "!"
        ? { type: "unary", argument: gateExpression(node.argument) }
        : { type: "unknown" };
    case "BinaryExpression":
      return {
        type: "binary",
        operator: node.operator,
        left: gateExpression(node.left),
        right: gateExpression(node.right),
      };
    case "LogicalExpression":
      return {
        type: "logical",
        operator: node.operator,
        left: gateExpression(node.left),
        right: gateExpression(node.right),
      };
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
        return { type: "unknown" };
      return {
        type: "includes",
        items: callee.object.elements.map((item) =>
          item === null ? { type: "unknown" } : gateExpression(item),
        ),
        needle: gateExpression(node.arguments[0]),
      };
    }
    default:
      return { type: "unknown" };
  }
};

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
      if (id.type === "Identifier" && init)
        constants.set(id.name, gateExpression(init));
  }
  return constants;
};

/** Evaluate `node` on `platform` through the shared gate facts. */
const evaluate = (node, platform, constants) =>
  evaluateGateExpression(gateExpression(node), platform, constants);

/** Whether a gate certainly skips on `platform`. */
const skipsOn = (gate, platform, constants) =>
  gateSkipsOn(gate.kind, gateExpression(gate.condition), platform, constants);

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
