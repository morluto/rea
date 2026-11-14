"""Reproduce inert FIT carriers with U-Boot 2025.01 and DTC/libfdt 1.7.2."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tool-dir', type=Path, help='directory containing mkimage, dumpimage, dtc, fdtget')
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
env = dict(os.environ, SOURCE_DATE_EPOCH='1700000000')
if args.tool_dir:
    env['PATH'] = str(args.tool_dir.resolve()) + os.pathsep + env['PATH']
tools = {name: shutil.which(name, path=env['PATH']) for name in ['mkimage', 'dumpimage', 'dtc', 'fdtget']}
if not all(tools.values()):
    raise SystemExit('mkimage, dumpimage, dtc and fdtget are required')


def run(name, *argv, cwd=None):
    result = subprocess.run([tools[name], *map(str, argv)], cwd=cwd, env=env,
                            capture_output=True, check=True, timeout=30)
    return result.stdout.decode()


versions = {name: run(name, '-V' if name in ['mkimage', 'dumpimage'] else '--version').strip()
            for name in tools}
assert versions['mkimage'] == 'mkimage version 2025.01', versions
assert versions['dumpimage'] == 'dumpimage version 2025.01', versions
assert versions['dtc'] == versions['fdtget'] == 'Version: DTC 1.7.2', versions
samples = []
with tempfile.TemporaryDirectory(prefix='rea-fit-producer-') as directory:
    cwd = Path(directory)
    declarations = [
        ('wide-positive', [0x12345678, 0x9abcdef0], [0x12345678, 0x9abcdef4]),
        ('wide-top-bit', [0xfedcba98, 0x76543210], [0xfedcba98, 0x76543214]),
        ('one-cell', [0x40200000], [0x40200004]),
    ]
    payloads = [bytes((i * 37 + 11) % 256 for i in range(n)) for n in [15, 19, 7]]
    source = ['/dts-v1/; / { description = "Producer address oracle"; #address-cells = <2>; images {']
    for index, (name, load, entry) in enumerate(declarations):
        (cwd / f'payload{index}').write_bytes(payloads[index])
        cells = lambda values: ' '.join(hex(value) for value in values)
        source.append(f'''{name} {{ description = "{name}"; data = /incbin/("payload{index}");
            type = "kernel"; arch = "arm64"; os = "linux"; compression = "none";
            load = <{cells(load)}>; entry = <{cells(entry)}>;
            hash-1 {{ algo = "sha256"; }}; hash-2 {{ algo = "crc32"; }}; }};''')
    source.append('''}; configurations { default = "conf-1"; conf-1 {
        kernel = "wide-positive"; loadables = "wide-top-bit", "one-cell";
    }; }; };''')
    (cwd / 'input.its').write_text('\n'.join(source))
    for mode, options in [('embedded', []), ('offset', ['-E', '-B', '10']),
                          ('position', ['-E', '-p', '10000'])]:
        path = cwd / f'{mode}.itb'
        listing = run('mkimage', '-f', 'input.its', *options, path, cwd=cwd)
        images = []
        for index, (name, load, entry) in enumerate(declarations):
            node = f'/images/{name}'
            facts = {}
            for field, declared in [('load', load), ('entry', entry)]:
                # libfdt reads the emitted property, independently of REA and the ITS source.
                words = [int(word, 16) for word in run('fdtget', '-t', 'x', path, node, field).split()]
                assert words == declared
                value = 0
                for word in words:
                    value = (value << 32) | word
                facts[field] = hex(value)
                assert hex(value) in listing  # U-Boot's own printed address agrees.
            target = cwd / f'extracted-{index}'
            run('dumpimage', '-T', 'flat_dt', '-p', index, '-o', target, path)
            extracted = target.read_bytes()
            assert extracted == payloads[index]
            images.append({'name': name, **facts, 'size': len(extracted),
                           'sha256': hashlib.sha256(extracted).hexdigest()})
        data = path.read_bytes()
        samples.append({'mode': mode, 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'deflate_base64': base64.b64encode(zlib.compress(data, 9)).decode(),
                        'images': images})
result = {'producer_versions': versions, 'source_date_epoch': env['SOURCE_DATE_EPOCH'], 'samples': samples}
path = Path(__file__).with_name('oracle.json')
if args.check:
    assert json.loads(path.read_text()) == result, 'producer bytes or independent facts changed'
    print('All 3 complete FIT carriers and 9 image/address facts reproduced exactly')
else:
    path.write_text(json.dumps(result, indent=2) + '\n')
