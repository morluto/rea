import { readFileSync } from "node:fs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const { parseAuthoredSkillManifest } = await importVerifierSource(
  "../src/domain/skillManifest.ts",
  import.meta.url,
);
const { decodeStrictUtf8 } = await importVerifierSource(
  "../src/domain/strictUtf8.ts",
  import.meta.url,
);

const manifest = parseAuthoredSkillManifest(
  decodeStrictUtf8(readFileSync(0), "preserve"),
);
if (manifest.ok) process.stdout.write(JSON.stringify(manifest.value));
else {
  console.error(manifest.error.message);
  process.exitCode = 1;
}
