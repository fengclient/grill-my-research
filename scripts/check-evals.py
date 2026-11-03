#!/usr/bin/env python3

import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    sys.exit('Usage: python3 scripts/check-evals.py <result-directory>')
run_dir = Path(sys.argv[1]).resolve()
errors = []
try:
    manifest = json.loads((run_dir / 'manifest.json').read_text())
    verdict = json.loads((run_dir / 'verdict.json').read_text())
    cases = json.loads((root / 'evals/cases.json').read_text())
    plan = json.loads((root / 'evals/plan.json').read_text())
    criteria = {'intent', 'interaction', 'autonomy', 'usable', 'evidence'}
    case_ids = {case['id'] for case in cases}
    models = manifest['models']
    if models != plan['models'] or any(row['effort'] != plan['effort'] for row in manifest['runs']):
        errors.append('model or effort differs from the evaluation plan')
    if not models or len(models) != len(set(models)):
        errors.append('models must be nonempty and unique')
    expected = {(case, model) for case in case_ids for model in models}
    runs = manifest['runs']
    actual = [(row['case_id'], row['model']) for row in runs]
    if set(actual) != expected or len(actual) != len(expected):
        errors.append('case/model matrix is missing, duplicated or unexpected')
    skill = root / 'skills/grill-my-research'
    current_files = {str(p.relative_to(skill)) for p in skill.rglob('*') if p.is_file()}
    if set(manifest['skill_sha256']) != current_files:
        errors.append('skill file inventory changed')
    for name, digest in manifest['skill_sha256'].items():
        path = (skill / name).resolve()
        if not path.is_relative_to(skill.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            errors.append(f'skill changed: {name}')
    if hashlib.sha256((root / 'evals/cases.json').read_bytes()).hexdigest() != manifest['cases_sha256']:
        errors.append('case definitions changed')
    if hashlib.sha256((root / 'evals/rubric.md').read_bytes()).hexdigest() != manifest['rubric_sha256']:
        errors.append('rubric changed')
    if hashlib.sha256((root / 'evals/plan.json').read_bytes()).hexdigest() != manifest['plan_sha256']:
        errors.append('evaluation plan changed')
    reviews = verdict['reviews']
    labels = [r['label'] for r in reviews]
    control = manifest['negative_control']
    required_labels = {row['label'] for row in runs} | {control['label']}
    if set(labels) != required_labels or len(labels) != len(required_labels):
        errors.append('reviews are missing, duplicated or unexpected')
    by_label = {row['label']: row for row in reviews}
    run_labels = [row['label'] for row in runs]
    if len(run_labels) != len(set(run_labels)) or control['label'] in run_labels:
        errors.append('output labels must be unique')
    for row in [*runs, control]:
        label = row['label']
        output = (run_dir / row['output']).resolve()
        if not output.is_relative_to(run_dir) or not output.read_text().strip():
            errors.append(f'{label}: missing output')
            continue
        if hashlib.sha256(output.read_bytes()).hexdigest() != row['output_sha256']:
            errors.append(f'{label}: output changed')
        review = by_label.get(label, {})
        grades = review.get('criteria', {})
        if review.get('case_id') != row['case_id'] or set(grades) != criteria:
            errors.append(f'{label}: invalid criteria or case')
        if any(value not in ['pass', 'fail'] for value in grades.values()) or not review.get('evidence'):
            errors.append(f'{label}: invalid verdict or missing rationale')
        if row is control:
            if not all(grades.get(key) == 'fail' for key in ['intent', 'autonomy', 'evidence']):
                errors.append('negative control was not rejected')
            continue
        if any(grades.get(key) != 'pass' for key in criteria):
            errors.append(f'{label}: behavior failed')
        trace_path = (run_dir / row['trace']).resolve()
        if not trace_path.is_relative_to(run_dir):
            errors.append(f'{label}: trace outside result directory')
            continue
        if hashlib.sha256(trace_path.read_bytes()).hexdigest() != row['trace_sha256']:
            errors.append(f'{label}: trace changed')
        trace = json.loads(trace_path.read_text())
        entry = (skill / 'SKILL.md').read_text()
        reads = trace.get('reads', [])
        if not any(read.get('file') == 'SKILL.md' and read.get('tool_call_id')
                   and entry in read.get('tool_output', '') for read in reads):
            errors.append(f'{label}: entry read not evidenced')
        if not trace.get('runtime_log_sha256') or not trace.get('response_origin'):
            errors.append(f'{label}: runtime provenance missing')
    if manifest.get('manual_review') != 'complete':
        errors.append('manual synthesis incomplete')
except (OSError, ValueError, KeyError, TypeError) as error:
    errors.append(f'incomplete or invalid evidence: {error}')

if errors:
    print('\n'.join(f'FAIL: {error}' for error in errors), file=sys.stderr)
    sys.exit(1)
print(f'PASS: {len(runs)} responses across {len(case_ids)} cases and {len(models)} models; negative control rejected.')
print('This checks saved evidence. It does not rerun models or prove downstream research quality.')
