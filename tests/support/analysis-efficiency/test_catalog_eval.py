"""Catalog measurement oracles and missing/failed measurement semantics."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import io
import sys
import subprocess

spec = importlib.util.spec_from_file_location('catalog_eval', Path(__file__).with_name('catalog-eval.py'))
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogEvaluationTests(unittest.TestCase):
    def test_plan_does_not_spawn_a_model_or_acquire_trial_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'dist').mkdir()
            catalog.write_json(root / 'dist/mcp-catalog.json', {
                'tools': [{'name': 'binary_session', 'inputSchema': {}}]})
            output = root / 'unacquired-output'
            arguments = ['catalog-eval.py', '--runtime-root', str(root), '--output', str(output),
                         '--model', 'explicit-test-alias', '--plan']
            stream = io.StringIO()
            with patch.object(sys, 'argv', arguments), patch('sys.stdout', stream), \
                    patch.object(catalog.subprocess, 'check_output', return_value='pinned\n'), \
                    patch.object(catalog, 'runtime_fingerprint', side_effect=AssertionError('Plan must not hash the runtime')), \
                    patch.object(catalog.subprocess, 'run') as launch:
                self.assertEqual(catalog.main(), 0)
            launch.assert_not_called()
            self.assertFalse(output.exists())
            plan = json.loads(stream.getvalue())
            self.assertEqual(plan['model'], 'explicit-test-alias')
            self.assertEqual({cell['mode'] for cell in plan['matrix']}, {'client-code'})
            self.assertEqual({cell['arm'] for cell in plan['matrix']}, {'none', 'all', 'selected'})

    def test_unknown_or_invalid_usage_never_becomes_zero(self):
        for value in [None, {}, {'input_tokens': 10},
                      {'input_tokens': True, 'cached_input_tokens': 0, 'output_tokens': 1},
                      {'input_tokens': 10, 'cached_input_tokens': 11, 'output_tokens': 1},
                      {'input_tokens': 0, 'cached_input_tokens': 0, 'output_tokens': 1},
                      {'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': -1}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                catalog.usage_counts(value)

    def test_pairs_with_the_same_mode_and_round_without_hiding_failures(self):
        rows = [
            {'mode': 'direct', 'arm': 'none', 'repetition': 1, 'status': 'valid', 'usage': {'input_tokens': 100}},
            {'mode': 'direct', 'arm': 'all', 'repetition': 1, 'status': 'valid', 'usage': {'input_tokens': 130}},
            {'mode': 'client-code', 'arm': 'none', 'repetition': 1, 'status': 'valid', 'usage': {'input_tokens': 1000}},
            {'mode': 'client-code', 'arm': 'all', 'repetition': 1, 'status': 'valid', 'usage': {'input_tokens': 1200}},
            {'mode': 'direct', 'arm': 'all', 'repetition': 2, 'status': 'valid', 'usage': {'input_tokens': 140}},
            {'mode': 'direct', 'arm': 'none', 'repetition': 3, 'status': 'invalid'},
            {'mode': 'direct', 'arm': 'all', 'repetition': 3, 'status': 'valid', 'usage': {'input_tokens': 150}},
        ]
        for row in rows:
            row['runtime_fingerprint_sha256'] = 'a' * 64
        result = catalog.comparison(rows, 'a' * 64)
        self.assertEqual([pair['input_token_delta'] for pair in result['pairs']], [30, 200, None, None])
        direct = next(group for group in result['groups'] if group['mode'] == 'direct')
        self.assertEqual(direct['attempted_pairs'], 3)
        self.assertEqual(direct['valid_pairs'], 1)
        self.assertEqual(direct['median_input_token_delta'], 30)

    def test_rejects_different_builds_even_if_each_trial_is_individually_valid(self):
        def row(arm, digest):
            return {'mode': 'client-code', 'arm': arm, 'repetition': 1, 'status': 'valid',
                    'usage': {'input_tokens': 100}, 'runtime_fingerprint_sha256': digest}
        for left, right, pin in [('a' * 64, 'b' * 64, 'a' * 64),
                                 ('b' * 64, 'b' * 64, 'a' * 64), (None, None, None)]:
            result = catalog.comparison([row('none', left), row('all', right)], pin)
            self.assertEqual(result['pairs'][0]['status'], 'invalid')
            self.assertIsNone(result['groups'][0]['median_input_token_delta'])

    def test_matrix_stops_before_more_model_calls_when_another_checkout_rebuilds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / 'other-checkout'
            (runtime / 'dist').mkdir(parents=True)
            module = runtime / 'dist/module.js'
            module.write_text('build A')
            catalog.write_json(runtime / 'dist/mcp-catalog.json', {'tools': [{'name': 'binary_session'}]})
            _, pin = catalog.runtime_fingerprint(runtime)
            output = root / 'output'
            arguments = ['catalog-eval.py', '--runtime-root', str(runtime), '--output', str(output), '--model', 'test-alias']

            def launch(command, **options):
                directory = Path(command[command.index('--output') + 1])
                directory.mkdir()
                catalog.write_json(directory / 'summary.json', {
                    'exit_code': 0, 'timeout': False, 'runtime_bytes_unchanged': True,
                    'runtime_files_sha256_before': pin, 'runtime_files_sha256_after': pin})
                catalog.write_json(directory / 'trial-settings.json', {'catalog_load': True, 'workspace_isolated_from_runtime': True})
                catalog.write_json(directory / 'cleanup.json', {'profile_removed': True})
                (directory / 'events.jsonl').write_text('\n'.join(json.dumps(event) for event in [
                    {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': catalog.MARKER}},
                    {'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 0, 'output_tokens': 8}},
                ]) + '\n')
                options['stdout'].write(json.dumps({
                    'resource_scope': 'fixture-scope', 'abort': None, 'payload_resource_observation_verified': True,
                    'payload_resource_observation': {'payload_exit_code': 0, 'payload_cleanup_verified': True,
                                                     'cpu_stat': {'usage_usec': 1}, 'memory_peak_bytes': 1},
                }) + '\n')
                # The completed first trial is valid; the external build happens
                # between trials, outside the driver's artifact lock.
                module.write_text('build B')
                return subprocess.CompletedProcess(command, 0)

            with patch.object(sys, 'argv', arguments), patch('builtins.print'), \
                    patch.object(catalog.subprocess, 'check_output', return_value='fixed\n'), \
                    patch.object(catalog.subprocess, 'run', side_effect=launch) as spawn:
                self.assertEqual(catalog.main(), 1)
            self.assertEqual(spawn.call_count, 1)
            report = json.loads((output / 'report.json').read_text())
            self.assertEqual(report['experiment']['runtime_files_sha256'], pin)
            self.assertEqual(report['trials'][0]['status'], 'valid')
            self.assertEqual(len(report['unattempted']), 2)

    def test_catalog_receipt_must_belong_to_the_pinned_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'dist').mkdir()
            source = root / 'dist/mcp-catalog.json'
            catalog.write_json(source, {'tools': [{'name': 'binary_session'}]})
            original = catalog.runtime_fingerprint

            def rebuild_after_pin(runtime):
                snapshot = original(runtime)
                catalog.write_json(source, {'tools': [{'name': 'binary_session', 'description': 'new build'}]})
                return snapshot

            output = root / 'unacquired'
            arguments = ['catalog-eval.py', '--runtime-root', str(root), '--output', str(output), '--model', 'test-alias']
            with patch.object(sys, 'argv', arguments), \
                    patch.object(catalog.subprocess, 'check_output', return_value='fixed\n'), \
                    patch.object(catalog, 'runtime_fingerprint', side_effect=rebuild_after_pin), \
                    patch.object(catalog.subprocess, 'run') as spawn:
                with self.assertRaisesRegex(ValueError, 'Catalog changed'):
                    catalog.main()
            spawn.assert_not_called()
            self.assertFalse(output.exists())

    def test_load_oracle_rejects_actions_failures_and_unverified_cleanup(self):
        summary = {'exit_code': 0, 'timeout': False, 'runtime_bytes_unchanged': True,
                   'runtime_files_sha256_before': 'a' * 64, 'runtime_files_sha256_after': 'a' * 64}
        events = [
            {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': catalog.MARKER}},
            {'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 8}},
        ]
        resources = {'resource_scope': 'fixture-scope', 'abort': None,
                     'payload_resource_observation_verified': True,
                     'payload_resource_observation': {'payload_exit_code': 0, 'payload_cleanup_verified': True,
                                                      'cpu_stat': {'usage_usec': 1500}, 'memory_peak_bytes': 1000}}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'trial'
            directory.mkdir()

            def assess(changed_events=None, changed_resources=None, changed_summary=None, cleaned=True, code=0):
                catalog.write_json(directory / 'summary.json', summary if changed_summary is None else changed_summary)
                catalog.write_json(directory / 'trial-settings.json', {'catalog_load': True, 'workspace_isolated_from_runtime': True})
                catalog.write_json(directory / 'cleanup.json', {'profile_removed': cleaned})
                (directory / 'events.jsonl').write_text(''.join(
                    json.dumps(event) + '\n' for event in (events if changed_events is None else changed_events)))
                directory.with_suffix('.log').write_text(json.dumps(
                    resources if changed_resources is None else changed_resources) + '\n')
                return catalog.assess_trial(directory, code, 'a' * 64)

            valid = assess()
            self.assertEqual(valid['status'], 'valid')
            self.assertEqual(valid['usage']['uncached_input_tokens'], 20)
            for item in ['mcp_tool_call', 'command_execution', 'tool_search', 'error', 'new_unknown_action']:
                action = {'type': 'item.completed', 'item': {'type': item}}
                self.assertEqual(assess(changed_events=[action, *events])['status'], 'invalid')
            self.assertEqual(assess(changed_events=events + [events[-1]])['status'], 'invalid')
            self.assertEqual(assess(changed_events=events[:1])['status'], 'invalid')
            notice = {'type': 'item.completed', 'item': {'type': 'error', 'message': 'Host disabled; tool dispatch is unavailable'}}
            failure = assess(changed_events=[notice, *events])
            self.assertIn(notice['item']['message'], failure['reason'])
            self.assertEqual(failure['usage']['input_tokens'], 100)
            self.assertEqual(failure['resources'], resources)
            self.assertTrue(failure['cleanup']['profile_removed'])
            failure = assess(changed_events=[{'type': 'error', 'message': 'outer failure'}, *events])
            self.assertEqual(failure['usage']['input_tokens'], 100)
            self.assertEqual(failure['resource_metrics']['cpu_seconds'], 0.0015)
            failure = assess(changed_events=[{'type': 'turn.failed'}])
            self.assertNotIn('usage', failure)
            self.assertEqual(failure['resources'], resources)
            assess()
            transcript = directory / 'events.jsonl'
            transcript.write_text('not-json\n' + transcript.read_text())
            failure = catalog.assess_trial(directory, 0, 'a' * 64)
            self.assertEqual(failure['status'], 'invalid')
            self.assertEqual(failure['usage']['input_tokens'], 100)
            self.assertEqual(failure['resources'], resources)
            for event in [{'type': 'turn.failed'}, {'type': 'error'}, None,
                          {'type': 'item.started', 'item': {'type': 'mcp_tool_call'}},
                          {'type': 'item.completed', 'item': []}]:
                self.assertEqual(assess(changed_events=[event, *events])['status'], 'invalid')
            wrong_answer = copy.deepcopy(events)
            wrong_answer[0]['item']['text'] = 'unverified facts'
            self.assertEqual(assess(changed_events=wrong_answer)['status'], 'invalid')
            self.assertEqual(assess(changed_summary={'exit_code': 0, 'timeout': True})['status'], 'invalid')
            self.assertEqual(assess(changed_summary={**summary, 'runtime_bytes_unchanged': False})['status'], 'invalid')
            self.assertEqual(assess(changed_summary={**summary, 'runtime_files_sha256_before': 'b' * 64,
                                                    'runtime_files_sha256_after': 'b' * 64})['status'], 'invalid')
            self.assertEqual(assess(cleaned=False)['status'], 'invalid')
            self.assertEqual(assess(code=1)['status'], 'invalid')
            for key, value in [('abort', 'memory_stop'), ('payload_resource_observation_verified', False),
                               ('payload_resource_observation', {'payload_exit_code': 0, 'payload_cleanup_verified': False})]:
                failed = {**resources, key: value}
                self.assertEqual(assess(changed_resources=failed)['status'], 'invalid')

    def test_built_catalog_keeps_transport_bytes_separate_from_client_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'dist').mkdir()
            catalog.write_json(root / 'dist/mcp-catalog.json', {
                'tools': [{'name': 'one', 'inputSchema': {}, 'outputSchema': {}, 'description': 'one'},
                          {'name': 'two', 'inputSchema': {}, 'outputSchema': {}, 'description': 'two'}]})
            one = catalog.catalog_receipt(root, 'compact', ['one'])
            both = catalog.catalog_receipt(root, 'compact', ['one', 'two'])
            self.assertEqual(one['bytes'], both['bytes'])
            self.assertEqual(one['tool_count'], 2)
            self.assertEqual(one['sha256'], both['sha256'])
            for selected in [[], ['missing'], ['one', 'one']]:
                with self.assertRaises(ValueError):
                    catalog.catalog_receipt(root, 'compact', selected)


if __name__ == '__main__':
    unittest.main()
