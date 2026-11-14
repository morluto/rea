import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const expected = [
  'src/external-evidence-engine/index.mjs',
  'src/external-evidence-engine/index.d.mts',
  'src/server/registerExternalEvidenceGraphTools.ts',
  'src/contracts/externalEvidenceToolContracts.ts',
  'scripts/copy-external-evidence-engine.mjs'
];
const missing = [];
for (const file of expected) {
  try { await access(join(root, file)); } catch { missing.push(file); }
}
const [server, contracts, effects, toolContracts, packageText] = await Promise.all([
  readFile(join(root, 'src/server/createServer.ts'), 'utf8'),
  readFile(join(root, 'src/contracts/externalEvidenceToolContracts.ts'), 'utf8'),
  readFile(join(root, 'src/contracts/toolEffects.ts'), 'utf8'),
  readFile(join(root, 'src/contracts/toolContracts.ts'), 'utf8'),
  readFile(join(root, 'package.json'), 'utf8')
]);
const tools = ['investigate_external_evidence_graph', 'validate_external_evidence_graph', 'generate_code_fidelity_report'];
const errors = [...missing.map(file => `missing_file:${file}`)];
if (!server.includes('registerExternalEvidenceGraphTools(server')) errors.push('missing_server_registration');
if (!server.includes('validate_external_evidence_graph before relying on graph claims')) errors.push('missing_agent_workflow_guidance');
if (!toolContracts.includes('EXTERNAL_EVIDENCE_TOOL_CONTRACTS')) errors.push('missing_canonical_contract_import_or_registration');
if (!packageText.includes('copy-external-evidence-engine.mjs')) errors.push('missing_runtime_asset_build_step');
for (const tool of tools) {
  if (!contracts.includes(tool)) errors.push(`missing_contract:${tool}`);
  if (!effects.includes(tool)) errors.push(`missing_effect_audit:${tool}`);
}
const result = { status: errors.length ? 'failed' : 'verified', repository: root, tools, errors };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (errors.length) process.exitCode = 1;
