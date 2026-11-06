#!/usr/bin/env python3
"""Build the independently versioned consumer Skill without service credentials."""
import argparse
import hashlib
import io
from pathlib import Path
import re
import stat
import sys
import zipfile

FILES = (
    'SKILL.md', 'VERSION', 'examples/dongfang-shuye-tea-500ml.json',
    'references/client-contract.md', 'scripts/client.mjs',
)


def build(root, output):
    skill = root / 'skills/sku-verifier'
    if skill.is_symlink() or any(path.is_symlink() for path in skill.rglob('*')):
        raise ValueError('Skill releases must not contain symbolic links.')
    version = (skill / 'VERSION').read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Skill VERSION must be X.Y.Z without leading zeroes.')
    content = {name: (skill / name).read_bytes() for name in FILES}
    checksum = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(content.items()))
    content['SHA256SUMS'] = checksum.encode('utf-8')
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as bundle:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            bundle.writestr(info, data)
    data = archive.getvalue()
    name = f'sku-verifier-{version}.zip'
    digest = hashlib.sha256(data).hexdigest()
    artifacts = {name: data, name + '.sha256': f'{digest}  {name}\n'.encode('utf-8')}
    output.mkdir(parents=True, exist_ok=True)
    for filename, body in artifacts.items():
        path = output / filename
        if path.exists() and path.read_bytes() != body:
            raise ValueError(f'Refusing to overwrite different content for {filename}. Bump the Skill VERSION.')
    for filename, body in artifacts.items():
        (output / filename).write_bytes(body)
    return name, digest


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=root / 'dist')
    args = parser.parse_args()
    try:
        name, digest = build(root, args.output_dir)
    except (ValueError, OSError) as error:
        sys.exit(str(error))
    print(f'Built {name}\nSHA-256: {digest}\nPreview client package with service origin. Node.js 20+ and the official Alipay buyer capability are required. No credentials or live-payment certification is bundled.')


if __name__ == '__main__':
    main()
