import { posix } from "node:path";

const SOURCE_CLASSIFICATIONS = [
  "source",
  "test",
  "config",
  "manifest",
  "generated",
  "vendor",
  "documentation",
  "unknown",
] as const;

export type ReferenceSourceClassification =
  (typeof SOURCE_CLASSIFICATIONS)[number];

const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "swift",
  "m",
  "mm",
  "sh",
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["js", "JavaScript"],
  ["mjs", "JavaScript"],
  ["cjs", "JavaScript"],
  ["jsx", "JSX"],
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["mts", "TypeScript"],
  ["cts", "TypeScript"],
  ["py", "Python"],
  ["rs", "Rust"],
  ["go", "Go"],
  ["java", "Java"],
  ["c", "C"],
  ["h", "C"],
  ["cpp", "C++"],
  ["hpp", "C++"],
  ["cc", "C++"],
  ["cxx", "C++"],
  ["swift", "Swift"],
  ["m", "Objective-C"],
  ["mm", "Objective-C++"],
  ["sh", "Shell"],
  ["json", "JSON"],
  ["jsonc", "JSON"],
  ["yaml", "YAML"],
  ["yml", "YAML"],
  ["toml", "TOML"],
  ["ini", "INI"],
  ["cfg", "INI"],
  ["conf", "INI"],
  ["md", "Markdown"],
  ["markdown", "Markdown"],
  ["txt", "Text"],
  ["html", "HTML"],
  ["htm", "HTML"],
  ["css", "CSS"],
  ["scss", "SCSS"],
  ["sass", "Sass"],
  ["less", "Less"],
  ["xml", "XML"],
  ["svg", "SVG"],
]);

const MANIFEST_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "requirements.txt",
  "setup.py",
  "pyproject.toml",
  "pipfile",
  "pipfile.lock",
  "setup.cfg",
  "manifest.in",
  "CMakeLists.txt",
  "meson.build",
  "configure",
  "configure.ac",
  "makefile",
  "makefile.am",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "kubernetes.yml",
  "kubernetes.yaml",
  "kustomization.yml",
  "kustomization.yaml",
  ".releaserc",
  ".releaserc.json",
  ".releaserc.yml",
  ".releaserc.yaml",
  "release-please-config.json",
  "release-please-manifest.json",
]);

const CONFIG_FILENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  ".prettierignore",
  ".prettierrc",
  ".prettierrc.json",
  ".oxlintrc.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "jsconfig.json",
  "vitest.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
  "dependabot.yml",
  ".github",
  ".husky",
]);

const DOCUMENTATION_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "rst",
  "txt",
  "adoc",
  "asciidoc",
]);

const DOCUMENTATION_FILENAMES = new Set([
  "readme",
  "readme.md",
  "readme.markdown",
  "readme.txt",
  "changelog",
  "changelog.md",
  "changes.md",
  "history.md",
  "news.md",
  "license",
  "license.md",
  "license.txt",
  "copying",
  "copying.md",
  "authors",
  "authors.md",
  "contributing",
  "contributing.md",
  "code_of_conduct",
  "code_of_conduct.md",
  "security",
  "security.md",
  "support",
  "support.md",
  "faq",
  "faq.md",
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "htmlcov",
  "site",
  "public",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  "storybook-static",
  "docs/api",
  ".codex",
  ".devin",
  ".factory",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nyc_output",
]);

const VENDOR_DIRECTORY_NAMES = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  "third_party",
  "third-party",
  "thirdparty",
  "libs",
  "external",
]);

const SOURCE_DIRECTORY_NAMES = new Set([
  "src",
  "source",
  "sources",
  "lib",
  "libs",
  "packages",
  "pkg",
  "app",
  "apps",
  "bin",
  "scripts",
  "bridge",
  "components",
  "domain",
  "application",
  "server",
  "contracts",
  "hopper",
  "tests",
  "test",
  "__tests__",
  "spec",
  "specs",
  "testing",
  "fixtures",
]);

const TEST_DIRECTORY_NAMES = new Set([
  "tests",
  "test",
  "__tests__",
  "spec",
  "specs",
  "testing",
]);

const DOCUMENTATION_DIRECTORY_NAMES = new Set([
  "docs",
  "doc",
  "documentation",
  "guides",
  "examples",
  "tutorials",
  "wiki",
  "man",
]);

const filenameIsTest = (filename: string): boolean => {
  const lower = filename.toLowerCase();
  if (lower.includes(".test.") || lower.includes(".spec.")) return true;
  if (lower.startsWith("test_") || lower.startsWith("spec_")) return true;
  if (lower.endsWith("_test") || lower.endsWith("_spec")) return true;
  const stem = basenameParts(lower).base;
  return stem.endsWith("_test") || stem.endsWith("_spec");
};

const filenameIsGenerated = (filename: string): boolean => {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css")) return true;
  if (lower.endsWith(".map")) return true;
  if (lower.endsWith(".lock")) return true;
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.ts.map")) return true;
  if (lower.endsWith(".d.mts") || lower.endsWith(".d.mts.map")) return true;
  if (lower.endsWith(".d.cts") || lower.endsWith(".d.cts.map")) return true;
  return false;
};

const basenameParts = (filename: string): { base: string; ext: string } => {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, lastDot), ext: filename.slice(lastDot + 1) };
};

const basenameMatch = (filename: string, set: ReadonlySet<string>): boolean => {
  const lower = filename.toLowerCase();
  return set.has(lower);
};

const isPathUnderAny = (path: string, names: ReadonlySet<string>): boolean => {
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    if (names.has(segment.toLowerCase())) return true;
  }
  return false;
};

/** Detect a source language from a POSIX path. */
export const detectReferenceSourceLanguage = (path: string): string | null => {
  const filename = posix.basename(path);
  const lower = filename.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile."))
    return "Dockerfile";

  if (lower.endsWith(".d.ts")) return "TypeScript";
  if (lower.endsWith(".d.mts")) return "TypeScript";
  if (lower.endsWith(".d.cts")) return "TypeScript";

  const parts = basenameParts(filename);
  const extension = parts.ext.toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) ?? null;
};

/** Classify a reference source path deterministically. */
export const classifyReferenceSourcePath = (
  path: string,
): ReferenceSourceClassification[] => {
  const classifications: Set<ReferenceSourceClassification> = new Set();
  const parts = path.split("/").filter((segment) => segment !== "");
  const filename = parts[parts.length - 1] ?? "";
  const lower = filename.toLowerCase();

  if (parts.length === 0) {
    classifications.add("source");
    return [...classifications].sort();
  }
  addDirectoryClassifications(path, classifications);
  addFilenameClassifications(filename, classifications);

  if (
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml")
  ) {
    if (!classifications.has("manifest") && !classifications.has("config"))
      classifications.add("config");
  }

  if (isPathUnderAny(path, SOURCE_DIRECTORY_NAMES)) {
    if (!classifications.has("vendor") && !classifications.has("generated"))
      classifications.add("source");
  }

  if (classifications.size === 0) {
    if (lower === "license" || lower === "copying")
      classifications.add("documentation");
    else classifications.add("unknown");
  }

  return [...classifications].sort();
};

const addDirectoryClassifications = (
  path: string,
  classifications: Set<ReferenceSourceClassification>,
): void => {
  if (isPathUnderAny(path, TEST_DIRECTORY_NAMES)) classifications.add("test");
  if (isPathUnderAny(path, DOCUMENTATION_DIRECTORY_NAMES))
    classifications.add("documentation");
  if (isPathUnderAny(path, VENDOR_DIRECTORY_NAMES))
    classifications.add("vendor");
  if (isPathUnderAny(path, GENERATED_DIRECTORY_NAMES))
    classifications.add("generated");
};

const addFilenameClassifications = (
  filename: string,
  classifications: Set<ReferenceSourceClassification>,
): void => {
  const extension = basenameParts(filename).ext.toLowerCase();
  if (filenameIsTest(filename)) classifications.add("test");
  if (filenameIsGenerated(filename)) classifications.add("generated");
  if (basenameMatch(filename, MANIFEST_FILENAMES))
    classifications.add("manifest");
  if (basenameMatch(filename, CONFIG_FILENAMES)) classifications.add("config");
  if (DOCUMENTATION_EXTENSIONS.has(extension))
    classifications.add("documentation");
  if (DOCUMENTATION_FILENAMES.has(filename.toLowerCase()))
    classifications.add("documentation");
  if (CODE_EXTENSIONS.has(extension)) classifications.add("source");
};
