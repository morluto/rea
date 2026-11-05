"""Measure catalog loading in real Codex sessions, never by a bytes/token ratio."""

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys

from codex_context import token_counts
from runtime_identity import runtime_fingerprint

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


def assess_trial(directory, returncode, expected_runtime_digest):
    """Collect independent partial observations before grading the trial."""
    result = {'status': 'invalid', 'directory': str(directory), 'exit_code': returncode}
    issues = []

    def observe(stage, work):
        try:
            return work()
        except (OSError, ValueError, KeyError, TypeError) as error:
            issues.append({'stage': stage, 'reason': str(error)})
            return None

    def require(condition, stage, reason):
        if not condition:
            issues.append({'stage': stage, 'reason': reason})

    def read_object(name):
        value = json.loads((directory / name).read_text())
        if not isinstance(value, dict):
            raise ValueError('Expected an object in ' + name)
        return value

    summary = observe('summary', lambda: read_object('summary.json'))
    settings = observe('settings', lambda: read_object('trial-settings.json'))
    cleanup = observe('cleanup', lambda: read_object('cleanup.json'))
    if summary is not None:
        result['summary'] = summary
        result['runtime_fingerprint_sha256'] = summary.get('runtime_files_sha256_before')
        require(returncode == 0 and summary.get('exit_code') == 0 and summary.get('timeout') is False,
                'completion', 'Trial failed or timed out')
        require(expected_runtime_digest is not None and summary.get('runtime_bytes_unchanged') is True
                and summary.get('runtime_files_sha256_before') == expected_runtime_digest
                and summary.get('runtime_files_sha256_after') == expected_runtime_digest,
                'identity', 'Runtime does not match the pinned matrix fingerprint')
    if settings is not None:
        require(settings.get('catalog_load') is True and settings.get('workspace_isolated_from_runtime') is True,
                'settings', 'Trial was not an isolated catalog-load measurement')
    if cleanup is not None:
        result['cleanup'] = cleanup
        require(cleanup.get('profile_removed') is True, 'cleanup', 'Trial profile cleanup was not verified')

    events = []

    def read_events():
        with (directory / 'events.jsonl').open() as lines:
            for ordinal, line in enumerate(lines, 1):
                if not line.strip():
                    continue
                def parse():
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError('Expected a JSONL event object')
                    return value
                event = observe('events line ' + str(ordinal), parse)
                if event is not None:
                    events.append(event)

    observe('events', read_events)
    turns = [event for event in events if event.get('type') == 'turn.completed']
    require(len(turns) == 1, 'usage', 'Expected exactly one completed turn')
    usage = observe('usage', lambda: usage_counts(turns[0].get('usage'))) if len(turns) == 1 else None
    if usage is not None:
        result['usage'] = usage
        result['usage']['uncached_input_tokens'] = (
            usage['input_tokens'] - usage['cached_input_tokens'])
    for event in events:
        require(event.get('type') not in ['error', 'turn.failed'], 'client',
                'Client reported an error or failed turn: ' + str(event.get('message', event.get('error'))))
    items = [event.get('item') for event in events if event.get('type') in ['item.started', 'item.completed']]
    for item in items:
        if isinstance(item, dict) and item.get('type') == 'error':
            require(False, 'client', 'Client item error: ' + str(item.get('message')))
        else:
            require(isinstance(item, dict) and item.get('type') in ['agent_message', 'reasoning'],
                    'actions', 'A load-only trial performed a tool/action or an unknown item')
    completed = [event.get('item') for event in events if event.get('type') == 'item.completed']
    answers = [item.get('text') for item in completed if isinstance(item, dict) and item.get('type') == 'agent_message']
    require(answers == [MARKER], 'answer', 'Load-only answer did not match the oracle')

    def read_resources():
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
        return receipts[0]

    receipt = observe('resources', read_resources)
    if receipt is not None:
        result['resources'] = receipt
        observation = receipt.get('payload_resource_observation')
        require(isinstance(observation, dict) and receipt.get('abort') is None
                and receipt.get('payload_resource_observation_verified') is True
                and observation.get('payload_exit_code') == 0 and observation.get('payload_cleanup_verified') is True,
                'resources', 'Resource stop, payload failure, or unverified process cleanup')
        def metrics():
            cpu = observation['cpu_stat']['usage_usec']
            peak = observation['memory_peak_bytes']
            if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in [cpu, peak]):
                raise ValueError('Invalid resource counters')
            return {'elapsed_seconds': receipt.get('elapsed_seconds'), 'cpu_seconds': cpu / 1_000_000,
                    'peak_process_family_bytes': peak,
                    'scope': 'Kernel cgroup counters at payload exit, including observer and file cache; not final scope counters.'}
        measured = observe('resource metrics', metrics)
        if measured is not None:
            result['resource_metrics'] = measured
    result['status'] = 'invalid' if issues else 'valid'
    if issues:
        result['issues'] = issues
        result['reason'] = '; '.join(issue['reason'] for issue in issues)
    return result


def comparison(rows, expected_runtime_digest):
    """Pair each catalog with its same-mode, same-repetition no-server control."""
    controls = {(row['mode'], row['repetition']): row for row in rows if row['arm'] == 'none'}
    pairs = []
    for row in rows:
        if row['arm'] == 'none':
            continue
        baseline = controls.get((row['mode'], row['repetition']))
        valid = expected_runtime_digest is not None and row['status'] == 'valid' and baseline is not None and baseline['status'] == 'valid' \
            and row.get('runtime_fingerprint_sha256') == expected_runtime_digest \
            and baseline.get('runtime_fingerprint_sha256') == expected_runtime_digest
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
    parser.add_argument('--modes', nargs='+', choices=['direct', 'client-code'], default=['client-code'],
                        help='Default: supported host mode. direct disables the host as a diagnostic control.')
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
    runtime_files, pinned_digest = (None, None) if args.plan else runtime_fingerprint(root)
    receipt = catalog_receipt(root, args.input_profile, args.selected_tools)
    if not args.plan:
        catalog_path = Path(receipt['path']).relative_to(root).as_posix()
        pinned_catalog = next((row for row in runtime_files if row['path'] == catalog_path), None)
        if pinned_catalog is None or pinned_catalog['sha256'] != receipt['sha256']:
            raise ValueError('Catalog changed while pinning the matrix runtime; rebuild and retry')
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
                                     for name in ['catalog-eval.py', 'agent-trial.py', 'codex_context.py', 'runtime_identity.py',
                                                  'resource-run.py', 'resource_payload.py', 'provider-environment.json']},
                  'scope': 'Fresh-session load-only usage. Warm OS/API caches are possible; no cache-miss claim or task-quality claim.',
                  'usage_scope': 'Codex turn.completed observed usage; deltas include server instructions and client framing, not an exact schema-only token count.'}
    if args.plan:
        print(json.dumps(experiment, indent=2))
        return 0
    experiment['runtime_files_sha256'] = pinned_digest
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    write_json(output / 'experiment.json', experiment)
    write_json(output / 'runtime-files.json', runtime_files)
    (output / 'prompt.txt').write_text(PROMPT)
    write_json(output / 'selected-tools.json', args.selected_tools)
    write_json(output / 'providers.json', {'REA_MCP_INPUT_SCHEMA_PROFILE': args.input_profile})
    rows = []
    for index, cell in enumerate(matrix):
        reason = 'Runtime changed between trials; no further model calls were made'
        try:
            _, current_digest = runtime_fingerprint(root)
        except (OSError, ValueError) as error:
            current_digest = None
            reason = 'Runtime identity unavailable; no further model calls were made: ' + str(error)
        if current_digest != pinned_digest:
            report = {'experiment': experiment, 'trials': rows, 'comparison': comparison(rows, pinned_digest),
                      'unattempted': matrix[index:], 'observed_runtime_digest': current_digest, 'reason': reason}
            write_json(output / 'report.json', report)
            print(report['reason'], flush=True)
            return 1
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
        row = {**cell, **assess_trial(directory, outcome.returncode, pinned_digest)}
        rows.append(row)
        report = {'experiment': experiment, 'trials': rows, 'comparison': comparison(rows, pinned_digest)}
        write_json(output / 'report.json', report)
        print(json.dumps({'completed': cell, 'status': row['status'], 'usage': row.get('usage'), 'reason': row.get('reason')}), flush=True)
    print(json.dumps(report['comparison']['groups'], indent=2))
    return 0 if all(row['status'] == 'valid' for row in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
