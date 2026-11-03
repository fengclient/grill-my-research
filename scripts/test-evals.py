#!/usr/bin/env python3

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
source = root / 'evals/results/2026-11-02'
scenarios = ['valid', 'missing-run', 'duplicate-run', 'removed-model', 'changed-output',
             'missing-trace', 'changed-trace', 'missing-entry', 'failed-behavior', 'missed-control', 'pending-review']
for scenario in scenarios:
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary) / 'results'
        shutil.copytree(source, target)
        manifest_path = target / 'manifest.json'
        verdict_path = target / 'verdict.json'
        manifest = json.loads(manifest_path.read_text())
        verdict = json.loads(verdict_path.read_text())
        first = manifest['runs'][0]
        if scenario == 'missing-run':
            manifest['runs'].pop()
        elif scenario == 'duplicate-run':
            manifest['runs'].append(first)
        elif scenario == 'removed-model':
            removed = manifest['models'].pop()
            excluded = {r['label'] for r in manifest['runs'] if r['model'] == removed}
            manifest['runs'] = [r for r in manifest['runs'] if r['label'] not in excluded]
            verdict['reviews'] = [r for r in verdict['reviews'] if r['label'] not in excluded]
        elif scenario == 'changed-output':
            (target / first['output']).write_text('This response was replaced.\n')
        elif scenario == 'missing-trace':
            (target / first['trace']).unlink()
        elif scenario == 'changed-trace':
            (target / first['trace']).write_text('{}\n')
        elif scenario == 'missing-entry':
            trace_path = target / first['trace']
            trace = json.loads(trace_path.read_text())
            trace['reads'] = []
            trace_path.write_text(json.dumps(trace))
            first['trace_sha256'] = hashlib.sha256(trace_path.read_bytes()).hexdigest()
        elif scenario == 'failed-behavior':
            next(r for r in verdict['reviews'] if r['label'] == first['label'])['criteria']['intent'] = 'fail'
        elif scenario == 'missed-control':
            control = next(r for r in verdict['reviews'] if r['label'] == manifest['negative_control']['label'])
            control['criteria'] = {key: 'pass' for key in control['criteria']}
        elif scenario == 'pending-review':
            manifest['manual_review'] = 'pending'
        manifest_path.write_text(json.dumps(manifest))
        verdict_path.write_text(json.dumps(verdict))
        result = subprocess.run([sys.executable, str(root / 'scripts/check-evals.py'), str(target)],
                                capture_output=True, text=True)
        passed = result.returncode == 0
        if passed != (scenario == 'valid'):
            sys.exit(f'FAIL: {scenario}\n{result.stdout}{result.stderr}')
        print(f'PASS: {scenario}')
