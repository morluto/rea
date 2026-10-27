import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root, input, output] = process.argv.slice(2);
const start = performance.now();
const { createCatalogIdentity } = await import(
  pathToFileURL(resolve(root, "dist/catalogIdentity.js"))
);
const imported = performance.now();
const cpu = process.cpuUsage();
const identity = createCatalogIdentity({
  compactPresentation:
    input === "compact" ? { budgetBytes: 13 * 1024 } : undefined,
  outputSchemaProfile: output,
});
const digests = identity.digests;
const end = performance.now();
console.log(
  JSON.stringify({
    input,
    output,
    import_ms: imported - start,
    digest_ms: end - imported,
    digest_cpu_us: process.cpuUsage(cpu),
    digests,
  }),
);
