import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ensureGeneratedFile,
  regularFilePaths,
} from "./lib/generated-file.mjs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const exec = promisify(execFile);
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown completion ledger option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "docs/verification");
const check = arguments_.has("--check");
const verifierEnvironment = { ...process.env };
delete verifierEnvironment.REA_MANAGED_APP_MANIFEST_PATH;
delete verifierEnvironment.REA_ILSPY_CMD_PATH;

const { stdout } = await exec(
  process.execPath,
  [join(root, "scripts/verify/managed/conformance.mjs")],
  {
    cwd: root,
    env: verifierEnvironment,
    maxBuffer: 20 * 1024 * 1024,
  },
);
const verifierOutput = JSON.parse(stdout);
// Managed conformance claims are host-independent. Keep the generated
// commitment reproducible across macOS, Linux, and Windows rather than
// embedding the machine that happened to generate it.
const portableCompletionReport = {
  ...verifierOutput.completionReport,
  environment: {
    platform: "portable",
    architecture: "portable",
    runtime: "node",
    runtime_version: "portable",
  },
};
const { createCompletionLedgerArtifacts } = await importVerifierSource(
  "./lib/completion-ledger-generation.mts",
  import.meta.url,
);
const skillDigest = await directoryDigest(
  join(root, "skills/reverse-engineer-anything"),
);
const generated = createCompletionLedgerArtifacts(portableCompletionReport, [
  { skill_id: "reverse-engineer-anything", sha256: skillDigest },
]);

if (!check) await mkdir(outputRoot, { recursive: true });
await Promise.all([
  ensureGeneratedFile({
    path: join(outputRoot, "managed-conformance-manifest.json"),
    source: `${JSON.stringify(generated.manifest, null, 2)}\n`,
    check,
    generateCommand: "npm run evidence:generate",
  }),
  ensureGeneratedFile({
    path: join(outputRoot, "managed-conformance-ledger.json"),
    source: `${JSON.stringify(generated.ledger, null, 2)}\n`,
    check,
    generateCommand: "npm run evidence:generate",
  }),
]);
process.stdout.write(
  `${JSON.stringify({
    manifest_id: generated.manifest.manifest_id,
    ledger_id: generated.ledger.ledger_id,
    claims: generated.ledger.summary.total,
    complete: generated.ledger.summary.complete,
  })}\n`,
);

async function directoryDigest(directory) {
  const paths = await regularFilePaths(
    directory,
    (name) =>
      `Completion skill digest does not admit ${basename(name)}: expected a regular file or directory`,
  );
  const records = await Promise.all(
    paths.map(async (name) => {
      const digest = createHash("sha256")
        .update(await readFile(join(directory, name)))
        .digest("hex");
      return `${name}\0${digest}\n`;
    }),
  );
  return createHash("sha256").update(records.join("")).digest("hex");
}
