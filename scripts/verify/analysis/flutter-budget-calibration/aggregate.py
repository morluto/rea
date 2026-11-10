"""Join serial observer receipts with exact tokenization of every logical call.

Requires tiktoken 0.12.0 for comparison with the retained measurements.
Token counts exclude chat framing, catalogs, adapters, retained delivery and
model reasoning. Artifact and repository path spelling can affect tokens.
"""

import argparse
import json
from pathlib import Path

import tiktoken

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('receipts', type=Path)
parser.add_argument('output', type=Path)
options = parser.parse_args()
encoding = tiktoken.get_encoding('cl100k_base')
rows = []
for path in sorted(options.receipts.rglob('*.metrics.json')):
    metrics = json.loads(path.read_text())
    key = str(path.relative_to(options.receipts)).removesuffix('.metrics.json')
    # The observer argv ends with the selected configuration file.
    config = json.loads(Path(metrics['argv'][-1]).read_text())
    reply = json.loads(Path(config['reply_receipt']).read_text())
    assert metrics['exit_code'] == 0 and metrics['stop_reason'] is None, path
    assert metrics['cleanup'] == 'group_empty' and reply['success'], path
    tokens = sum(
        len(encoding.encode(json.dumps(call[field], ensure_ascii=False, separators=(',', ':'))))
        for call in reply['calls']
        for field in ['request', 'reply']
    )
    rows.append({
        'key': key,
        'calls': reply['call_count'],
        'tokens_cl100k_base': tokens,
        'seconds': metrics['elapsed_seconds'],
        'cpu': metrics['cpu_seconds_waited_subtree'],
        'peak_mib': metrics['peak_process_group_rss_bytes_sampled'] / 1024**2,
        'delivered': reply['package_uris_delivered_final'],
        'cleanup': metrics['cleanup'],
        'scope': reply['boundary'],
    })
assert rows, 'No *.metrics.json receipts found'
options.output.write_text(json.dumps(rows, indent=2) + '\n')
