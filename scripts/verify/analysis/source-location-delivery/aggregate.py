"""Validate and summarize bounded public source-location task receipts.

Requires tiktoken 0.12.0. Full replies stay in the caller-selected measurement
directory; the output retains only identities, hashes, numeric measurements and
per-call serialized JSON-RPC token/byte estimates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics

import tiktoken


def compact(value, *, ordered=False):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=ordered)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('measurement_dir', type=Path)
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo_root.resolve()
    assert tiktoken.__version__ == '0.12.0', 'Use the recorded tokenizer version'
    encoder = tiktoken.get_encoding('cl100k_base')
    token_cache = {}

    def tokens(value, *, line=False):
        document = compact(value) + ('\n' if line else '')
        digest = hashlib.sha256(document.encode()).hexdigest()
        if digest not in token_cache:
            token_cache[digest] = len(encoder.encode(document, disallowed_special=()))
        return token_cache[digest]

    pins_path = repo / 'docs/verification/source-map-budgets-2026-11-09/artifacts.json'
    artifacts = json.loads(pins_path.read_text())
    records, semantic_answers, evidence_ids = [], {}, {}
    definitions = None
    input_only_definitions = None
    artifact_cache = {}
    receipts = sorted(args.measurement_dir.glob('r*-*.metrics.json'), key=lambda p: p.stat().st_mtime_ns)
    assert len(receipts) == 18, f'Expected 18 final receipts, found {len(receipts)}'
    for path in receipts:
        name = path.name.removesuffix('.metrics.json')
        selected = re.fullmatch(r'r([123])-(theme|index|DateSelect)-(complete|summary)', name)
        assert selected, name
        trial, case, detail = int(selected[1]), selected[2], selected[3]
        metric = json.loads(path.read_text())
        trace_path = path.with_name(name + '.replies.json')
        trace = json.loads(trace_path.read_text())
        assert metric['exit_code'] == 0 and metric['cleanup'] == 'group_empty'
        assert metric['stop_reason'] is None and metric['observer_error'] is None
        assert metric['signal_errors'] == [] and metric['remaining_group_pids'] == []
        assert trace['config']['select'] == case + '.' and trace['config']['detail'] == detail
        answer = trace['answer']
        artifact = next(item for item in artifacts if case + '.' in item['path'])
        assert answer['source_map_sha256'] == artifact['sha256']
        assert answer['lookup']['requested'] == artifact['point']
        assert answer['lookup']['matched_generated_position'] == artifact['point']
        assert len(answer['matches']) == len(artifact['expected_matches'])
        if case not in artifact_cache:
            raw_path = Path(trace['config']['artifactDir']) / artifact['path']
            assert sha256(raw_path) == artifact['sha256']
            artifact_cache[case] = json.loads(raw_path.read_text())
        raw = artifact_cache[case]
        for index, (actual, expected) in enumerate(zip(answer['matches'], artifact['expected_matches'])):
            assert actual['state'] == ('generated-only' if expected.get('generated_only') else 'mapped')
            if expected.get('generated_only'):
                continue
            assert actual['match_index'] == index
            assert actual['source_index'] == expected['source_index']
            assert actual['reported_source'] == expected['source']
            assert actual['original_position']['line'] == expected['original_line']
            assert actual['original_position']['column'] == expected['original_column']
            body = raw['sourcesContent'][expected['source_index']]
            assert hashlib.sha256(body.encode()).hexdigest() == expected['content_sha256']
            assert actual['content']['utf8_sha256'] == expected['content_sha256']
            snippet = actual['content']['snippet']
            encoded = body.encode('utf-16-le')
            start, length = snippet['offset_utf16'], snippet['length_utf16']
            assert snippet['text'] == encoded[start * 2:(start + length) * 2].decode('utf-16-le')
            assert length == 512, 'These pinned tasks require a 512-unit snippet'
            assert start <= actual['original_position']['offset'] <= start + length
            assert actual['content']['code_units'] == len(encoded) // 2
        semantic = {key: answer[key] for key in ['evidence_id', 'source_map_sha256', 'lookup', 'matches']}
        semantic_digest = hashlib.sha256(compact(semantic, ordered=True).encode()).hexdigest()
        if case in semantic_answers:
            assert semantic_digest == semantic_answers[case], f'Answer mismatch in {name}'
            assert answer['evidence_id'] == evidence_ids[case]
        else:
            semantic_answers[case], evidence_ids[case] = semantic_digest, answer['evidence_id']
        catalog = next(call['reply']['result'] for call in trace['calls'] if call['request']['method'] == 'tools/list')
        chosen_definitions = {tool: next(item for item in catalog['tools'] if item['name'] == tool) for tool in ['trace_web_source_location', 'inspect_analysis_view']}
        definition_counts = {tool: tokens(definition) for tool, definition in chosen_definitions.items()}
        input_only_counts = {tool: tokens({key: definition[key] for key in ['name', 'description', 'inputSchema']}) for tool, definition in chosen_definitions.items()}
        if definitions is None:
            definitions = definition_counts
            input_only_definitions = input_only_counts
        else:
            assert definitions == definition_counts
            assert input_only_definitions == input_only_counts
        rows, seen_catalog = [], False
        used_tools = set()
        for call in trace['calls']:
            request, reply = call['request'], call['reply']
            operation = request.get('params', {}).get('name', request['method'])
            request_count = tokens(request, line=True)
            reply_count = tokens(reply, line=True) if reply is not None else 0
            post_discovery = seen_catalog
            if request['method'] == 'tools/list':
                seen_catalog = True
            if request['method'] == 'tools/call':
                used_tools.add(operation)
            if reply is not None and request['method'] == 'tools/call' and not reply['result'].get('isError'):
                normalized = reply['result']['structuredContent']['normalized_result']
                source_report = normalized.get('source_location', normalized.get('summary', normalized))
                assert source_report['source']['sha256'] == artifact['generated_script']['sha256']
                assert source_report['source_map']['sha256'] == artifact['sha256']
            rows.append({
                'operation': operation, 'post_discovery': post_discovery,
                'request_tokens_estimated': request_count, 'reply_tokens_estimated': reply_count,
                'request_bytes_compact_json_line': len((compact(request) + '\n').encode()),
                'reply_bytes_observed_wire': call['wire_bytes'],
                'reply_bytes_reserialized_json_line': len((compact(reply) + '\n').encode()) if reply is not None else 0,
                'elapsed_ms': call['elapsed_ms'],
                'is_error': reply is not None and reply.get('result', {}).get('isError', False),
            })
            if operation == 'trace_web_source_location' and reply is not None:
                result = reply['result']
                if not result.get('isError') and detail == 'complete':
                    text = result['structuredContent']['raw_result']['source_map_text']
                    assert hashlib.sha256(text.encode()).hexdigest() == artifact['sha256']
        total = sum(row['request_tokens_estimated'] + row['reply_tokens_estimated'] for row in rows)
        post = sum(row['request_tokens_estimated'] + row['reply_tokens_estimated'] for row in rows if row['post_discovery'])
        assert used_tools <= chosen_definitions.keys()
        records.append({
            'name': name, 'trial': trial, 'artifact': case, 'detail': detail,
            'evidence_id': answer['evidence_id'], 'map_sha256': artifact['sha256'], 'generated_script_sha256': artifact['generated_script']['sha256'], 'answer_sha256': semantic_digest,
            'receipt_sha256': sha256(path), 'reply_trace_sha256': sha256(trace_path),
            'task_tokens_catalog_included_estimated': total, 'post_discovery_tokens_estimated': post,
            'used_tool_definitions_tokens_estimated': sum(definitions[tool] for tool in used_tools),
            'post_discovery_plus_used_definitions_tokens_estimated': post + sum(definitions[tool] for tool in used_tools),
            'hypothetical_used_input_only_definitions_tokens_estimated': sum(input_only_definitions[tool] for tool in used_tools),
            'hypothetical_post_discovery_plus_used_input_only_definitions_tokens_estimated': post + sum(input_only_definitions[tool] for tool in used_tools),
            'tool_calls': sum(call['request']['method'] == 'tools/call' for call in trace['calls']),
            'elapsed_seconds': metric['elapsed_seconds'], 'cpu_seconds_waited_subtree': metric['cpu_seconds_waited_subtree'],
            'peak_process_group_rss_bytes_sampled': metric['peak_process_group_rss_bytes_sampled'],
            'peak_process_tree_rss_bytes_sampled': metric['peak_process_tree_rss_bytes_sampled'],
            'maximum_group_members_sampled': metric['maximum_group_members_sampled'],
            'maximum_tree_members_sampled': metric['maximum_tree_members_sampled'],
            'sample_count': metric['sample_count'], 'exit_code': metric['exit_code'], 'cleanup': metric['cleanup'], 'stop_reason': metric['stop_reason'],
            'calls': rows,
        })
    groups = {}
    for record in records:
        groups.setdefault(record['artifact'] + '-' + record['detail'], []).append(record)
    fields = ['post_discovery_plus_used_definitions_tokens_estimated', 'hypothetical_used_input_only_definitions_tokens_estimated', 'hypothetical_post_discovery_plus_used_input_only_definitions_tokens_estimated', 'task_tokens_catalog_included_estimated', 'post_discovery_tokens_estimated', 'used_tool_definitions_tokens_estimated', 'tool_calls', 'elapsed_seconds', 'cpu_seconds_waited_subtree', 'peak_process_group_rss_bytes_sampled', 'peak_process_tree_rss_bytes_sampled']
    medians = {name: {'runs': len(group), **{field: statistics.median(record[field] for record in group) for field in fields}} for name, group in groups.items()}
    assert all(len(group) == 3 for group in groups.values()) and len(groups) == 6
    recorded_runtime = json.loads((args.measurement_dir / 'runtime.json').read_text())
    paths = ['scripts/verify/analysis/source-location-delivery/task.mjs', 'scripts/verify/analysis/budget-calibration-run.py', 'scripts/rea.mjs', 'dist/cli.js', 'dist/mcp/main.js', 'src/application/WebSourceLocationService.ts', 'src/domain/analysisView/webSourceLocationView.ts', 'src/application/analysisView/AnalysisViewService.ts', 'src/contracts/webScriptToolContracts.ts', 'src/server/ToolResultDelivery.ts', 'src/server/toolResult.ts', 'src/domain/sourceMapLimits.ts', 'src/server/registerWebSourceLocationTool.ts', 'src/cli/webSourceLocationCommands.ts', 'scripts/verify/analysis/source-location-delivery/aggregate.py', 'package-lock.json', 'docs/verification/source-map-budgets-2026-11-09/artifacts.json']
    hashes = {path: sha256(repo / path) for path in paths}
    assert hashes[paths[0]] == recorded_runtime['driver_sha256']
    assert hashes[paths[1]] == recorded_runtime['observer_sha256']
    if recorded_runtime.get('cli_sha256') is not None:
        assert hashes['dist/cli.js'] == recorded_runtime['cli_sha256']
    tree = [(path.relative_to(repo / 'dist').as_posix(), sha256(path)) for path in sorted((repo / 'dist').rglob('*')) if path.is_file()]
    tree_digest = hashlib.sha256(''.join(path + '\0' + digest + '\n' for path, digest in tree).encode()).hexdigest()
    output = {
        'schema': 'rea-source-location-delivery-calibration/v1',
        'token_accounting': {'library': 'tiktoken', 'version': tiktoken.__version__, 'encoding': 'cl100k_base', 'representation': 'compact Unicode JSON-RPC request/reply envelopes with trailing newline; initialized notification has no reply; estimates, not model billing', 'whole_catalog_included': 'initialize + initialized notification + tools/list + every trace/continuation/text call', 'post_discovery': 'all requests/replies after tools/list; excludes discovery only, not recovery', 'selected_definitions': 'complete serialized trace_web_source_location and inspect_analysis_view definitions counted separately; do not add them again to whole-catalog totals; client cached/deferred tool presentation may differ'},
        'runtime': {'recorded_runtime': recorded_runtime, 'sha256': hashes, 'compiled_tree': {'root': 'dist', 'files': len(tree), 'sha256': tree_digest, 'encoding': 'sorted relative UTF-8 filename + NUL + lowercase SHA256 + newline for every regular file, then SHA256'}},
        'conditions': {'host': metric['platform'], 'node': 'v24.22.1', 'runs': 'three fresh-process runs; second trial reverses variant order; OS caches not flushed; no disk-cold claim', 'task': 'all equal-position mappings and exact source/map identity plus 512 UTF-16 units around each mapped point', 'comparison': 'current complete delivery including bounded retained-view overflow recovery versus opt-in summary; not the older export-only fallback', 'profiles': {'tool_catalog': 'full', 'input_schema': 'compact', 'output_schema': 'full', 'response_budget_bytes': 10485760}, 'observer': {'interval_seconds': 0.02, 'wall_deadline_seconds': 90, 'memory_early_stop_bytes': 1536 * 1024 * 1024, 'signal_scope': 'owned process group only', 'rss': 'simultaneous ps-snapshot group/tree sums; tree includes linked-PPID codec descendants outside root PGID; can miss short peaks/exited/reparented/orphaned descendants and double-count shared pages', 'cpu': 'wait4 user+system waited subtree, excluding sampler and unwaited/orphaned descendants', 'memory_guard': 'group early stop; observational tree RSS is not signal authority or a hard/kernel peak limit'}},
        'selected_definition_tokens_estimated': definitions,
        'hypothetical_input_only_definition_tokens_estimated': input_only_definitions,
        'hypothetical_input_only_definition_projection': 'Only {name, description, inputSchema} from captured definitions; not an observed client/model transformation or a measured alternate discovery workflow',
        'observed_completion_order': [record['name'] for record in records],
        'validation': {'completed_runs': len(records), 'same_answer_and_parent_id_across_variants_and_trials': True, 'independent_artifact_oracle_and_snippets_verified': True, 'successful_complete_initial_raw_map_sha256_verified': True, 'all_owned_groups_empty': True, 'all_resource_stops': None},
        'medians': medians, 'records': records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'medians': medians, 'selected_definitions': definitions, 'compiled_tree': output['runtime']['compiled_tree']}, indent=2))


if __name__ == '__main__':
    main()
