"""Distinct capture/cleanup failures; simulated CLI is not real-model evidence."""

import importlib.util
import io
import json
import os
import runpy
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from codex_context import capture_tool_context, selected_event


class ManagedCoverageTests(unittest.TestCase):
    def test_verifies_extra_counts_and_preserves_unknown_fields(self):
        review = runpy.run_path(str(Path(__file__).with_name('review-model.py')))
        project = review['scope_with_verified_counts']
        expected = {'state': 'partial', 'issues': ['unreturned rows remain unknown']}
        original = {**expected, 'module_ref_count': 0, 'pinvoke_import_count': 2}
        scope, checks = project(original, expected, {'module_ref_count': 0, 'pinvoke_import_count': 2})
        self.assertEqual(scope, expected)
        self.assertTrue(all(checks.values()))
        self.assertEqual(original['pinvoke_import_count'], 2)
        for count in [3, '2', True]:
            scope, checks = project({**expected, 'pinvoke_import_count': count}, expected, {'pinvoke_import_count': 2})
            self.assertFalse(checks['pinvoke_import_count'])
        _, checks = project({**expected, 'module_ref_count': False}, {**expected, 'module_ref_count': 0}, {'module_ref_count': 0})
        self.assertFalse(checks['module_ref_count'])
        scope, _ = project({**expected, 'unsupported_claim': True}, expected, {})
        self.assertNotEqual(scope, expected)
        scope, _ = project({'state': 'partial', 'module_ref_count': 0}, expected, {'module_ref_count': 0})
        self.assertNotEqual(scope, expected)
        ambiguous = review['named_scope']({'native_boundaries': expected, 'native_boundary_declarations': {'state': 'complete'}}, ['native_boundaries', 'native_boundary_declarations'])
        scope, _ = project(ambiguous, expected, {'module_ref_count': 0})
        self.assertNotEqual(scope, expected)


class ContextCaptureTests(unittest.TestCase):
    def test_filters_ambient_account_and_nested_usage_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            sessions = home / 'sessions'
            sessions.mkdir(parents=True)
            output = root / 'output'
            output.mkdir()
            events = [
                {'type': 'world_state', 'payload': {'state': {'env': 'ambient-marker'}}},
                {'type': 'session_meta', 'payload': {'creator_account_id': 'account-marker'}},
                {'type': 'response_item', 'payload': {
                    'type': 'custom_tool_call_output', 'call_id': 'original-call',
                    'output': 'caller-selected evidence and paths',
                    'internal_chat_message_metadata_passthrough': 'private-marker'}},
                {'type': 'token_usage_record', 'payload': {
                    'response_id': 'original-response', 'usage': {
                        'input_tokens': 12, 'cached_input_tokens': 4,
                        'environment': 'nested-ambient-marker'},
                    'transport_auth': 'auth-marker'}},
            ]
            (sessions / 'rollout.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in events))
            (home / 'auth.json').write_text('copied-credential-marker')
            receipt = capture_tool_context(home, output)
            text = (output / 'codex-tool-context.jsonl').read_text()
            self.assertEqual(receipt['status'], 'captured')
            self.assertEqual(receipt['retained_events'], 2)
            for marker in ['ambient-marker', 'account-marker', 'private-marker',
                           'auth-marker', 'copied-credential-marker']:
                self.assertNotIn(marker, text)
            self.assertIn('caller-selected evidence and paths', text)
            self.assertIn('original-response', text)
            self.assertEqual((output / 'codex-tool-context.jsonl').stat().st_mode & 0o777, 0o600)

    def test_missing_rollouts_are_unknown_and_malformed_lines_remain_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'missing'
            output.mkdir()
            self.assertEqual(capture_tool_context(root / 'home', output)['status'], 'unavailable')
            sessions = root / 'home' / 'sessions'
            sessions.mkdir(parents=True)
            (sessions / 'rollout.jsonl').write_text('not-json\n' + json.dumps({
                'type': 'event_msg', 'payload': {'type': 'token_count', 'info': None}}) + '\n')
            partial = root / 'partial'
            partial.mkdir()
            receipt = capture_tool_context(root / 'home', partial)
            self.assertEqual(receipt['status'], 'partial')
            self.assertEqual(receipt['errors'][0]['line'], 1)
            self.assertEqual(receipt['retained_events'], 1)
        with self.assertRaises(ValueError):
            selected_event({'type': 'token_usage_record', 'payload': {'usage': {'input_tokens': True}}})
        with self.assertRaises(ValueError):
            selected_event({'type': {'environment': 'unexpected'}, 'payload': {}})
        with self.assertRaises(ValueError):
            selected_event({'type': 'response_item', 'timestamp': {'environment': 'unexpected'}, 'payload': {}})
        unknown = selected_event({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {'model_context_window': None}}})
        self.assertIsNone(unknown['payload']['info']['model_context_window'])

    def test_capture_failure_still_removes_trial_credentials_and_profile(self):
        spec = importlib.util.spec_from_file_location('agent_trial', Path(__file__).with_name('agent-trial.py'))
        agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(agent)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'runtime'
            (runtime / 'scripts').mkdir(parents=True)
            (runtime / 'scripts' / 'rea.mjs').write_text('')
            (runtime / 'package-lock.json').write_text('{}')
            auth_home = root / 'source-auth'
            auth_home.mkdir()
            (auth_home / 'auth.json').write_text('synthetic-credential')
            question = root / 'question.txt'
            question.write_text('Observe the declared fixture.')
            output = root / 'trial'
            child = Mock(stdin=io.StringIO())
            child.wait.return_value = 0
            arguments = ['agent-trial.py', '--runtime-root', str(runtime), '--revision', 'fixture',
                         '--prompt', str(question), '--output', str(output), '--capture-tool-context']
            with patch.dict(os.environ, {'CODEX_HOME': str(auth_home)}, clear=True), \
                    patch.object(sys, 'argv', arguments), \
                    patch.object(agent.shutil, 'which', return_value='/fixture/node'), \
                    patch.object(agent.subprocess, 'check_output', return_value='v24.18.0\n'), \
                    patch.object(agent.subprocess, 'Popen', return_value=child), \
                    patch.object(agent, 'capture_tool_context', side_effect=OSError('fixture capture failure')), \
                    patch('builtins.print'):
                with self.assertRaisesRegex(OSError, 'fixture capture failure'):
                    agent.main()
            self.assertFalse(list(output.glob('profile-*')))
            self.assertTrue(json.loads((output / 'cleanup.json').read_text())['profile_removed'])
            self.assertEqual((auth_home / 'auth.json').read_text(), 'synthetic-credential')

    def test_refuses_foreign_session_directory_and_symlink_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            home.mkdir()
            foreign = root / 'foreign'
            foreign.mkdir()
            (foreign / 'rollout.jsonl').write_text('private marker')
            (home / 'sessions').symlink_to(foreign, target_is_directory=True)
            output = root / 'directory-result'
            output.mkdir()
            receipt = capture_tool_context(home, output)
            self.assertEqual(receipt['status'], 'partial')
            self.assertEqual(receipt['retained_events'], 0)
            (home / 'sessions').unlink()
            (home / 'sessions').mkdir()
            (home / 'sessions' / 'linked.jsonl').symlink_to(foreign / 'rollout.jsonl')
            output = root / 'file-result'
            output.mkdir()
            receipt = capture_tool_context(home, output)
            self.assertEqual(receipt['status'], 'partial')
            self.assertEqual(receipt['errors'][0]['reason'], 'not_an_owned_regular_file')
            self.assertEqual((foreign / 'rollout.jsonl').read_text(), 'private marker')

    def test_guidance_requires_selected_tools_before_acquiring_a_profile(self):
        spec = importlib.util.spec_from_file_location('agent_trial', Path(__file__).with_name('agent-trial.py'))
        agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(agent)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'trial'
            arguments = ['agent-trial.py', '--runtime-root', str(root), '--revision', 'fixture',
                         '--prompt', str(root / 'question'), '--output', str(output), '--guide-enabled-tools']
            with patch.object(sys, 'argv', arguments), patch.object(sys, 'stderr', io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    agent.main()
            self.assertEqual(raised.exception.code, 2)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
