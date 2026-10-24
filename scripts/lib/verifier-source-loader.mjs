import { createRequire } from "node:module";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";

const requireFromTsx = createRequire(import.meta.resolve("tsx/package.json"));
let compiler;
let leases = 0;

const retainSourceCompiler = () => {
  // Reserve before awaiting startup; imports and command scopes share ownership.
  leases++;
  let released = false;
  return async () => {
    if (released) return;
    if (leases === 1) await compiler?.stop();
    leases--;
    released = true;
  };
};

/** Load source without stopping the compiler of another active import or scope. */
export async function importVerifierSource(url, parent) {
  const close = retainSourceCompiler();
  return withVerifierCleanup(async () => {
    compiler ??= requireFromTsx("esbuild");
    const { tsImport } = await import("tsx/esm/api");
    return tsImport(url, parent);
  }, [close]);
}

/** Keep the compiler available for peer work and later imports until scope close. */
export async function createVerifierSourceOwner(options, create) {
  const close = retainSourceCompiler();
  let adopted = false;
  return withVerifierCleanup(async () => {
    compiler ??= requireFromTsx("esbuild");
    const owner = await create({
      ...options,
      closeHooks: [...(options?.closeHooks ?? []), close],
    });
    adopted = true;
    return owner;
  }, [() => (adopted ? undefined : close())]);
}
