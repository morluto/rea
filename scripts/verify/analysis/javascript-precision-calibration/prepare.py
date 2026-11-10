"""Verify pinned inputs and prepare inert application directories and an oracle."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def theme_values(source):
    prefix, suffix = 'export const theme = {', '};\n'
    if not source.startswith(prefix) or not source.endswith(suffix):
        raise ValueError('Expected the pinned literal-only theme declaration')
    body = source[len(prefix):-len(suffix)]
    pair = re.compile(r"\s*([A-Za-z_]\w*)\s*:\s*'([^'\\]*)'\s*,")
    values = {}
    position = 0
    while body[position:].strip():
        item = pair.match(body, position)
        if item is None or item[1] in values:
            raise ValueError('Oracle only accepts distinct literal CSS property declarations')
        values[item[1]] = item[2]
        position = item.end()
    if len(values) != 237:
        raise ValueError('The pinned source must declare 237 theme properties')
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('source_map', type=Path)
    parser.add_argument('output', type=Path)
    options = parser.parse_args()
    manifest = json.loads((Path(__file__).parent / 'manifest.json').read_text())
    pinned = manifest['theme']
    if sha256(options.source_map) != pinned['map_sha256']:
        parser.error('Source-map digest does not match the pinned artifact')
    document = json.loads(options.source_map.read_text())
    matching = [text for name, text in zip(document['sources'], document['sourcesContent'])
                if name == pinned['reported_source']]
    if len(matching) != 1 or matching[0] is None:
        parser.error('Expected one embedded original theme source')
    source = matching[0]
    if hashlib.sha256(source.encode()).hexdigest() != pinned['source_sha256']:
        parser.error('Embedded source digest mismatch')
    theme = options.output / 'cases/theme'
    control = options.output / 'cases/ms'
    theme.mkdir(parents=True, exist_ok=True)
    control.mkdir(parents=True, exist_ok=True)
    (theme / 'theme.ts').write_text(source)
    (theme / 'package.json').write_text(json.dumps({
        'name': 'rea-captured-theme-calibration', 'type': 'module', 'main': 'theme.ts',
    }))
    for name, digest in manifest['ms']['files'].items():
        path = options.repo / 'node_modules/ms' / name
        if sha256(path) != digest:
            parser.error(f'Installed ms input digest mismatch: {name}')
        shutil.copyfile(path, control / name)
    oracle = {
        'theme': {'source_file': 'theme.ts', 'source_sha256': pinned['source_sha256'],
                  'expected': theme_values(source)},
        'ms': {'source_file': 'index.js',
               'source_sha256': manifest['ms']['files']['index.js'], 'expected': {'s': 1000}},
    }
    options.output.mkdir(parents=True, exist_ok=True)
    (options.output / 'oracle.json').write_text(json.dumps(oracle, indent=2) + '\n')


if __name__ == '__main__':
    main()
