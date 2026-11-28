import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export async function portableDependencies(root, lock, platform, architecture) {
  const platformMismatch = (entry) =>
    !matchesPlatform(entry.os, platform) ||
    !matchesPlatform(entry.cpu, architecture) ||
    // Windows has no libc. npm rejects supplied libc selectors there, even
    // negative-only, `any`, or empty lists that would match another selector.
    (platform === "win32" && Boolean(entry.libc));
  const present = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    try {
      await lstat(join(root, path));
      present.add(path);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }

  // Only root optional providers may be absent as a whole. An enabled package's
  // host-specific optional dependencies (such as the PTY binary) remain required.
  const enabled = new Set();
  function visit(owner) {
    if (enabled.has(owner)) return;
    enabled.add(owner);
    const entry = lock.packages[owner];
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      const path = resolveDependency(owner, name, lock.packages);
      const optional = Object.hasOwn(entry.optionalDependencies ?? {}, name);
      if (optional && platformMismatch(lock.packages[path])) continue;
      if (owner === "" && optional && !present.has(path)) continue;
      visit(path);
    }
  }
  visit("");

  const dependencies = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    if (!present.has(path)) {
      if (entry.optional && (platformMismatch(entry) || !enabled.has(path)))
        continue;
      throw new Error(`Installed dependency is missing: ${path}`);
    }
    const source = join(root, path);
    const installed = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    if (installed.version !== entry.version)
      throw new Error(
        `Installed dependency differs from the lockfile: ${path}`,
      );
    dependencies.push({ path, version: installed.version });
  }
  return dependencies;
}

function resolveDependency(owner, name, packages) {
  // Lockfile package keys use POSIX separators even on Windows. Follow Node's
  // ancestor node_modules lookup rather than assuming every dependency is hoisted.
  let parent = owner;
  for (;;) {
    const candidate = posix.join(parent, "node_modules", name);
    if (
      posix.basename(parent) !== "node_modules" &&
      Object.hasOwn(packages, candidate)
    )
      return candidate;
    if (parent === "")
      throw new Error(
        `Lockfile dependency is missing: ${owner || "root"} -> ${name}`,
      );
    const next = posix.dirname(parent);
    parent = next === "." ? "" : next;
  }
}

function matchesPlatform(selectors, value) {
  if (selectors === undefined) return true;
  const list = typeof selectors === "string" ? [selectors] : selectors;
  // Match npm: a block wins; negative-only lists allow other hosts. `any` is
  // universal only as a lone selector, and an empty list imposes no restriction.
  if (list.length === 1 && list[0] === "any") return true;
  if (list.includes(`!${value}`)) return false;
  return (
    list.every((selector) => selector.startsWith("!")) || list.includes(value)
  );
}
