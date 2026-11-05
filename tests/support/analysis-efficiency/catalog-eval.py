"""Measure catalog loading in real Codex sessions, never by a bytes/token ratio."""

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys

from codex_context import token_counts

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MARKER = 'CATALOG_OK'
PROMPT = 'Reply with exactly ' + MARKER + '.\n'
TOKEN_KEYS = ('input_tokens', 'cached_input_tokens', 'output_tokens')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def usage_counts(value):
    counts = token_counts(value)
    if not all(key in counts for key in TOKEN_KEYS) \
            or counts['input_tokens'] == 0 or counts['cached_input_tokens'] > counts['input_tokens']:
        raise ValueError('Missing or invalid observed token usage')
    return counts


def assess_trial(directory, returncode):
    """Keep failed trials visible; absent measurements never become zero."""
    result = {'status': 'invalid', 'directory': str(directory), 'exit_code': returncode}
    try:
        summary = json.loads((directory / 'summary.json').read_text())
        result['summary'] = summary
        settings = json.loads((directory / 'trial-settings.json').read_text())
        if not isinstance(summary, dict) or not isinstance(settings, dict):
            raise ValueError('Expected trial summary/settings objects')
        if settings.get('catalog_load') is not True or settings.get('workspace_isolated_from_runtime') is not True:
            raise ValueError('Trial was not an isolated catalog-load measurement')
        events = [json.loads(line) for line in (directory / 'events.jsonl').read_text().splitlines() if line.strip()]
        if any(not isinstance(event, dict) for event in events):
            raise ValueError('Expected JSONL event objects')
        if any(event.get('type') in ['error', 'turn.failed'] for event in events):
            raise ValueError('Client reported an error or failed turn')
        turns = [event for event in events if event.get('type') == 'turn.completed']
        if len(turns) != 1:
            raise ValueError('Expected exactly one completed turn')
        result['usage'] = usage_counts(turns[0].get('usage'))
        result['usage']['uncached_input_tokens'] = (
            result['usage']['input_tokens'] - result['usage']['cached_input_tokens'])
        items = [event.get('item') for event in events if event.get('type') in ['item.started', 'item.completed']]
        if any(not isinstance(item, dict) or item.get('type') not in ['agent_message', 'reasoning'] for item in items):
            raise ValueError('A load-only trial performed a tool/action or an unknown item')
        completed = [event['item'] for event in events if event.get('type') == 'item.completed']
        answers = [item.get('text') for item in completed if item.get('type') == 'agent_message']
        if answers != [MARKER]:
            raise ValueError('Load-only answer did not match the oracle')
        if returncode != 0 or summary.get('exit_code') != 0 or summary.get('timeout') is not False:
            raise ValueError('Trial failed or timed out')
        if summary.get('runtime_bytes_unchanged') is not True:
            raise ValueError('Runtime fingerprint changed or could not be verified')
        cleanup = json.loads((directory / 'cleanup.json').read_text())
        if not isinstance(cleanup, dict) or cleanup.get('profile_removed') is not True:
            raise ValueError('Trial profile cleanup was not verified')
        # Reuse the existing observer's ownership-checked payload receipt. The
        # live observer captures kernel peak/CPU before the transient cgroup exits.
        receipts = []
        for line in directory.with_suffix('.log').read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and 'resource_scope' in row:
                receipts.append(row)
        if len(receipts) != 1:
            raise ValueError('Missing or ambiguous resource receipt')
        receipt = receipts[0]
        result['resources'] = receipt
        observation = receipt.get('payload_resource_observation') or {}
        if receipt.get('abort') is not None or receipt.get('payload_resource_observation_verified') is not True \
                or observation.get('payload_exit_code') != 0 or observation.get('payload_cleanup_verified') is not True:
            raise ValueError('Resource stop, payload failure, or unverified process cleanup')
        result['resource_metrics'] = {
            'elapsed_seconds': receipt.get('elapsed_seconds'),
            'cpu_seconds': observation['cpu_stat']['usage_usec'] / 1_000_000,
            'peak_process_family_bytes': observation['memory_peak_bytes'],
            'scope': 'Kernel cgroup counters at payload exit, including observer and file cache; not final scope counters.',
        }
        result['status'] = 'valid'
    except (OSError, ValueError, KeyError, TypeError) as error:
        result['reason'] = str(error)
    return result


def comparison(rows):
    """Pair each catalog with its same-mode, same-repetition no-server control."""
    controls = {(row['mode'], row['repetition']): row for row in rows if row['arm'] == 'none'}
    pairs = []
    for row in rows:
        if row['arm'] == 'none':
            continue
        baseline = controls.get((row['mode'], row['repetition']))
        valid = row['status'] == 'valid' and baseline is not None and baseline['status'] == 'valid'
        pairs.append({
            'mode': row['mode'], 'arm': row['arm'], 'repetition': row['repetition'],
            'status': 'valid' if valid else 'invalid',
            'input_token_delta': row['usage']['input_tokens'] - baseline['usage']['input_tokens'] if valid else None,
        })
    groups = []
    for mode, arm in sorted({(pair['mode'], pair['arm']) for pair in pairs}):
        selected = [pair for pair in pairs if pair['mode'] == mode and pair['arm'] == arm]
        deltas = [pair['input_token_delta'] for pair in selected if pair['status'] == 'valid']
        groups.append({'mode': mode, 'arm': arm, 'valid_pairs': len(deltas), 'attempted_pairs': len(selected),
                       'median_input_token_delta': statistics.median(deltas) if deltas else None,
                       'min_input_token_delta': min(deltas) if deltas else None,
                       'max_input_token_delta': max(deltas) if deltas else None})
    return {'pairs': pairs, 'groups': groups}


def catalog_receipt(root, profile, selected):
    source = root / 'dist' / ('mcp-catalog-full.json' if profile == 'full' else 'mcp-catalog.json')
    data = source.read_bytes()
    catalog = json.loads(data)
    names = {tool['name'] for tool in catalog['tools']}
    if len(selected) != len(set(selected)) or not selected or not set(selected) <= names:
        raise ValueError('Selected tools must be unique exact names in the built catalog')
    size = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())
    return {'path': str(source), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
            'tool_count': len(names), 'selected_tools': selected,
            'tools_json_bytes': size(catalog['tools']),
            'description_json_bytes': sum(size(tool.get('description')) for tool in catalog['tools']),
            'input_schema_json_bytes': sum(size(tool.get('inputSchema')) for tool in catalog['tools']),
            'output_schema_json_bytes': sum(size(tool.get('outputSchema')) for tool in catalog['tools']),
            'scope': 'Built server catalog, not submitted model context. Client filtering still discovers the server catalog.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', required=True, help='Explicit Codex model alias; never inferred from user config')
    parser.add_argument('--reasoning', default='low')
    parser.add_argument('--modes', nargs='+', choices=['direct', 'client-code'], default=['direct', 'client-code'])
    parser.add_argument('--input-profile', choices=['compact', 'full'], default='compact')
    parser.add_argument('--selected-tools', nargs='+', default=['binary_session'])
    parser.add_argument('--repetitions', type=int, default=1)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--codex', default='codex')
    parser.add_argument('--plan', action='store_true', help='Show the matrix without invoking a model')
    args = parser.parse_args()
    if args.repetitions < 1 or args.timeout < 1 or len(set(args.modes)) != len(args.modes):
        parser.error('Repetitions/timeout must be positive; modes must be unique')
    root = args.runtime_root.resolve()
    output = args.output.resolve()
    receipt = catalog_receipt(root, args.input_profile, args.selected_tools)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    matrix = []
    for repetition in range(args.repetitions):
        # Reverse both mode and arm ordering on alternating rounds to expose
        # order/cache effects. Every invocation still has a fresh client/server.
        for mode in args.modes[::1 if repetition % 2 == 0 else -1]:
            for arm in ['none', 'all', 'selected'][::1 if repetition % 2 == 0 else -1]:
                matrix.append({'repetition': repetition + 1, 'mode': mode, 'arm': arm})
    experiment = {'version': 1, 'runtime_revision': revision, 'model': args.model, 'reasoning': args.reasoning,
                  'input_profile': args.input_profile, 'catalog': receipt, 'matrix': matrix,
                  'sources_sha256': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                                     for name in ['catalog-eval.py', 'agent-trial.py', 'codex_context.py',
                                                  'resource-run.py', 'resource_payload.py', 'provider-environment.json']},
                  'scope': 'Fresh-session load-only usage. Warm OS/API caches are possible; no cache-miss claim or task-quality claim.',
                  'usage_scope': 'Codex turn.completed observed usage; deltas include server instructions and client framing, not an exact schema-only token count.'}
    if args.plan:
        print(json.dumps(experiment, indent=2))
        return 0
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    write_json(output / 'experiment.json', experiment)
    (output / 'prompt.txt').write_text(PROMPT)
    write_json(output / 'selected-tools.json', args.selected_tools)
    write_json(output / 'providers.json', {'REA_MCP_INPUT_SCHEMA_PROFILE': args.input_profile})
    rows = []
    for cell in matrix:
        directory = output / ('{repetition:02d}-{mode}-{arm}'.format(**cell))
        command = [sys.executable, str(HERE / 'resource-run.py'), '--observe-payload-exit', '--',
                   sys.executable, str(HERE / 'agent-trial.py'), '--runtime-root', str(root), '--revision', revision,
                   '--prompt', str(output / 'prompt.txt'), '--output', str(directory), '--model', args.model,
                   '--reasoning', args.reasoning, '--mode', cell['mode'], '--timeout', str(args.timeout),
                   '--codex', args.codex, '--providers', str(output / 'providers.json'),
                   '--catalog-load', '--capture-tool-context']
        if cell['arm'] == 'none':
            command.append('--no-mcp')
        elif cell['arm'] == 'selected':
            command.extend(['--enabled-tools', str(output / 'selected-tools.json')])
        print(json.dumps({'starting': cell}), flush=True)
        with directory.with_suffix('.log').open('w') as log:
            outcome = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
        row = {**cell, **assess_trial(directory, outcome.returncode)}
        rows.append(row)
        report = {'experiment': experiment, 'trials': rows, 'comparison': comparison(rows)}
        write_json(output / 'report.json', report)
        print(json.dumps({'completed': cell, 'status': row['status'], 'usage': row.get('usage'), 'reason': row.get('reason')}), flush=True)
    print(json.dumps(report['comparison']['groups'], indent=2))
    return 0 if all(row['status'] == 'valid' for row in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
