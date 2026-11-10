"""Generate eight task configs after oracle.py has verified the pinned APKs."""

import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('inputs', type=Path)
parser.add_argument('output', type=Path)
options = parser.parse_args()
options.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((Path(__file__).parent / 'manifest.json').read_text())
cases = [
    ('inventory-default-retry', 'package-inventory', None, True),
    ('inventory-2048', 'package-inventory', 2048, False),
    ('overview-default', 'overview', None, False),
    ('overview-2048', 'overview', 2048, False),
]
for item in manifest['artifacts']:
    stem = Path(item['file']).stem
    oracle = (options.output / f'{stem}.oracle.json').resolve()
    if not oracle.exists():
        parser.error(f'Run oracle.py first: {oracle}')
    for case, task, limit, recover in cases:
        config = {
            'artifact': str((options.inputs / item['file']).resolve()),
            'oracle': str(oracle),
            'task': task,
            'recover': recover,
            'recovery_uri_limit': 2048,
            'reply_receipt': str((options.output / f'{stem}.{case}.replies.json').resolve()),
        }
        if limit is not None:
            config['first_uri_limit'] = limit
        (options.output / f'{stem}.{case}.config.json').write_text(
            json.dumps(config, indent=2) + '\n'
        )
