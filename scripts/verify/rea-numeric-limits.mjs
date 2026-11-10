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

/**
 * Count-shaped limits whose names do not use a byte, time, or maximum suffix.
 * `REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES` is the runtime setting on #9836.
 */
const DOCUMENTED_COUNT_LIMITS = new Set([
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES",
]);

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

export const isNumericLimit = (name) =>
  DOCUMENTED_COUNT_LIMITS.has(name) ||
  /(?:_BYTES|_MS|_MIB|_SECONDS|_POLLS|_JOBS|_ELEMENTS|_COUNT|_SESSIONS|_COMMANDS)$/u.test(
    name,
  ) ||
  /_MAX_/u.test(name) ||
  /_(?:TIMEOUT|DEADLINE|BUDGET)(?:_|$)/u.test(name) ||
  /_HEAP(?:_|$)/u.test(name);

const limitName = (text) =>
  text !== undefined && /^REA_[A-Z0-9_]+$/u.test(text) && isNumericLimit(text)
    ? text
    : undefined;

const remember = (discovered, path, name) => {
  const limit = limitName(name);
  if (limit === undefined || discovered.has(limit)) return;
  discovered.set(limit, path);
};

/**
 * Producers are syntax, not text. A read is a property or element access,
 * including a const string used as the element, a string argument to a call,
 * an object-binding key (rename and default included), an `in` check, or an
 * object key that a spread can copy. Comments and array literals are not reads.
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
        remember(discovered, relativePath, node.name.text);
      if (ts.isElementAccessExpression(node))
        remember(
          discovered,
          relativePath,
          boundLimitName(node.argumentExpression, bindings),
        );
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const argument of node.arguments ?? [])
          remember(
            discovered,
            relativePath,
            boundLimitName(argument, bindings),
          );
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      )
        remember(discovered, relativePath, boundLimitName(node.left, bindings));
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
          remember(discovered, relativePath, key.text);
      }
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteral(node.name) ||
          ts.isNumericLiteral(node.name))
      )
        remember(discovered, relativePath, node.name.text);
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
        remember(
          discovered,
          relativePath,
          literalText(unwrapExpression(node.initializer)),
        );
      if (ts.isPropertyAssignment(node))
        remember(
          discovered,
          relativePath,
          literalText(unwrapExpression(node.initializer)),
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
          for (const token of chunk.match(/REA_[A-Z0-9_]+/gu) ?? [])
            remember(discovered, relativePath, token);
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
      /name:\s*"(REA_[A-Z0-9_]+)"\s*,\s*policy:\s*"(restart-only|per-call)"\s*,\s*read:\s*"(startup|per-call)"\s*,\s*reason:\s*"((?:\\.|[^"\\])*)"/gu,
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
    if (policy === "per-call" && read !== "per-call")
      failures.push(`${name} is per-call policy but is not read per call`);
    if (policy === "restart-only" && read !== "startup")
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
        `${name} in ${file} is neither an analysis setting nor docs/design/rea-limit-inventory.md via src/domain/numericLimitRegistry.ts`,
      );
  }
  for (const name of listed.keys()) {
    if (!discovered.has(name))
      failures.push(`${name} is registered but no longer appears in src`);
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
