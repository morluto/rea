import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = resolve(import.meta.dirname, "../app/scripts/rea.mjs");
process.argv[1] = entry;
// Clear package-manager context only in this child, preserving the caller.
delete process.env.npm_command;
await import(pathToFileURL(entry).href);
