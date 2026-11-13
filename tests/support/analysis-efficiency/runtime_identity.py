"""One byte-identity owner shared by matrix admission and guarded trials."""

import hashlib
import json


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_fingerprint(root):
    files = []
    for name in ['dist', 'bridge']:
        for path in sorted((root / name).rglob('*')):
            if path.is_symlink():
                raise ValueError('Runtime fingerprint does not follow symlinks')
            if path.is_file():
                files.append({'path': path.relative_to(root).as_posix(), 'sha256': file_digest(path)})
    files.sort(key=lambda row: row['path'])
    text = json.dumps(files, separators=(',', ':'), ensure_ascii=False)
    return files, hashlib.sha256(text.encode()).hexdigest()
