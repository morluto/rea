"""Acquire pinned public artifacts read-only and construct explicitly incomplete analyst manifests."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

manifest_path, destination = map(Path, sys.argv[1:])
destination.mkdir(parents=True, exist_ok=True)
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
(destination / 'artifacts.json').write_bytes(manifest_bytes)
for item in manifest:
    for artifact in [item, *([item['generated_script']] if 'generated_script' in item else [])]:
        with urllib.request.urlopen(artifact['url'], timeout=30) as response:
            data = response.read(16 * 1024 * 1024)
        assert len(data) == artifact['bytes']
        assert hashlib.sha256(data).hexdigest() == artifact['sha256'], artifact['url']
        (destination / artifact['path']).write_bytes(data)
    if 'generated_script' not in item:
        continue
    script = item['generated_script']
    (destination / 'files').mkdir(exist_ok=True)
    (destination / 'files' / script['path']).write_bytes((destination / script['path']).read_bytes())
    context = {
        'capture_path': str((destination / 'artifacts.json').resolve()),
        'capture_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'capture_kind': 'browser-scenario',
        'source_evidence_id': None,
        'capture_completeness': {
            'status': 'incomplete', 'equality_eligible': False,
            'missing_sections': ['action', 'screenshot', 'dom', 'accessibility', 'url', 'history', 'storage', 'events', 'frames', 'workers', 'popups', 'websockets'],
            'truncated_sections': [],
        },
        'output_directory': str(destination.resolve()),
        'analysis_input': {'input_path': str(destination.resolve()), 'format': 'directory'},
        'limitations': ['Constructed analyst manifest over pinned public HTTP bytes. capture_path identifies the artifact manifest, not a browser capture. No capture, deployment authenticity or execution is asserted.'],
        'scripts': [{
            'url': script['url'],
            'source': {'kind': 'scenario-response', 'transaction_id': 'read-only-public-http', 'request_sequence': 1, 'response_sequence': 2, 'status': 200},
            'content': {'state': 'exported', 'relative_path': script['path'], 'layout': 'isolated', 'layout_reason': 'explicit-public-artifact-selection', 'sha256': script['sha256'], 'bytes': script['bytes'], 'media_type': 'text/javascript', 'redacted': False, 'representation': 'browser-decoded-response-bytes'},
        }],
    }
    (destination / (script['path'] + '.manifest.json')).write_text(json.dumps(context))
