"""Run one complete CLI task and independently check the required source facts."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('node')
    parser.add_argument('inputs', type=Path)
    parser.add_argument('case', choices=['theme', 'ms'])
    parser.add_argument('budget', choices=['default', 'double'])
    parser.add_argument('output', type=Path)
    options = parser.parse_args()
    oracle = json.loads((options.inputs / 'oracle.json').read_text())[options.case]
    target = options.inputs / 'cases' / options.case
    source = target / oracle['source_file']
    if hashlib.sha256(source.read_bytes()).hexdigest() != oracle['source_sha256']:
        raise ValueError('Selected source digest does not match the oracle')
    argv = [options.node, str(options.repo / 'scripts/rea.mjs'),
            'analyze-javascript-application', str(target), '--max-heap-mb', '512',
            '--format', 'json']
    if options.budget == 'double':
        argv += ['--semantic-precision', '{"primitive_bytes":2097152}']
    environment = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=512'}
    result = subprocess.run(argv, cwd=options.repo, env=environment, capture_output=True,
                            text=True, timeout=45)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps({
        'argv': argv, 'stdout': result.stdout, 'stderr': result.stderr,
        'exit_code': result.returncode,
    }) + '\n')
    if result.returncode != 0:
        raise RuntimeError(f'CLI failed: {result.stderr[:500]}')
    evidence = json.loads(result.stdout)
    graph = evidence['normalized_result']['semantic_graph']
    nodes = {node['node_id']: node for node in graph['nodes']}
    if any(node['identity']['artifact_sha256'] != oracle['source_sha256']
           for node in nodes.values()
           if node['identity']['module_path'] == oracle['source_file']):
        raise ValueError('Selected graph source identity differs from the oracle')
    facts = {}
    for edge in graph['relations']:
        if edge['relation'] != 'defines':
            continue
        left, right = nodes[edge['source_node_id']], nodes[edge['target_node_id']]
        if left['kind'] != 'literal':
            continue
        if options.case == 'theme' and right['kind'] == 'property-slot':
            facts[right['properties']['name']] = left['properties']['value']
        if options.case == 'ms' and right['kind'] == 'binding' and right['label'] == 's':
            facts['s'] = left['properties']['value']
    if facts != oracle['expected']:
        raise ValueError('Required source facts differ from the independent oracle')
    if any('primitive-bytes' in json.dumps(unknown) for unknown in graph['unknowns']):
        raise ValueError('Selected byte allowance unexpectedly limited the task')
    print(json.dumps({
        'case': options.case, 'budget': options.budget, 'verified_facts': len(facts),
        'source_sha256': oracle['source_sha256'],
        'reply_bytes': len(result.stdout.encode()), 'unknowns': len(graph['unknowns']),
    }))


if __name__ == '__main__':
    main()
