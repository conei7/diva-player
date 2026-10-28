#!/usr/bin/env python3
"""Choose CI work from the complete push diff; uncertainty always runs all checks."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


WEB_FILES = {'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json',
             'tsconfig.node.json', 'eslint.config.js', 'vitest.config.ts'}


# These browser fixtures validate Web behavior; operational/API test scripts stay full.
WEB_TEST_FILES = {
    'scripts/' + name for name in (
        'test-user-journey-e2e.mjs', 'test-sbc-e2e.mjs', 'test-navigation-e2e.mjs',
        'test-performance-budget.mjs', 'test-player-controls-e2e.mjs',
        'test-player-service-switch-e2e.mjs', 'test-hidden-songs-e2e.mjs',
        'test-chorus-highlights-e2e.mjs', 'test-external-players-e2e.mjs',
        'test-mobile-player-gestures-e2e.mjs', 'test-youtube-playlist-sync-e2e.mjs',
        'test-nico-playlist-sync-e2e.mjs', 'test-playlist-management-e2e.mjs',
        'test-playlist-workflows-e2e.mjs', 'test-settings-e2e.mjs',
        'test-mobile-layout-e2e.mjs', 'test-knowledge-map-e2e.mjs',
        'test-sound-map-feature-axes-e2e.mjs', 'test-advanced-search-e2e.mjs',
        'test-background-playback-e2e.mjs', 'test-home-recommendations-e2e.mjs',
        'pin-app-language.mjs', 'saved-library-fixture.mjs',
    )
}


def classify(paths):
    if not paths:
        return 'full'
    web = False
    tests = False
    for path in paths:
        # Git paths are POSIX relative paths, including on Windows.
        if not path or path.startswith('/') or '\\' in path or any(
                part in ('', '.', '..') for part in path.split('/')):
            return 'full'
        if path in ('README.md', 'CHANGELOG.md') or (
                path.startswith('docs/') and path.endswith(('.md', '.png', '.svg', '.jpg'))):
            continue
        if path in WEB_TEST_FILES or (path.startswith('src/') and re.search(r'\.test\.[cm]?[jt]sx?$', path)):
            tests = True
            continue
        if path.startswith(('src/', 'public/', 'functions/')) or path in WEB_FILES:
            web = True
            continue
        # Build/dependency/CI/operations changes and unknown paths need runtime validation.
        return 'full'
    return 'web' if web else 'tests' if tests else 'docs'


def git(repository, *args):
    return subprocess.check_output(['git', '-C', str(repository), *args], stderr=subprocess.PIPE)


def inspect_push(repository, event_name, event, expected_head):
    if event_name != 'push':
        return 'full', 'manual or non-push run'
    before, after = event.get('before', ''), event.get('after', '')
    if (not all(isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value)
                and value != '0' * 40 for value in (before, after))
            or after != expected_head):
        return 'full', 'missing or mismatched push boundary'
    try:
        if git(repository, 'rev-parse', 'HEAD').decode().strip() != after:
            return 'full', 'checkout does not match push head'
        # Do not narrow forced/divergent histories. Include every commit of a normal push.
        git(repository, 'merge-base', '--is-ancestor', before, after)
        changed = git(repository, 'diff', '--name-only', '--no-renames', '-z', before, after, '--')
        paths = changed.decode('utf-8', errors='strict').split('\0')
        if paths[-1] == '':
            paths.pop()
        mode = classify(paths)
        return mode, f'{len(paths)} changed paths in complete push diff'
    except (subprocess.CalledProcessError, UnicodeError, OSError):
        return 'full', 'cannot establish complete push diff'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path('.'))
    parser.add_argument('--event-path', type=Path, default=os.environ.get('GITHUB_EVENT_PATH'))
    parser.add_argument('--github-output', type=Path, default=os.environ.get('GITHUB_OUTPUT'))
    args = parser.parse_args()
    try:
        event = json.loads(args.event_path.read_text(encoding='utf-8')) if args.event_path else {}
        if not isinstance(event, dict):
            raise ValueError('event is not an object')
        mode, reason = inspect_push(args.repository, os.environ.get('GITHUB_EVENT_NAME'),
                                    event, os.environ.get('GITHUB_SHA'))
    except (OSError, ValueError, TypeError):
        mode, reason = 'full', 'event unavailable or invalid'
    outputs = {'mode': mode, 'web': str(mode != 'docs').lower(),
               'runtime': str(mode == 'full').lower(),
               'release': str(mode in ('web', 'full')).lower()}
    if args.github_output:
        with args.github_output.open('a', encoding='utf-8') as output:
            for key, value in outputs.items():
                output.write(f'{key}={value}\n')
    print(json.dumps({**outputs, 'reason': reason}))


if __name__ == '__main__':
    main()
