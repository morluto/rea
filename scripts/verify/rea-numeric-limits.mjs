import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every numeric REA_ limit under src must be an analysis setting or a
// restart-only exception with a reason and an update_mode. A per-call limit
// belongs in ANALYSIS_SETTINGS. The three limits moving on #9868, #9865, and
// #9836 are not in this tree; once their names appear here they must join
// ANALYSIS_SETTINGS. REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES is numeric
// even though its name has no byte or time suffix.

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

/** Drop comments without treating `//` inside a string as a comment. */
export const sourceForLimitDiscovery = (source) => {
  let out = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote !== "") {
      out += current;
      if (current === "\\" && quote !== "`") {
        out += next ?? "";
        index += 1;
        continue;
      }
      if (current === quote) quote = "";
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      out += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        index += 1;
      index += 1;
      out += " ";
      continue;
    }
    out += current;
  }
  return out;
};

/** A quoted name in an array is an allowlist entry, not a limit producer. */
const isArrayElementLiteral = (source, index) => {
  if (source[index - 1] !== '"') return false;
  let cursor = index - 2;
  while (cursor >= 0 && /\s/u.test(source[cursor] ?? "")) cursor -= 1;
  const previous = source[cursor];
  return previous === "[" || previous === ",";
};

export const isNumericLimit = (name) =>
  DOCUMENTED_COUNT_LIMITS.has(name) ||
  /(?:_BYTES|_MS|_MIB|_SECONDS|_POLLS|_JOBS|_ELEMENTS|_COUNT|_SESSIONS|_COMMANDS)$/u.test(
    name,
  ) ||
  /_MAX_/u.test(name) ||
  /_(?:TIMEOUT|DEADLINE|BUDGET)(?:_|$)/u.test(name) ||
  /_HEAP(?:_|$)/u.test(name);

/** Names used by producers. Registry declarations, comments, and allowlists are not usage. */
export const discoverNumericLimitUses = (files) => {
  const discovered = new Map();
  for (const file of files) {
    const relativePath = file.path.split(sep).join("/");
    if (relativePath === NUMERIC_LIMIT_DECLARATION) continue;
    const source = sourceForLimitDiscovery(file.source);
    for (const match of source.matchAll(/(?<![A-Z0-9_])REA_[A-Z0-9_]+/gu)) {
      const name = match[0];
      if (!isNumericLimit(name) || discovered.has(name)) continue;
      if (isArrayElementLiteral(source, match.index ?? 0)) continue;
      discovered.set(name, relativePath);
    }
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
  const declaredNames = [
    ...registry.matchAll(/name:\s*"(REA_[A-Z0-9_]+)"/gu),
  ].map((match) => match[1]);
  const entries = [
    ...registry.matchAll(
      /name:\s*"(REA_[A-Z0-9_]+)"\s*,\s*update_mode:\s*"(runtime|restart)"\s*,\s*policy:\s*"(restart-only|per-call)"\s*,\s*read:\s*"(startup|per-call)"\s*,\s*reason:\s*"((?:\\.|[^"\\])*)"/gu,
    ),
  ];
  const listed = new Map();
  for (const match of entries) {
    const [, name, updateMode, policy, read, reason] = match;
    if (listed.has(name)) failures.push(`${name} is listed twice`);
    listed.set(name, { updateMode, policy, read, reason });
    if (reason.trim().length < 40)
      failures.push(`${name} needs a reason that states why`);
    if (updateMode !== "restart")
      failures.push(
        `${name} is outside ANALYSIS_SETTINGS, so its update_mode must be restart`,
      );
    if (runtime.has(name))
      failures.push(
        `${name} is both a runtime setting and on the exception list`,
      );
    if (policy === "per-call" && read !== "per-call")
      failures.push(`${name} is per-call policy but is not read per call`);
    if (policy === "restart-only" && read !== "startup")
      failures.push(`${name} is restart-only but is not read at startup`);
  }
  for (const name of declaredNames) {
    if (!listed.has(name))
      failures.push(`${name} is registered without update_mode`);
  }
  const settingBodies = [
    ...definitions.matchAll(/\n {2}"[^"]+": \{([\s\S]*?)\n {2}\},/gu),
  ];
  if (settingBodies.length === 0)
    failures.push("ANALYSIS_SETTINGS did not parse into setting bodies");
  for (const [, body] of settingBodies) {
    if (!/updateMode:\s*"(?:runtime|restart)"/u.test(body))
      failures.push("an analysis setting is missing updateMode");
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

  const forbidden =
    /(?<![A-Za-z0-9_])(?:rea_restart_required|restartRequired|restart_required)(?![A-Za-z0-9_])|effect:\s*"(?:immediate|next_process)"|SettingChangeEffect/gu;
  const scanRoots = ["src", "tests", "docs", ".agents", "scripts"].map((dir) =>
    join(root, dir),
  );
  const skipDir = new Set([
    "node_modules",
    "dist",
    ".turbo",
    ".cache",
    "rea-numeric-limits.mjs",
  ]);
  const listText = async (dir) => {
    const output = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return output;
    }
    for (const entry of entries) {
      if (skipDir.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) output.push(...(await listText(path)));
      else if (/\.(?:ts|tsx|mjs|js|md|json|py|yml|yaml)$/u.test(entry.name))
        output.push(path);
    }
    return output;
  };
  for (const dir of scanRoots) {
    for (const path of await listText(dir)) {
      if (path.endsWith(`${sep}rea-numeric-limits.mjs`)) continue;
      const source = await readFile(path, "utf8");
      const hit = source.match(forbidden);
      if (hit)
        failures.push(
          `${relative(root, path).split(sep).join("/")} still uses ${[...new Set(hit)].join(", ")}`,
        );
    }
  }

  if (failures.length > 0) {
    console.error(`Numeric REA_ limit check failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Numeric REA_ limits: ${runtime.size} runtime, ${[...listed.values()].filter((entry) => entry.policy === "restart-only").length} restart-only, ${[...listed.values()].filter((entry) => entry.policy === "per-call").length} per-call pending migration, ${discovered.size} discovered.`,
  );
}
