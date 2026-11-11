import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript6";

// Every numeric REA_ limit under src must be an analysis setting or a
// documented exception with a reason. restart-only is durable. per-call is a
// launch-captured limit whose runtime migration deletes the registry entry.
// The three limits moving on #9868, #9865, and #9836 are not in this tree;
// once their names appear here they must join ANALYSIS_SETTINGS.

const root = fileURLToPath(new URL("../../", import.meta.url));
const definitionsPath = join(root, "src/domain/analysisSettingDefinitions.ts");
const registryPath = join(root, "src/domain/numericLimitRegistry.ts");

const listFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      output.push(...(await listFiles(path)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".fixture.ts")
    )
      output.push(path);
  }
  return output;
};

/** Registry text is a declaration, not a producer that uses the limit. */
export const NUMERIC_LIMIT_DECLARATION = "src/domain/numericLimitRegistry.ts";

/**
 * These limits are moving onto runtime analysis settings on their own PRs.
 * A producer or a registry entry cannot satisfy that requirement.
 */
export const REQUIRED_RUNTIME_LIMITS = [
  "REA_NTFS_MFT_MAX_FILE_BYTES",
  "REA_REGF_HIVE_MAX_FILE_BYTES",
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES",
];

const unwrapExpression = (node) => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
};

const literalText = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;

/** Same-file const strings and `setting` fields, so `environment[name]` still resolves. */
const stringBindings = (sourceFile) => {
  const bindings = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      const literal = literalText(initializer);
      if (literal !== undefined) bindings.set(node.name.text, literal);
      if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            (!ts.isIdentifier(property.name) &&
              !ts.isStringLiteral(property.name))
          )
            continue;
          const value = literalText(unwrapExpression(property.initializer));
          if (value !== undefined)
            bindings.set(`${node.name.text}.${property.name.text}`, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
};

const boundLimitName = (node, bindings) => {
  const expression = unwrapExpression(node);
  const literal = literalText(expression);
  if (literal !== undefined) return literal;
  if (ts.isIdentifier(expression)) return bindings.get(expression.text);
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    (ts.isIdentifier(expression.name) || ts.isStringLiteral(expression.name))
  )
    return bindings.get(
      `${expression.expression.text}.${expression.name.text}`,
    );
  return undefined;
};

const isPropertyAccess = (node) =>
  ts.isPropertyAccessExpression(node) ||
  ts.isPropertyAccessChain?.(node) === true;

const isElementAccess = (node) =>
  ts.isElementAccessExpression(node) ||
  ts.isElementAccessChain?.(node) === true;

/**
 * Number(), parseInt(), and schema parse() read the value they are given.
 * The accessed property or element is that read, through parentheses and
 * other wrappers, so a suffixless name is still classified.
 */
const rememberNumericArgument = (discovered, path, node, bindings) => {
  const expression = unwrapExpression(node);
  if (isPropertyAccess(expression))
    remember(discovered, path, expression.name.text, expression, true);
  else if (isElementAccess(expression))
    remember(
      discovered,
      path,
      boundLimitName(expression.argumentExpression, bindings),
      expression,
      true,
    );
  else
    remember(
      discovered,
      path,
      boundLimitName(expression, bindings),
      expression,
      true,
    );
  ts.forEachChild(expression, (child) =>
    rememberNumericArgument(discovered, path, child, bindings),
  );
};

/**
 * Generated source assigns a limit (`REA_NAME = ...`). A name mentioned in
 * template prose is not a producer, matching an ordinary string.
 */
const assignedTemplateLimits = (chunk) =>
  [...chunk.matchAll(/(?:^|[^A-Za-z0-9_])(REA_[A-Z0-9_]+)\s*=(?!=)/gu)].map(
    (match) => match[1],
  );

export const isNumericLimit = (name) =>
  REQUIRED_RUNTIME_LIMITS.includes(name) ||
  /(?:_BYTES|_MS|_MIB|_SECONDS|_POLLS|_JOBS|_ELEMENTS|_COUNT|_SESSIONS|_COMMANDS)$/u.test(
    name,
  ) ||
  /_MAX_/u.test(name) ||
  /_(?:TIMEOUT|DEADLINE|BUDGET)(?:_|$)/u.test(name) ||
  /_HEAP(?:_|$)/u.test(name);

const exactLimit = (text) =>
  text !== undefined && /^REA_[A-Z0-9_]+$/u.test(text) ? text : undefined;

const limitName = (text) => {
  const name = exactLimit(text);
  return name !== undefined && isNumericLimit(name) ? name : undefined;
};

const numericSchemaText = (node) =>
  /z\.(?:number|int|coerce\.number)|(?:Bytes|Timeout|Deadline|Budget|Heap|Count|Integer|MiB)Schema\b/u.test(
    node.getText(),
  );

const isParseAccess = (expression) =>
  isPropertyAccess(expression) &&
  (expression.name.text === "safeParse" || expression.name.text === "parse");

/** Number() and a numeric schema read their argument. Other parsers do not. */
const parsesNumericArgument = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (
    ts.isIdentifier(expression) &&
    (expression.text === "Number" ||
      expression.text === "parseInt" ||
      expression.text === "parseFloat")
  )
    return true;
  return isParseAccess(expression) && numericSchemaText(expression.expression);
};

const numericParse = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  return parsesNumericArgument(node) || isParseAccess(expression);
};

const readLifecycle = (node) => {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isConstructorDeclaration(current)) return "construction";
    current = current.parent;
  }
  return "call";
};

const remember = (discovered, path, name, node, force = false) => {
  const limit = force ? exactLimit(name) : limitName(name);
  if (limit === undefined) return;
  const read = readLifecycle(node);
  const current = discovered.get(limit);
  if (current === undefined) {
    discovered.set(limit, { path, read });
    return;
  }
  if (current.read === "construction" && read === "call") current.read = "call";
};

/**
 * Producers are syntax, not text. A read is a property or element access,
 * including a const string used as the element, a string argument to a call,
 * an object-binding key (rename and default included), an `in` check, or an
 * object key that a spread can copy. A numeric parser also reads a property or
 * element access inside its argument. Comments, array literals, and template
 * prose are not reads. A template is a producer only when it assigns the name.
 */
export const discoverNumericLimitUses = (files) => {
  const discovered = new Map();
  for (const file of files) {
    const relativePath = file.path.split(sep).join("/");
    if (relativePath === NUMERIC_LIMIT_DECLARATION) continue;
    const sourceFile = ts.createSourceFile(
      relativePath,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const bindings = stringBindings(sourceFile);
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isPropertyAccessChain?.(node)
      )
        remember(discovered, relativePath, node.name.text, node);
      if (ts.isElementAccessExpression(node))
        remember(
          discovered,
          relativePath,
          boundLimitName(node.argumentExpression, bindings),
          node,
        );
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const parsesNumber = parsesNumericArgument(node);
        for (const argument of node.arguments ?? []) {
          if (parsesNumber)
            rememberNumericArgument(
              discovered,
              relativePath,
              argument,
              bindings,
            );
          else
            remember(
              discovered,
              relativePath,
              boundLimitName(argument, bindings),
              node,
              numericParse(node),
            );
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      )
        remember(
          discovered,
          relativePath,
          boundLimitName(node.left, bindings),
          node,
        );
      if (
        ts.isBindingElement(node) &&
        node.dotDotDotToken === undefined &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        const key = node.propertyName ?? node.name;
        if (
          ts.isIdentifier(key) ||
          ts.isStringLiteral(key) ||
          ts.isNumericLiteral(key)
        )
          remember(discovered, relativePath, key.text, node);
      }
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteral(node.name) ||
          ts.isNumericLiteral(node.name))
      )
        remember(
          discovered,
          relativePath,
          node.name.text,
          node,
          ts.isPropertyAssignment(node) && numericSchemaText(node.initializer),
        );
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
        remember(
          discovered,
          relativePath,
          literalText(unwrapExpression(node.initializer)),
          node,
        );
      if (ts.isPropertyAssignment(node))
        remember(
          discovered,
          relativePath,
          literalText(unwrapExpression(node.initializer)),
          node,
        );
      if (
        ts.isTemplateExpression(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        const chunks = ts.isNoSubstitutionTemplateLiteral(node)
          ? [node.text]
          : [
              node.head.text,
              ...node.templateSpans.map((span) => span.literal.text),
            ];
        for (const chunk of chunks)
          for (const token of assignedTemplateLimits(chunk))
            remember(discovered, relativePath, token, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return discovered;
};

/** Tracked limits join ANALYSIS_SETTINGS. The exception registry cannot classify them. */
export const requiredRuntimeLimitFailure = (
  name,
  { inRuntime, inRegistry },
) => {
  if (!REQUIRED_RUNTIME_LIMITS.includes(name)) return undefined;
  if (inRuntime && !inRegistry) return undefined;
  return `${name} must join ANALYSIS_SETTINGS; numericLimitRegistry cannot classify it`;
};

const namesIn = (source, pattern) =>
  new Set([...source.matchAll(pattern)].map((match) => match[1]));

/** Existing launch-seed migrations. A new per-call policy is rejected. */
const TEMPORARY_PER_CALL_LIMITS = new Set([
  "REA_BRIDGE_MAX_REQUEST_BYTES",
  "REA_DEBUGGER_COMMAND_DEADLINE_MS",
  "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
  "REA_HOPPER_CALLER_SCAN_BUDGET_MS",
  "REA_JEB_MCP_TIMEOUT_MS",
  "REA_KUNA_PROJECT_TIMEOUT_MS",
  "REA_KUNA_TIMEOUT_MS",
  "REA_PWNTOOLS_MAX_INPUT_BYTES",
  "REA_WINDOWS_CHANGE_TIME_DRIFT_MS",
  "REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS",
  "REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS",
]);

const direct =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  const failures = [];
  const definitions = await readFile(definitionsPath, "utf8");
  const registry = await readFile(registryPath, "utf8");
  const runtime = namesIn(definitions, /environment:\s*"(REA_[A-Z0-9_]+)"/gu);
  const entries = [
    ...registry.matchAll(
      /name:\s*"(REA_[A-Z0-9_]+)"\s*,\s*policy:\s*"(restart-only|per-call)"\s*,\s*read:\s*"(startup|per-call|construction)"\s*,\s*reason:\s*"((?:\\.|[^"\\])*)"/gu,
    ),
  ];
  const listed = new Map();
  for (const match of entries) {
    const [, name, policy, read, reason] = match;
    if (listed.has(name)) failures.push(`${name} is listed twice`);
    listed.set(name, { policy, read, reason });
    if (reason.trim().length < 40)
      failures.push(`${name} needs a reason that states why`);
    if (runtime.has(name))
      failures.push(
        `${name} is both a runtime setting and on the exception list`,
      );
    if (policy === "per-call" && !TEMPORARY_PER_CALL_LIMITS.has(name))
      failures.push(
        `${name} is a new per-call exception. Move it into ANALYSIS_SETTINGS instead of extending the temporary list.`,
      );
    if (policy === "restart-only" && read === "per-call")
      failures.push(
        `${name} is restart-only but is recorded as a per-call read`,
      );
    if (
      policy === "restart-only" &&
      read !== "startup" &&
      read !== "construction"
    )
      failures.push(`${name} is restart-only but is not read at startup`);
  }

  const discovered = discoverNumericLimitUses(
    await Promise.all(
      (await listFiles(join(root, "src"))).map(async (path) => ({
        path: relative(root, path),
        source: await readFile(path, "utf8"),
      })),
    ),
  );

  for (const [name, file] of [...discovered].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!runtime.has(name) && !listed.has(name))
      failures.push(
        `${name} in ${file.path} is neither an analysis setting nor docs/design/rea-limit-inventory.md via src/domain/numericLimitRegistry.ts`,
      );
  }
  for (const name of listed.keys()) {
    if (!discovered.has(name))
      failures.push(`${name} is registered but no longer appears in src`);
    const site = discovered.get(name);
    const declared = listed.get(name);
    if (site?.read === "construction" && declared?.read === "per-call")
      failures.push(
        `${name} is copied when its owner is constructed, so read cannot be per-call`,
      );
  }
  const present = new Set([...discovered.keys(), ...listed.keys(), ...runtime]);
  for (const name of REQUIRED_RUNTIME_LIMITS) {
    if (!present.has(name)) continue;
    const failure = requiredRuntimeLimitFailure(name, {
      inRuntime: runtime.has(name),
      inRegistry: listed.has(name),
    });
    if (failure !== undefined) failures.push(failure);
  }

  if (failures.length > 0) {
    console.error(`Numeric REA_ limit check failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Numeric REA_ limits: ${runtime.size} runtime, ${[...listed.values()].filter((entry) => entry.policy === "restart-only").length} restart-only, ${[...listed.values()].filter((entry) => entry.policy === "per-call").length} per-call pending migration, ${discovered.size} discovered.`,
  );
}
