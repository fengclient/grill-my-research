#!/usr/bin/env python3

import argparse
import hashlib
import io
from pathlib import Path
import re
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description='Validate evidence and build a skill-only release archive.')
parser.add_argument('--evals', required=True, type=Path, help='Behavioral evaluation result directory')
args = parser.parse_args()
version = (root / 'VERSION').read_text(encoding='utf-8').strip()
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
    sys.exit('VERSION must contain a numeric X.Y.Z version without leading zeroes.')
changelog = (root / 'CHANGELOG.md').read_text(encoding='utf-8')
section = re.search(rf'^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}\n(.*?)(?=^## |^\[Unreleased\]:|\Z)',
                    changelog, re.MULTILINE | re.DOTALL)
if not section or not section.group(1).strip():
    sys.exit('CHANGELOG.md needs a dated, nonempty entry for VERSION.')
skill = root / 'skills/grill-my-research'
if any(path.is_symlink() for path in skill.rglob('*')):
    sys.exit('Release packages must not contain symbolic links.')
result = subprocess.run([sys.executable, str(root / 'scripts/check-evals.py'), str(args.evals.resolve())], cwd=root)
if result.returncode:
    sys.exit(result.returncode)

archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as bundle:
    for path in sorted(skill.rglob('*')):
        if path.is_file():
            info = zipfile.ZipInfo(path.relative_to(skill).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, path.read_bytes())
data = archive.getvalue()
dist = root / 'dist'
dist.mkdir(exist_ok=True)
name = f'grill-my-research-{version}.zip'
digest = hashlib.sha256(data).hexdigest()
artifacts = {
    name: data,
    f'{name}.sha256': f'{digest}  {name}\n'.encode('utf-8'),
    f'{name}.notes.md': section.group(1).strip().encode('utf-8') + b'\n',
}
for filename, content in artifacts.items():
    target = dist / filename
    if target.exists() and target.read_bytes() != content:
        sys.exit(f'Refusing to overwrite different release content: {target.name}. Bump VERSION or move the old build aside.')
for filename, content in artifacts.items():
    (dist / filename).write_bytes(content)
print(f'Built {name}\nSHA-256: {digest}')
print('Only skill files are packaged. This does not verify payment integration or publish a release.')
