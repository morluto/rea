import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(process.argv[2] ?? process.cwd());
const force = process.argv.includes('--force');
const packagePath = join(repoRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));

if (packageJson.name !== 'rea-agents') throw new Error('Target directory is not the REA repository root.');
for (const path of ['src/server/createServer.ts', 'src/contracts/toolContracts.ts', 'src/contracts/toolEffects.ts']) await access(join(repoRoot, path));

const sourceFiles = [
  ['src/external-evidence-engine', 'src/external-evidence-engine'],
  ['integration/rea/src/server/registerExternalEvidenceGraphTools.ts', 'src/server/registerExternalEvidenceGraphTools.ts'],
  ['integration/rea/src/contracts/externalEvidenceToolContracts.ts', 'src/contracts/externalEvidenceToolContracts.ts'],
  ['scripts/copy-external-evidence-engine.mjs', 'scripts/copy-external-evidence-engine.mjs']
];
const fileOperations = [];
const readRequired = async path => readFile(join(repoRoot, path), 'utf8');
const patch = (content, needle, replacement, path) => {
  if (!content.includes(needle)) throw new Error(`Required integration marker not found in ${path}: ${needle.slice(0, 100)}`);
  return content.replace(needle, replacement);
};

let contracts = await readRequired('src/contracts/toolContracts.ts');
if (contracts.includes('EXTERNAL_EVIDENCE_TOOL_CONTRACTS')) throw new Error('External Evidence Engine contracts already appear in src/contracts/toolContracts.ts.');
contracts = patch(contracts, 'import { FRIDA_TOOL_CONTRACTS } from "./fridaToolContracts.js";', 'import { FRIDA_TOOL_CONTRACTS } from "./fridaToolContracts.js";\nimport { EXTERNAL_EVIDENCE_TOOL_CONTRACTS } from "./externalEvidenceToolContracts.js";', 'src/contracts/toolContracts.ts');
contracts = patch(contracts, '  ...FRIDA_TOOL_CONTRACTS,\n] as const;', '  ...FRIDA_TOOL_CONTRACTS,\n  ...EXTERNAL_EVIDENCE_TOOL_CONTRACTS,\n] as const;', 'src/contracts/toolContracts.ts');
fileOperations.push({ path: 'src/contracts/toolContracts.ts', content: contracts });

let effects = await readRequired('src/contracts/toolEffects.ts');
if (effects.includes('investigate_external_evidence_graph')) throw new Error('External Evidence Engine effects already appear in src/contracts/toolEffects.ts.');
effects = patch(effects, '  verify_unknown_resolution: effects(),\n};', '  verify_unknown_resolution: effects(),\n  investigate_external_evidence_graph: effects({ mutatesSession: true, accessesNetwork: true }),\n  validate_external_evidence_graph: effects({ mutatesSession: true }),\n  generate_code_fidelity_report: effects({ mutatesSession: true }),\n};', 'src/contracts/toolEffects.ts');
fileOperations.push({ path: 'src/contracts/toolEffects.ts', content: effects });

let server = await readRequired('src/server/createServer.ts');
if (server.includes('registerExternalEvidenceGraphTools')) throw new Error('External Evidence Engine registration already appears in src/server/createServer.ts.');
server = patch(server, 'import { registerSessionTools } from "./registerSessionTools.js";', 'import { registerSessionTools } from "./registerSessionTools.js";\nimport { registerExternalEvidenceGraphTools } from "./registerExternalEvidenceGraphTools.js";', 'src/server/createServer.ts');
server = patch(server, 'Results that carry target content are marked with _meta.provenance.untrusted_content.";', 'Results that carry target content are marked with _meta.provenance.untrusted_content. Use investigate_external_evidence_graph for external package, API, vulnerability, and platform research; validate_external_evidence_graph before relying on graph claims; and generate_code_fidelity_report after reconstruction. Candidate causal edges are hypotheses until local code-path evidence and behavioral tests confirm them.";', 'src/server/createServer.ts');
const createServerReturn = '  return server;\n};';
const returnAt = server.lastIndexOf(createServerReturn);
if (returnAt < 0) throw new Error('Could not find createServer return point.');
server = `${server.slice(0, returnAt)}  registerExternalEvidenceGraphTools(server, { activeTarget, recordEvidence, resolveEvidence: evidenceById });\n${server.slice(returnAt)}`;
fileOperations.push({ path: 'src/server/createServer.ts', content: server });

if (typeof packageJson.scripts?.build !== 'string' || typeof packageJson.scripts?.['build:cached'] !== 'string') throw new Error('Build scripts were not found in package.json.');
if (packageJson.scripts.build.includes('copy-external-evidence-engine') || packageJson.scripts['build:cached'].includes('copy-external-evidence-engine')) throw new Error('External Evidence Engine build copy step already exists in package.json.');
packageJson.scripts.build += ' && node scripts/copy-external-evidence-engine.mjs';
packageJson.scripts['build:cached'] += ' && node scripts/copy-external-evidence-engine.mjs';
fileOperations.push({ path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` });

for (const [, destination] of sourceFiles) {
  const target = join(repoRoot, destination);
  try {
    await access(target);
    if (!force) throw new Error(`Destination already exists: ${destination}. Use --force only after reviewing the existing file.`);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !String(error?.message ?? '').startsWith('Destination already exists:')) throw error;
    if (String(error?.message ?? '').startsWith('Destination already exists:')) throw error;
  }
}


const copyTree = async (from, to) => {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination);
    else await copyFile(source, destination);
  }
};

for (const [source, destination] of sourceFiles) {
  const origin = join(bundleRoot, source);
  const target = join(repoRoot, destination);
  if (source === 'src/external-evidence-engine') await copyTree(origin, target);
  else {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(origin, target);
  }
}
for (const operation of fileOperations) {
  const target = join(repoRoot, operation.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, operation.content, 'utf8');
}
process.stdout.write(JSON.stringify({ status: 'installed', repo: repoRoot, files_added: sourceFiles.map(item => item[1]), files_updated: fileOperations.map(item => item.path), integration: ['investigate_external_evidence_graph', 'validate_external_evidence_graph', 'generate_code_fidelity_report'] }, null, 2) + '\n');
