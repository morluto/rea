"""Independently enumerate bounded printable runs in two pinned Flutter APKs.

This intentionally small ELF64LE parser is for these verified artifacts, not a
replacement for production parsing. It uses no REA implementation code.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('inputs', type=Path)
parser.add_argument('output', type=Path)
options = parser.parse_args()
options.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((Path(__file__).parent / 'manifest.json').read_text())
for item in manifest['artifacts']:
    apk = options.inputs / item['file']
    assert apk.stat().st_size == item['bytes'], apk
    with apk.open('rb') as source:
        artifact_digest = hashlib.file_digest(source, 'sha256').hexdigest()
    assert artifact_digest == item['sha256'], apk
    with zipfile.ZipFile(apk) as archive:
        data = archive.read('lib/arm64-v8a/libapp.so')
    assert data[:6] == b'\x7fELF\x02\x01', apk
    section_offset = struct.unpack_from('<Q', data, 40)[0]
    section_size, section_count = struct.unpack_from('<HH', data, 58)
    sections = [
        struct.unpack_from('<IIQQQQIIQQ', data, section_offset + i * section_size)
        for i in range(section_count)
    ]
    found = []
    for section in sections:
        if section[1] != 11:  # SHT_DYNSYM
            continue
        strings = sections[section[6]]
        names = data[strings[4]:strings[4] + strings[5]]
        for at in range(section[4], section[4] + section[5], section[9]):
            name, _, _, index, value, size = struct.unpack_from('<IBBHQQ', data, at)
            end = names.find(b'\0', name)
            if names[name:end] != b'_kDartIsolateSnapshotData':
                continue
            owner = sections[index]
            offset = owner[4] + value - owner[3]
            assert 0 <= offset <= len(data) - size
            found.append((offset, size))
    assert len(found) == 1, (apk, found)
    offset, size = found[0]
    runs = re.findall(rb'[\x20-\x7e]+', data[offset:offset + size])
    oracle = {
        'artifact': str(apk),
        'artifact_sha256': artifact_digest,
        'libapp_sha256': hashlib.sha256(data).hexdigest(),
        'abi': 'arm64-v8a',
        'section': {
            'name': '_kDartIsolateSnapshotData',
            'offset': offset,
            'size': size,
        },
        'oracle': 'Independent Python ELF DYNSYM/section mapping and byte regex; no REA parser used',
        'policies': {},
    }
    for run_bytes in [1024, 4096]:
        selected = [run for run in runs if 5 <= len(run) <= run_bytes]
        packages = sorted({run.decode('ascii') for run in selected if run.startswith(b'package:')})
        darts = sorted({run.decode('ascii') for run in selected if run.startswith(b'dart:')})
        oracle['policies'][str(run_bytes)] = {
            'package_uris': packages,
            'dart_uris': darts,
            'package_count': len(packages),
            'dart_count': len(darts),
            'longest_printable_run': max(map(len, runs)),
            'overflowed_runs': sum(len(run) > run_bytes for run in runs),
        }
    assert oracle['libapp_sha256'] == item['expected_libapp_sha256']
    assert oracle['section'] == item['expected_isolate_section']
    assert oracle['policies']['1024']['package_count'] == item['expected_package_count_1024']
    assert oracle['policies']['1024']['dart_count'] == item['expected_dart_count_1024']
    target = options.output / (apk.stem + '.oracle.json')
    target.write_text(json.dumps(oracle, indent=2) + '\n')
    print(json.dumps({
        'oracle': str(target),
        'artifact_sha256': artifact_digest,
        'libapp_sha256': oracle['libapp_sha256'],
        'section': oracle['section'],
        'policies': {
            key: {name: value for name, value in policy.items() if not isinstance(value, list)}
            for key, policy in oracle['policies'].items()
        },
    }))
