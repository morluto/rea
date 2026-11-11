"""Authored receipt validation controls; no performance measurements are run."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
AGGREGATE = ROOT / 'scripts/verify/analysis/javascript-precision-calibration/aggregate.py'


class CalibrationReceipts(unittest.TestCase):
    def aggregate(self, folder):
        # Tokenization is outside these receipt validity tests. Avoid requiring
        # an external tokenizer download; no token count is asserted or reported.
        encoder = types.SimpleNamespace(encode=lambda text: text.encode())
        tokenizer = types.SimpleNamespace(get_encoding=lambda _: encoder)
        with patch.dict(sys.modules, {'tiktoken': tokenizer}):
            spec = importlib.util.spec_from_file_location('receipt_aggregate', AGGREGATE)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            output = folder / 'aggregate.json'
            with patch.object(sys, 'argv', [str(AGGREGATE), str(folder), str(output)]):
                module.main()
            return json.loads(output.read_text())

    def complete(self, folder):
        for trial in [1, 2, 3]:
            for task in ['theme', 'ms']:
                for budget in ['default', 'double']:
                    name = f'r{trial}-{task}-{budget}'
                    metrics = dict(exit_code=0, stop_reason=None, observer_error=None,
                                   cleanup='group_empty', remaining_group_pids=[], signal_errors=[],
                                   elapsed_seconds=1, cpu_seconds_waited_subtree=0.5,
                                   peak_process_group_rss_bytes_sampled=1024)
                    (folder / (name + '.metrics.json')).write_text(json.dumps(metrics))
                    (folder / (name + '.replies.json')).write_text(json.dumps(
                        dict(argv=['authored-cli'], stdout='{}', stderr='', exit_code=0)))
                    (folder / (name + '.metrics.stdout')).write_text(json.dumps(dict(
                        case=task, budget=budget, verified_facts=1, unknowns=0, reply_bytes=2)))

    def test_complete_clean_trials_aggregate(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            self.complete(folder)
            report = self.aggregate(folder)
            self.assertEqual(len(report['rows']), 12)
            self.assertEqual([row['trials'] for row in report['medians']], [3] * 4)

    def test_empty_and_incomplete_trials_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self.assertRaisesRegex(ValueError, 'complete twelve-trial'):
                self.aggregate(folder)
            self.complete(folder)
            (folder / 'r3-ms-double.metrics.json').unlink()
            with self.assertRaisesRegex(ValueError, 'complete twelve-trial'):
                self.aggregate(folder)

    def test_printed_valid_answer_cannot_hide_observer_or_cleanup_failure(self):
        for key, value in [('exit_code', 1), ('stop_reason', 'timeout'),
                           ('observer_error', {'reason': 'failed snapshot'}),
                           ('cleanup', 'group_members_remaining'),
                           ('remaining_group_pids', [123]),
                           ('signal_errors', [{'reason': 'denied'}])]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                self.complete(folder)
                path = folder / 'r1-theme-default.metrics.json'
                metrics = json.loads(path.read_text())
                metrics[key] = value
                path.write_text(json.dumps(metrics))
                with self.assertRaisesRegex(ValueError, 'Unsuccessful or unconfirmed'):
                    self.aggregate(folder)
                self.assertFalse((folder / 'aggregate.json').exists())

    def test_failed_cli_receipt_and_mislabeled_summary_are_refused(self):
        for suffix, update in [('replies.json', {'exit_code': 1}),
                               ('metrics.stdout', {'budget': 'double'})]:
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                self.complete(folder)
                path = folder / ('r1-theme-default.' + suffix)
                record = json.loads(path.read_text())
                record.update(update)
                path.write_text(json.dumps(record))
                with self.assertRaisesRegex(ValueError, 'identity or completion'):
                    self.aggregate(folder)
