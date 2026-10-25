#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_scope', ROOT / 'scripts/classify-ci-changes.py')
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def test_only_known_frontend_inputs_skip_runtime(self):
        for path in ['src/pages/WatchPage.tsx', 'src/index.css', 'src/stores/playerStore.test.ts',
                     'public/icon.svg', 'functions/backend-api/[[path]].ts', *scope.WEB_FILES]:
            with self.subTest(path=path):
                self.assertEqual(scope.classify([path, 'README.md']), 'web')

    def test_shared_unknown_and_operational_changes_run_everything(self):
        for path in ['package.json', 'package-lock.json', 'Dockerfile.web', '.dockerignore',
                     'backend/api/main.cs', 'backend/database/migrations/001.sql', 'vendor/alpine/a.apk',
                     '.github/workflows/deploy.yml', 'scripts/classify-ci-changes.py',
                     'scripts/test-navigation-e2e.mjs', 'NuGet.Config', 'new-build-input',
                     'docs/tool.py', '../src/x.ts', '/src/x.ts', 'src\\x.ts', 'src//x.ts']:
            with self.subTest(path=path):
                self.assertEqual(scope.classify(['src/index.css', path]), 'full')
        self.assertEqual(scope.classify([]), 'full')

    def test_documentation_only_and_mixed_changes(self):
        self.assertEqual(scope.classify(['README.md', 'docs/guide.md', 'docs/screen.png']), 'docs')
        self.assertEqual(scope.classify(['docs/guide.md', 'src/main.tsx']), 'web')

    def test_manual_invalid_event_and_unavailable_history_are_full(self):
        for event_name, event, head in [('workflow_dispatch', {}, None),
                                       ('push', {}, '1' * 40),
                                       ('push', {'before': '0' * 40, 'after': '1' * 40}, '1' * 40),
                                       ('push', {'before': '2' * 40, 'after': '1' * 40}, '3' * 40)]:
            self.assertEqual(scope.inspect_push(ROOT, event_name, event, head)[0], 'full')
        with patch.object(scope, 'git', side_effect=OSError('unavailable')):
            self.assertEqual(scope.inspect_push(ROOT, 'push', {'before': '2' * 40, 'after': '1' * 40}, '1' * 40)[0], 'full')

    def test_cli_invalid_event_outputs_full(self):
        with tempfile.TemporaryDirectory() as directory:
            event, output = Path(directory) / 'event.json', Path(directory) / 'output'
            event.write_text('[]', encoding='utf-8')
            subprocess.run([os.sys.executable, '-B', str(ROOT / 'scripts/classify-ci-changes.py'),
                            '--event-path', str(event), '--github-output', str(output)], check=True,
                           stdout=subprocess.PIPE)
            self.assertEqual(dict(line.split('=') for line in output.read_text().splitlines()),
                             {'mode': 'full', 'web': 'true', 'runtime': 'true'})


class GitScopeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'ci-scope@example.invalid')
        self.git('config', 'user.name', 'CI scope test')
        self.before = self.commit('README.md', 'base')

    def git(self, *args):
        return scope.git(self.repo, *args).decode().strip()

    def commit(self, path, value):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding='utf-8')
        self.git('add', '--all')
        self.git('commit', '-m', 'fixture')
        return self.git('rev-parse', 'HEAD')

    def mode(self, before=None):
        head = self.git('rev-parse', 'HEAD')
        return scope.inspect_push(self.repo, 'push', {'before': before or self.before, 'after': head}, head)[0]

    def test_all_commits_in_a_push_are_considered(self):
        self.commit('backend/api/code.cs', 'runtime change')
        self.commit('src/app.tsx', 'frontend change')
        self.assertEqual(self.mode(), 'full')

    def test_no_api_file_limit_and_no_rename_blind_spot(self):
        self.commit('backend/api/code.cs', 'original')
        base = self.git('rev-parse', 'HEAD')
        (self.repo / 'src').mkdir()
        self.git('mv', 'backend/api/code.cs', 'src/moved.ts')
        for i in range(305):
            (self.repo / f'src/{i:03}.ts').write_text('web', encoding='utf-8')
        self.commit('src/app.tsx', 'web')
        self.assertEqual(self.mode(base), 'full')

    def test_actual_web_docs_deleted_files_and_divergence(self):
        web = self.commit('src/app.tsx', 'web')
        self.assertEqual(self.mode(), 'web')
        self.commit('docs/guide.md', 'docs')
        self.assertEqual(self.mode(web), 'docs')
        (self.repo / 'src/app.tsx').unlink()
        self.commit('README.md', 'updated')
        self.assertEqual(self.mode(web), 'web')
        self.git('checkout', '-b', 'other', self.before)
        self.commit('src/other.ts', 'branch')
        self.assertEqual(self.mode(web), 'full')


class WorkflowTests(unittest.TestCase):
    def test_scope_is_a_required_gate_and_security_checks_remain(self):
        text = (ROOT / '.github/workflows/deploy.yml').read_text(encoding='utf-8')
        self.assertIn('fetch-depth: 0', text.split('  cloudflare_contract:')[0])
        self.assertIn('python3 -B scripts/test-ci-change-scope.py', text)
        self.assertIn('python3 -B scripts/classify-ci-changes.py', text)
        self.assertIn("needs.changes.outputs.runtime == 'true'", text)
        self.assertEqual(text.count("needs.changes.outputs.web == 'true'"), 2)
        self.assertIn('needs: [changes, cloudflare_contract]', text)
        self.assertIn('needs: [cloudflare_contract, build]', text)
        for gate in ['Attest exact deployable image vulnerability scans', '--severity HIGH,CRITICAL',
                     'Verify preview root, ready, health, and origin headers',
                     'Verify production or perform one bounded rollback']:
            self.assertIn(gate, text)


if __name__ == '__main__':
    unittest.main()
