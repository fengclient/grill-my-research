#!/usr/bin/env python3

import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
scenarios = ['valid', 'invalid-version', 'missing-changelog', 'changed-skill',
             'extra-file', 'symlink', 'existing-artifact']
for scenario in scenarios:
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary)
        for directory in ['scripts', 'skills', 'evals']:
            shutil.copytree(root / directory, target / directory)
        for filename in ['VERSION', 'CHANGELOG.md']:
            shutil.copyfile(root / filename, target / filename)
        version = (target / 'VERSION').read_text().strip()
        skill = target / 'skills/grill-my-research'
        dist = target / 'dist'
        name = f'grill-my-research-{version}.zip'
        if scenario == 'invalid-version':
            (target / 'VERSION').write_text('../invalid\n')
        elif scenario == 'missing-changelog':
            (target / 'CHANGELOG.md').write_text('# Changelog\n')
        elif scenario == 'changed-skill':
            with (skill / 'SKILL.md').open('a') as entry:
                entry.write('\nChanged after evaluation.\n')
        elif scenario == 'extra-file':
            (skill / '.unexpected').write_text('Not evaluated.\n')
        elif scenario == 'symlink':
            (skill / 'linked-version').symlink_to(target / 'VERSION')
        elif scenario == 'existing-artifact':
            dist.mkdir()
            (dist / name).write_bytes(b'Previously built content')
        command = [sys.executable, str(target / 'scripts/build-release.py'),
                   '--evals', 'evals/results/2026-11-02']
        result = subprocess.run(command, cwd=target, capture_output=True, text=True)
        if (result.returncode == 0) != (scenario == 'valid'):
            sys.exit(f'FAIL: {scenario}\n{result.stdout}{result.stderr}')
        if scenario == 'valid':
            before = {path.name: path.read_bytes() for path in dist.iterdir()}
            digest = hashlib.sha256(before[name]).hexdigest()
            assert before[f'{name}.sha256'] == f'{digest}  {name}\n'.encode()
            with zipfile.ZipFile(dist / name) as bundle:
                expected = {p.relative_to(skill).as_posix(): p.read_bytes()
                            for p in skill.rglob('*') if p.is_file()}
                assert {item: bundle.read(item) for item in bundle.namelist()} == expected
                assert 'SKILL.md' in bundle.namelist()
            repeated = subprocess.run(command, cwd=target, capture_output=True, text=True)
            assert repeated.returncode == 0, repeated.stderr
            assert before == {path.name: path.read_bytes() for path in dist.iterdir()}
        elif scenario == 'existing-artifact':
            assert list(dist.iterdir()) == [dist / name]
            assert (dist / name).read_bytes() == b'Previously built content'
        else:
            assert not dist.exists(), 'Rejected input created release artifacts'
        print(f'PASS: {scenario}')
