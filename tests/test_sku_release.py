import hashlib
import importlib.util
import io
from pathlib import Path
import posixpath
import re
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_sku_release', ROOT / 'scripts/build-sku-release.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SkuReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.skill = self.root / 'skills/sku-verifier'
        shutil.copytree(ROOT / 'skills/sku-verifier', self.skill)
        (self.skill / 'VERSION').write_text('0.1.0\n')
        self.output = self.root / 'dist'

    def test_deterministic_allowlist_and_checksums(self):
        (self.skill / '.env').write_text('ALIPAY_PRIVATE_KEY=do-not-ship')
        (self.skill / 'receipt.json').write_text('private-customer-capability')
        (self.skill / 'node_modules').mkdir()
        (self.skill / 'node_modules/secret').write_text('do-not-ship')
        name, digest = builder.build(self.root, self.output)
        archive = (self.output / name).read_bytes()
        self.assertEqual(builder.build(self.root, self.output), (name, digest))
        self.assertEqual((self.output / name).read_bytes(), archive)
        self.assertEqual(hashlib.sha256(archive).hexdigest(), digest)
        self.assertEqual((self.output / (name + '.sha256')).read_text(), f'{digest}  {name}\n')
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            self.assertEqual(set(bundle.namelist()), set(builder.FILES) | {'SHA256SUMS'})
            manifest = bundle.read('SHA256SUMS').decode().splitlines()
            self.assertEqual(len(manifest), len(builder.FILES))
            for line in manifest:
                checksum, path = line.split('  ', 1)
                self.assertEqual(hashlib.sha256(bundle.read(path)).hexdigest(), checksum)
            self.assertNotIn(b'do-not-ship', archive)
            self.assertNotIn(b'private-customer-capability', archive)
            self.assertEqual(bundle.read('VERSION'), b'0.1.0\n')
            for entry in bundle.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))

    def test_packaged_markdown_references_resolve_inside_archive(self):
        name, _ = builder.build(self.root, self.output)
        with zipfile.ZipFile(self.output / name) as bundle:
            for document in (name for name in bundle.namelist() if name.endswith('.md')):
                for link in re.findall(r'\]\(([^)]+)\)', bundle.read(document).decode()):
                    if '://' in link or link.startswith('#'):
                        continue
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(document), link.split('#')[0]))
                    self.assertFalse(target.startswith('../') or target.startswith('/'), target)
                    self.assertIn(target, bundle.namelist(), f'{document}: {link}')

    def test_refuses_changed_release_for_same_version(self):
        builder.build(self.root, self.output)
        (self.skill / 'SKILL.md').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Bump the Skill VERSION'):
            builder.build(self.root, self.output)

    def test_rejects_symlinks(self):
        (self.skill / 'injected').symlink_to(self.skill / 'VERSION')
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            builder.build(self.root, self.output)

    def test_version_is_independent_and_validated(self):
        (self.root / 'VERSION').write_text('8.8.8')
        self.assertEqual(builder.build(self.root, self.output)[0], 'sku-verifier-0.1.0.zip')
        (self.skill / 'VERSION').write_text('01.0.0')
        with self.assertRaisesRegex(ValueError, 'VERSION'):
            builder.build(self.root, self.root / 'other-dist')


if __name__ == '__main__':
    unittest.main()
