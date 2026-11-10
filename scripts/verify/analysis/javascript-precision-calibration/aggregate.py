"""Aggregate retained observer receipts and complete CLI records; needs tiktoken."""

import argparse
import json
from pathlib import Path
import statistics

import tiktoken


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', type=Path)
    parser.add_argument('output', type=Path)
    options = parser.parse_args()
    encoder = tiktoken.get_encoding('cl100k_base')
    def compact(value):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    rows = []
    for path in sorted(options.inputs.glob('*.metrics.json')):
        metrics = json.loads(path.read_text())
        record = json.loads(path.with_name(path.name.replace('.metrics.json', '.replies.json')).read_text())
        summary = json.loads(path.with_suffix('.stdout').read_text())
        tokens = {
            'arguments': len(encoder.encode(compact(record['argv']))),
            'reply': len(encoder.encode(compact(json.loads(record['stdout'])))),
            'progress_stderr': len(encoder.encode(record['stderr'])),
        }
        rows.append({
            'name': path.stem.removesuffix('.metrics'),
            'task': summary['case'], 'budget': summary['budget'],
            'verified_facts': summary['verified_facts'], 'unknowns': summary['unknowns'],
            'wall_s': metrics['elapsed_seconds'],
            'cpu_s': metrics['cpu_seconds_waited_subtree'],
            'host_group_rss_bytes': metrics['peak_process_group_rss_bytes_sampled'],
            'tokens': tokens, 'reply_bytes': summary['reply_bytes'],
            'exit_code': metrics['exit_code'], 'cleanup': metrics['cleanup'],
            'stop_reason': metrics['stop_reason'],
        })
    medians = []
    for task in ['theme', 'ms']:
        for budget in ['default', 'double']:
            selected = [row for row in rows if row['task'] == task and row['budget'] == budget]
            if not selected:
                continue
            medians.append({
                'task': task, 'budget': budget, 'trials': len(selected),
                'facts': selected[0]['verified_facts'], 'unknowns': selected[0]['unknowns'],
                'wall_s': statistics.median(row['wall_s'] for row in selected),
                'cpu_s': statistics.median(row['cpu_s'] for row in selected),
                'host_group_rss_mib': statistics.median(row['host_group_rss_bytes'] / 1048576 for row in selected),
                'tokens': statistics.median(sum(row['tokens'].values()) for row in selected),
                'reply_bytes': selected[0]['reply_bytes'],
            })
    options.output.write_text(json.dumps({'rows': rows, 'medians': medians}, indent=2) + '\n')


if __name__ == '__main__':
    main()
