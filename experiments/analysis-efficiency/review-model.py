"""Check selected model facts against public producer observations, not exit status."""

import argparse
import hashlib
import json
from pathlib import Path
import re


def read(path):
    return json.loads(path.read_text())


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for entry in value:
            yield from strings(entry)
    elif isinstance(value, dict):
        for entry in value.values():
            yield from strings(entry)


def evidence_ids(value):
    return {s for s in strings(value) if re.fullmatch(r'ev_[a-f0-9]{64}', s)}


def decode(result):
    value = result.get('structured_content', result.get('structuredContent'))
    if value is not None:
        return value
    for entry in result.get('content', []):
        if entry.get('type') == 'text':
            try:
                return json.loads(entry['text'])
            except json.JSONDecodeError:
                pass
    return None


def named_scope(value, names):
    """Accept explicit equivalent scope labels; contradictory duplicates stay a failure."""
    if not isinstance(value, dict):
        return None
    selected = {name: value[name] for name in names if name in value}
    values = list(selected.values())
    if not values:
        return None
    if all(entry == values[0] for entry in values):
        return values[0]
    return {'conflicting_reported_scopes': selected}


def scope_with_verified_counts(value, expected_scope, returned_counts):
    """Validate explicit extra row counts; never erase unknown or conflicting facts."""
    if not isinstance(value, dict):
        return value, {}
    scope = dict(value)
    checks = {}
    for name, expected in returned_counts.items():
        if name in scope:
            reported = scope[name]
            checks[name] = type(reported) is int and reported == expected
            if name not in expected_scope:
                del scope[name]
    return scope, checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--domain', choices=['wasm', 'evm', 'android', 'flutter-aot', 'sqlite', 'managed', 'managed-nonempty', 'firmware', 'inventory', 'javascript', 'native', 'browser'], required=True)
    parser.add_argument('--trial', type=Path, required=True)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--resource-log', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    summary = read(args.trial / 'summary.json')
    settings = read(args.trial / 'trial-settings.json')
    answer_text = (args.trial / 'answer.txt').read_text().strip()
    fenced = answer_text.startswith('```json\n') and answer_text.endswith('\n```')
    answer = json.loads(answer_text[8:-4] if fenced else answer_text)
    reference = read(args.reference / 'answer.json') if args.reference else None
    observed_ids = set()
    producer_results = {}
    tool_errors = []
    for line in (args.trial / 'events.jsonl').open():
        event = json.loads(line)
        item = event.get('item', {})
        if event.get('type') != 'item.completed' or item.get('type') != 'mcp_tool_call':
            continue
        result = item.get('result') or {}
        parsed = decode(result)
        if item['status'] == 'completed':
            # Only response text contributes observed IDs, never model arguments.
            for text in strings(result):
                observed_ids.update(re.findall(r'ev_[a-f0-9]{64}', text))
            if parsed is not None:
                producer_results.setdefault(item['tool'], []).append(parsed)
        else:
            tool_errors.append({'tool': item['tool'], 'arguments': item['arguments'], 'response': parsed if parsed is not None else result})
            if parsed is not None and parsed.get('error', {}).get('code') == 'resource_constraint':
                reference_value = parsed['error'].get('details', {}).get('reported_limits', {}).get('evidence_reference')
                observed_ids.update(evidence_ids(reference_value))
    reported_ids = evidence_ids(answer.get('evidence_ids'))
    checks = {
        'reported_evidence_ids_observed_in_responses': bool(reported_ids) and reported_ids <= observed_ids,
        'temporary_profile_removed': read(args.trial / 'cleanup.json')['profile_removed'],
    }
    if summary.get('selected_artifact_sha256_before') is not None:
        checks['selected_artifact_bytes_unchanged'] = summary['selected_artifact_bytes_unchanged']
    if reference is not None:
        checks['target_digest'] = answer.get('artifact_sha256') == reference['artifact_sha256']
    differences = {}

    def check(name, actual, expected):
        checks[name] = actual == expected
        if not checks[name]:
            differences[name] = {'answer': actual, 'producer': expected}

    domain = args.domain
    if domain == 'wasm':
        for key in ['validation', 'section_count', 'import_count', 'export_count', 'exports_first4', 'wat_sha256', 'wat_code_units', 'runtime_execution', 'network_fetch']:
            check(key, answer.get(key), reference[key])
        for key in ['release', 'source_commit']:
            check('wabt_' + key, answer.get('wabt_' + key), reference['tool_profile'][key])
    elif domain == 'evm':
        n = producer_results['inspect_evm_interface'][-1]['normalized_result']
        if n.get('kind') == 'summary':
            check('evm_summary.parent_operation', n.get('parent_operation'), 'inspect_evm_interface')
            checks['evm_summary.parent_reference_observed'] = n.get('parent_evidence_id') in observed_ids
            n = n['summary']
        for key, expected in {'artifact_bytes': n['artifact']['bytes'], 'bytecode_sha256': n['bytecode']['sha256'], 'bytecode_bytes': n['bytecode']['bytes'], 'functions': n['functions'], 'evidence_kind': n['evidence_kind'], 'discovery_completeness': n['discovery_completeness'], 'runtime_execution': n['runtime_execution'], 'bytecode_kind': n['bytecode']['kind'], 'hardfork': n['bytecode']['hardfork'], 'deployment_authenticity': n['bytecode']['deployment_authenticity']}.items():
            check(key, answer.get(key), expected)
        check('evm_original_limitations', answer.get('limitations'), n['limitations'])
    elif domain == 'sqlite':
        for key in ['artifact', 'wal', 'engine', 'database_encoding', 'schema', 'rows', 'producer_limitations', 'limitations']:
            # Missing is not SQL/JSON null; booleans are not numeric counters.
            check(key, (key in answer, json.dumps(answer.get(key), sort_keys=True)),
                  (True, json.dumps(reference[key], sort_keys=True)))
    elif domain == 'flutter-aot':
        for key in ['target', 'abi', 'libapp', 'string_pool', 'coverage', 'limitations']:
            check(key, answer.get(key), reference[key])
    elif domain == 'android':
        for key in ['package_name', 'version_name', 'version_code', 'matches']:
            check(key, answer.get(key), reference[key])
        fields = ['reported_signature', 'overload_index', 'dex_descriptor']
        checks['onCreate_fields_present_including_explicit_null'] = all(all(k in row for k in fields) for row in answer.get('onCreate', []))
        check('all_onCreate_descriptors', [{k: row.get(k) for k in fields} for row in answer.get('onCreate', [])], [{k: row[k] for k in fields} for row in reference['onCreate']])
    elif domain == 'managed':
        n = reference['artifact']
        for group, fields in [('assembly', ['name', 'version']), ('module', ['name', 'mvid'])]:
            for field in fields:
                check(group + '.' + field, answer.get(group, {}).get(field), n[group][field])
        for key in ['classification', 'target_frameworks']:
            check(key, answer.get(key), n[key])
        for key in ['module_refs', 'pinvoke_imports']:
            check(key, answer.get('native_boundaries', {}).get(key), reference['boundaries'][key])
        check('artifact_coverage', named_scope(answer.get('coverage'), ['artifact', 'managed_artifact', 'managed_metadata']), n['coverage'])
        boundary_scope, counts = scope_with_verified_counts(
            named_scope(answer.get('coverage'), ['native_boundaries', 'native_boundary_declarations']),
            reference['boundaries']['coverage'],
            {'module_ref_count': len(reference['boundaries']['module_refs']),
             'pinvoke_import_count': len(reference['boundaries']['pinvoke_imports'])})
        check('native_boundaries_coverage', boundary_scope, reference['boundaries']['coverage'])
        checks.update({'native_coverage_' + name: valid for name, valid in counts.items()})
    elif domain == 'managed-nonempty':
        n = reference['boundaries']
        check('module_mvid', answer.get('module_mvid'), n['module']['mvid'])
        check('summary', {key: answer.get('summary', {}).get(key) for key in n['summary']}, n['summary'])
        check('all_original_module_refs', answer.get('module_refs'), n['module_refs'])
        check('first3_complete_pinvoke_records', answer.get('pinvoke_first3'), n['pinvoke_imports'][:3])
        check('coverage', answer.get('coverage'), n['coverage'])
    elif domain == 'firmware':
        source = producer_results['inspect_firmware_regions'][-1]
        n = source['normalized_result']
        result = answer['result']
        check('input_size', result.get('input_size'), n['input_size'])
        check('examined_coverage', result.get('coverage', result.get('examined_coverage')), n['coverage'])
        fields = ['provider_id', 'offset', 'reported_size', 'signature', 'description', 'reported_confidence', 'size_basis']
        check('all_original_region_records', [{k: row.get(k) for k in fields} for row in result.get('regions', [])], [{k: row[k] for k in fields} for row in n['regions']])
        engine = result.get('engine', result.get('provider_provenance', {}).get('engine', {}))
        for key in ['name', 'version']:
            check('engine.' + key, engine.get(key), n['engine'][key])
        check('engine_executable_digest', engine.get('executable_sha256', engine.get('artifact_sha256')), n['engine']['executable_sha256'])
    elif domain == 'inventory':
        for key in ['manifest', 'entry_kind_counts', 'integrity_contradictions']:
            check(key, answer.get(key), reference[key])
        original = producer_results['inspect_artifact'][-1]['normalized_result']
        if original.get('kind') == 'summary':
            branches = original['summary']['inspection']['unexplored_branches']
        else:
            branches = original['unexplored_branches']
        # Caller-selected integrity policy participates in atomic Evidence and
        # branch identity. Match those IDs to this original response, not a
        # reference invocation that may use a different policy.
        check('unexplored_branches_with_original_ids', answer.get('unexplored_branches'), branches)
        coverage = answer.get('coverage', {})
        check('inspection_coverage', coverage.get('inspection', coverage), reference['coverage'])
        paths = answer.get('requested_paths')
        if isinstance(paths, dict):
            paths = [row for value in paths.values() for row in (value if isinstance(value, list) else [value]) if row is not None]
        canonical = lambda row: json.dumps(row, sort_keys=True, separators=(',', ':'))
        check('original_selected_path_records', sorted(map(canonical, paths or [])), sorted(map(canonical, reference['requested_paths'])))
    elif domain == 'javascript':
        for key in ['input_path', 'source_selection', 'statistics', 'electron']:
            check(key, answer.get(key), reference[key])
        coverage = answer['coverage']
        expected = reference['coverage']
        for key in ['application_unknowns', 'semantic_unknowns']:
            check('coverage.' + key, coverage.get(key), expected[key])
        for layer in ['application', 'semantic']:
            for key, value in expected[layer].items():
                if key in ['limits', 'families']: continue
                check('coverage.' + layer + '.' + key, coverage[layer].get(key), value)
        # Budgets vary with parent heap and belong to this actual invocation.
        # Exact optional provenance remains a separate strict check; omissions
        # must not be hidden by accepting the coarse coverage summary.
        original = producer_results['analyze_javascript_application'][-1]['normalized_result']['summary']['coverage']
        check('full_coverage_provenance', coverage, original)
        # The question names types/digests, not literal answer property names.
        # Exact node IDs select the producer's main.js records. No source or
        # Evidence values are rewritten to accept these answer labels.
        select = lambda rows: sorted([{
            'node_id': row.get('node_id'),
            'kind': row.get('kind', row.get('type')),
            'identity': row.get('identity'),
            'hashes': row.get('hashes', row.get('digests')),
        } for row in rows], key=lambda row: row['node_id'])
        check('all_selected_module_identities', select(answer.get('modules', [])), select(reference['modules']))
    elif domain == 'native':
        for key in ['entry_address', 'caller_count', 'callee_count']:
            check(key, answer.get(key), reference[key])
        prefix = answer.get('pseudocode_prefix')
        if isinstance(prefix, dict) and prefix.get('unit') == 'utf16-code-units':
            text = prefix.get('text')
            if 'requested' in prefix:
                check('pseudocode_prefix.requested', prefix['requested'], 512)
            if 'returned' in prefix:
                check('pseudocode_prefix.returned', prefix['returned'], len(reference['pseudocode_prefix'].encode('utf-16-le')) // 2)
            prefix = text
        check('pseudocode_prefix', prefix, reference['pseudocode_prefix'])
        containing = answer.get('containing_procedure')
        expected_containing = reference['containing_procedure']['procedure']
        if isinstance(containing, str):
            # Compare the explicitly reported display to the known source;
            # never parse a display name into a canonical lookup identity.
            check('containing_procedure.display', containing,
                  expected_containing['name'] + ' @ ' + expected_containing['address'])
        else:
            containing = containing if isinstance(containing, dict) else {}
            nested = containing.get('procedure')
            nested = nested if isinstance(nested, dict) else {}
            for key in ['address', 'name']:
                check('containing_procedure.' + key, containing.get(key, nested.get(key)), expected_containing[key])
        procedure = answer.get('procedure')
        procedure = procedure if isinstance(procedure, dict) else {}
        expected = reference['procedure']
        for key in ['address', 'name', 'classification', 'signature', 'locals']:
            check('procedure.' + key, procedure.get(key), expected[key])
        body = procedure.get('body')
        body = body if isinstance(body, dict) else {}
        check('procedure.body_ranges', procedure.get('body_ranges', body.get('ranges', body.get('ranges_inclusive'))), expected['body']['ranges'])
        check('procedure.total_bytes', procedure.get('total_bytes', body.get('total_bytes')), expected['body']['total_bytes'])
        if 'load_image' in reference:
            sources = [source for source in producer_results.get('inspect_native_load_image', [])
                       if isinstance(source, dict)
                       and source.get('operation') == 'inspect_native_load_image'
                       and isinstance(source.get('evidence_id'), str)
                       and source.get('evidence_id') in reported_ids
                       and isinstance(source.get('normalized_result'), dict)]
            checks['load_image_source_observed_and_referenced'] = bool(sources)
            load = sources[-1]['normalized_result'] if sources else {}
            entry = load.get('entry')
            entry = entry if isinstance(entry, dict) else {}
            check('load_image.target_sha256', load.get('target_sha256'), reference['artifact_sha256'])
            check('load_image.source_status', load.get('status'), reference['load_image']['status'])
            check('load_image.source_entry', entry.get('linear_address'), reference['entry_address'])
            status = answer.get('load_image_status')
            check('load_image_status', status.get('status') if isinstance(status, dict) else status, load.get('status'))
            if isinstance(status, dict):
                for key in ['format', 'load_segment', 'header_bytes', 'module_bytes', 'overlay_bytes']:
                    if key in status:
                        check('load_image.' + key, status[key], load.get(key))
                if 'entry_linear_address' in status:
                    check('load_image.entry_linear_address', status['entry_linear_address'], entry.get('linear_address'))
        calls = summary['completed_mcp_calls']
        checks['default_analysis_not_disabled'] = all(not call['arguments'].get('skip_auto_analysis', False) for call in calls if call['tool'] == 'open_binary')
        checks['session_close_completed'] = any(call['tool'] == 'close_binary' and call['status'] == 'completed' for call in calls)
    elif domain == 'browser':
        source = producer_results['capture_browser_scenario'][-1]
        n = source['normalized_result']
        for key in ['browser', 'completeness']:
            check(key, answer.get(key), n[key])
        check('start_origin', answer.get('start_origin'), n['scenario']['start_origin'])
        step_count = answer.get('step_count')
        check('step_count', step_count.get('captured_steps') if isinstance(step_count, dict) else step_count, len(n['steps']))
        final = n['steps'][-1]
        expected_url = final['after_url'] if isinstance(answer.get('final_url'), dict) else final['after_url']['url']
        check('final_url', answer.get('final_url'), expected_url)
        for key in ['dom', 'accessibility']:
            expected = final['artifacts'][key]
            actual = answer.get(key, {})
            if expected['state'] == 'captured':
                actual = actual.get('value', actual)
                for field in ['sha256', 'bytes']:
                    check(key + '.' + field, actual.get(field), expected['value'][field])
            else:
                check(key + '.state', actual.get('state'), expected['state'])
        checks['owned_browser_terminated'] = n['browser']['cleanup'] == 'terminated-owned-process'
        events = n['events']['items']
        page_errors = [event for event in events if event['kind'] == 'page-error']
        if isinstance(answer.get('page_errors'), dict):
            check('page_error_count', answer['page_errors'].get('count'), len(page_errors))
        network = answer.get('network', {})
        if 'observed_transactions' in network:
            check('network_transaction_count', network['observed_transactions'], len({event['transaction_id'] for event in events if event.get('transaction_id') is not None}))
        if 'observed_response_statuses' in network:
            statuses = {}
            for event in events:
                if event['kind'] == 'response':
                    status = str(event['status'])
                    statuses[status] = statuses.get(status, 0) + 1
            check('network_response_statuses', network['observed_response_statuses'], statuses)
    factual_checks = dict(checks)
    scopes = [json.loads(line) for line in args.resource_log.read_text().splitlines() if line.startswith('{')]
    scope = next(value for value in reversed(scopes) if 'resource_scope' in value)
    checks['no_resource_abort'] = scope['abort'] is None
    events = scope.get('resource_events_final')
    checks['resource_counters_verified'] = scope.get('resource_counters_verified') is True
    checks['no_observed_oom_or_task_limit'] = (
        isinstance(events, dict)
        and all(events.get('memory.events', {}).get(k) == 0 for k in ['max', 'oom', 'oom_kill'])
        and events.get('pids.events', {}).get('max') == 0
    )
    checks['no_resource_limit_event'] = (
        checks['resource_counters_verified']
        and checks['no_observed_oom_or_task_limit']
        and events['memory.events'].get('high') == 0
    )
    report = {
        'review_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'domain': domain, 'checks': checks, 'all_selected_checks_pass': all(checks.values()),
        'factual_checks': factual_checks, 'all_factual_checks_pass': all(factual_checks.values()),
        'differences': differences, 'tool_errors': tool_errors, 'summary': summary,
        'fingerprints': {key: value for key, value in settings.items() if 'sha256' in key or key in ['runtime_revision', 'enabled_tools', 'authority']},
        'answer_file_sha256': hashlib.sha256((args.trial / 'answer.txt').read_bytes()).hexdigest(),
        'answer_had_json_fence': fenced, 'reported_evidence_ids': sorted(reported_ids), 'resource': scope,
        'scope': 'Fixed selected-fact review against actual public producer observations. Equivalent explicitly named answer representations are accepted; unknowns/nulls remain checked. Limitations, unsupported claims and broader behavior still require transcript review. Token usage and failed calls are retained; zero exit status is not a factual grade.',
    }
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'domain': domain, 'passed': report['all_selected_checks_pass'], 'failed_checks': [key for key, value in checks.items() if not value]}))
    raise SystemExit(0 if report['all_selected_checks_pass'] else 1)


if __name__ == '__main__':
    main()
