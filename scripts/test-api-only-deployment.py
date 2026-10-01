"""Focused shell contract tests without the expensive full deployment emulator."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('deploy-sbc-api-rolling.sh')
TEXT = SCRIPT.read_text()
BASH = shutil.which('bash') if __import__('os').name != 'nt' else r'C:\Program Files\Git\bin\bash.exe'
PYTHON = Path(__import__('sys').executable).as_posix()


def functions():
    names = ('preserved_runtime_fingerprint', 'verify_preserved_stateless',
             'verify_published_web', 'commit_published_restart_policies')
    return '\n'.join(re.search(r'^' + name + r'\(\) \{\n.*?^\}', TEXT, re.M | re.S).group() for name in names)


class ApiOnlyTests(unittest.TestCase):
    def run_shell(self, tail):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = {'Config': {'Env': ['EXAMPLE=value']}, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}, 'Mounts': [], 'State': {'Healthy': True}}
            (root / 'inspect.json').write_text(json.dumps(payload))
            body = f'''set -eu
EXACT_PYTHON_COMMAND='{PYTHON}'
FIXTURE='{(root / 'inspect.json').as_posix()}'
LOG='{(root / 'calls').as_posix()}'
API_DEPLOY_ONLY=true
GATEWAY_CONTAINER=gateway
WEB_CONTAINER=web
OLD_GATEWAY_CONTAINER_ID=gateway-id
OLD_WEB_CONTAINER_ID=web-id
OBSERVED_WEB_ID=web-id
NEW_API_A_CONTAINER_ID=api-a
NEW_API_B_CONTAINER_ID=api-b
NEW_GATEWAY_CONTAINER_ID=gateway-id
NEW_WEB_CONTAINER_ID=web-id
container_id() {{ case "$1" in gateway) echo gateway-id ;; web) echo "$OBSERVED_WEB_ID" ;; esac; }}
container_inspect_value() {{ cat "$FIXTURE"; }}
wait_healthy() {{ return 0; }}
run_bounded_docker_mutation() {{ echo "$*" >> "$LOG"; }}
record_state() {{ :; }}
''' + functions() + '''
PRESERVED_GATEWAY_SHA256=$(preserved_runtime_fingerprint gateway-id)
PRESERVED_WEB_SHA256=$(preserved_runtime_fingerprint web-id)
''' + tail
            path = root / 'test.sh'
            path.write_text(body, newline='\n')
            return subprocess.run([BASH, path.as_posix()], text=True, capture_output=True, timeout=30)

    def test_preserved_gateway_and_web_are_verified(self):
        result = self.run_shell('verify_preserved_stateless\nverify_published_web\n')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_third_party_web_replacement_is_rejected(self):
        result = self.run_shell('OBSERVED_WEB_ID=replaced\nverify_preserved_stateless\n')
        self.assertNotEqual(result.returncode, 0)

    def test_environment_drift_is_rejected(self):
        result = self.run_shell('echo \'{"Config":{},"HostConfig":{},"Mounts":[]}\' > "$FIXTURE"\nverify_preserved_stateless\n')
        self.assertNotEqual(result.returncode, 0)

    def test_non_api_restart_policies_are_skipped(self):
        body = 'container_inspect_value() { echo unless-stopped; }\ncommit_published_restart_policies\ncat "$LOG"\n'
        result = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('api-a', result.stdout)
        self.assertIn('api-b', result.stdout)
        self.assertNotIn('gateway-id', result.stdout)
        self.assertNotIn('web-id', result.stdout)

    def test_combined_modes_are_rejected_before_side_effects(self):
        result = subprocess.run([BASH, SCRIPT.as_posix(), '--api-only', '--bootstrap-legacy-qdrant-bridge'], capture_output=True)
        self.assertEqual(result.returncode, 64)

    def test_shell_syntax(self):
        for name in ('deploy-sbc-api-rolling.sh', 'harden-sbc-stateful-services.sh'):
            result = subprocess.run([BASH, '-n', SCRIPT.with_name(name).as_posix()], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())


if __name__ == '__main__':
    unittest.main()
