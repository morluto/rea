import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const execute = (script, args) => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

test('installer registers contracts, server tools, runtime asset and workflow guidance', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'rea-lunz-integration-'));
  try {
    await mkdir(join(fixture, 'src', 'server'), { recursive: true });
    await mkdir(join(fixture, 'src', 'contracts'), { recursive: true });
    await mkdir(join(fixture, 'scripts'), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '0.0.0', scripts: { build: 'node scripts/run-exclusive.mjs artifacts turbo run artifacts:skills --force', 'build:cached': 'node scripts/run-exclusive.mjs artifacts turbo run artifacts:skills' } }));
    await writeFile(join(fixture, 'src', 'contracts', 'toolContracts.ts'), 'import { FRIDA_TOOL_CONTRACTS } from "./fridaToolContracts.js";\nexport const TOOL_CONTRACTS = [\n  ...FRIDA_TOOL_CONTRACTS,\n] as const;\n');
    await writeFile(join(fixture, 'src', 'contracts', 'toolEffects.ts'), 'export const TOOL_EFFECTS = {\n  verify_unknown_resolution: effects(),\n};\n');
    await writeFile(join(fixture, 'src', 'server', 'createServer.ts'), 'import { registerSessionTools } from "./registerSessionTools.js";\nconst UNTRUSTED_CONTENT_INSTRUCTIONS = "Results that carry target content are marked with _meta.provenance.untrusted_content.";\nexport const createServer = () => {\n  const activeTarget = undefined;\n  const recordEvidence = undefined;\n  const evidenceById = undefined;\n  return server;\n};\n');
    const installed = JSON.parse(execute('install-rea-integration.mjs', [fixture]));
    assert.equal(installed.status, 'installed');
    const verified = JSON.parse(execute('verify-rea-integration.mjs', [fixture]));
    assert.equal(verified.status, 'verified');
    const server = await readFile(join(fixture, 'src', 'server', 'createServer.ts'), 'utf8');
    const contracts = await readFile(join(fixture, 'src', 'contracts', 'toolContracts.ts'), 'utf8');
    const packageJson = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
    assert.match(server, /candidate causal edges are hypotheses/i);
    assert.match(contracts, /EXTERNAL_EVIDENCE_TOOL_CONTRACTS/);
    assert.match(packageJson.scripts.build, /copy-external-evidence-engine/);
    assert.ok(installed.integration.includes('investigate_external_evidence_graph'));
    const copy = spawnSync(process.execPath, [join(fixture, 'scripts', 'copy-external-evidence-engine.mjs')], { encoding: 'utf8' });
    assert.equal(copy.status, 0, `${copy.stdout}\n${copy.stderr}`);
    await readFile(join(fixture, 'dist', 'external-evidence-engine', 'index.mjs'), 'utf8');
    await readFile(join(fixture, 'dist', 'external-evidence-engine', 'index.d.mts'), 'utf8');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
