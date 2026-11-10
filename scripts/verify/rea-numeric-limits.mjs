import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

const isNumericLimit = (name) =>
  /(?:_BYTES|_MS|_MIB|_SECONDS|_POLLS|_JOBS|_ELEMENTS|_COUNT|_SESSIONS|_COMMANDS)$/u.test(
    name,
  ) ||
  /_MAX_/u.test(name) ||
  /_(?:TIMEOUT|DEADLINE|BUDGET)(?:_|$)/u.test(name) ||
  /_HEAP(?:_|$)/u.test(name);

const namesIn = (source, pattern) =>
  new Set([...source.matchAll(pattern)].map((match) => match[1]));

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

const discovered = new Map();
for (const path of await listFiles(join(root, "src"))) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?<![A-Z0-9_])REA_[A-Z0-9_]+/gu)) {
    const name = match[0];
    if (!isNumericLimit(name)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    discovered.set(name, relativePath);
  }
}

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

if (failures.length > 0) {
  console.error(`Numeric REA_ limit check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `Numeric REA_ limits: ${runtime.size} runtime, ${[...listed.values()].filter((entry) => entry.policy === "restart-only").length} restart-only, ${[...listed.values()].filter((entry) => entry.policy === "per-call").length} per-call pending migration, ${discovered.size} discovered.`,
);
