"""Independent source-map VLQ artifact oracle; standard library only."""
import hashlib
import json
from pathlib import Path

ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

def values(segment):
    output, value, shift = [], 0, 0
    for character in segment:
        digit = ALPHABET.index(character)
        value += (digit & 31) << shift
        if digit & 32:
            shift += 5
        else:
            output.append(-(value >> 1) if value & 1 else value >> 1)
            value, shift = 0, 0
    assert shift == 0
    return output

def inspect(path):
    data = Path(path).read_bytes()
    raw = json.loads(data)
    source = original_line = original_column = 0
    count, mapped_count, first, matches = 0, 0, None, []
    for line, row in enumerate(raw['mappings'].split(';'), 1):
        column = 0
        for segment in row.split(','):
            if not segment:
                continue
            count += 1
            fields = values(segment)
            column += fields[0]
            if len(fields) > 1:
                assert len(fields) in (4, 5)
                mapped_count += 1
                source += fields[1]
                original_line += fields[2]
                original_column += fields[3]
            if first is None and len(fields) > 1:
                first = {'line': line, 'column': column}
            if first == {'line': line, 'column': column}:
                if len(fields) == 1:
                    matches.append({'generated_only': True})
                else:
                    text = raw['sourcesContent'][source]
                    matches.append({'source_index':source,'source':raw['sources'][source],
                        'original_line':original_line+1,'original_column':original_column,
                        'content_sha256':hashlib.sha256(text.encode()).hexdigest() if text is not None else None})
    lines = raw['mappings'].count(';')+1
    return {'sha256':hashlib.sha256(data).hexdigest(), 'bytes':len(data),
        'segment_count':count, 'mapped_count':mapped_count, 'record_count':1+len(raw['sources'])+len(raw['names'])+len(raw['sourcesContent'])+lines+count,
        'point':first,'expected_matches':matches}

if __name__ == '__main__':
    import sys
    manifest = json.loads(Path(sys.argv[1]).read_text())
    for source in manifest:
        observed = inspect(Path(sys.argv[1]).resolve().parent / source['path'])
        for key, value in observed.items():
            assert source[key] == value, (source['path'], key, source[key], value)
    print(json.dumps({'verified_maps':len(manifest), 'sha256s':[source['sha256'] for source in manifest]}))
