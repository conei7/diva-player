import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(scriptsDirectory, '..');
const deploymentScript = join(scriptsDirectory, 'deploy-sbc-api-rolling.sh');

function shellPath(path) {
  return relative(projectDirectory, path).replaceAll('\\', '/');
}

const fakeDocker = String.raw`#!/bin/sh
set -eu

fake_root=__DOLLAR__{FAKE_DOCKER_STATE:?}
log_file="$fake_root/docker.log"
containers="$fake_root/containers"
mkdir -p "$containers"
printf '%s|api=%s|gateway=%s|web=%s\n' "$*" "__DOLLAR__{DIVA_API_IMAGE:-}" "__DOLLAR__{DIVA_GATEWAY_IMAGE:-}" "__DOLLAR__{DIVA_WEB_IMAGE:-}" >> "$log_file"

read_value() {
    file="$1"
    fallback="$2"
    if [ -f "$file" ]; then cat "$file"; else printf '%s\n' "$fallback"; fi
}

write_value() {
    printf '%s\n' "$2" > "$1"
}

image_id() {
    case "$1" in
        diva-player-api:local) printf '%s\n' new-api ;;
        diva-player-api:rollback-api-a) printf '%s\n' old-api-a ;;
        diva-player-api:rollback-api-b) printf '%s\n' old-api-b ;;
        diva-player-api-gateway:local) printf '%s\n' "__DOLLAR__{FAKE_NEW_GATEWAY_IMAGE:-new-gateway}" ;;
        diva-player-api-gateway:rollback) printf '%s\n' old-gateway ;;
        diva-player-web:local) printf '%s\n' new-web ;;
        diva-player-web:rollback) printf '%s\n' old-web ;;
        *) printf '%s\n' "$1" ;;
    esac
}

container_health() {
    container="$1"
    image=$(read_value "$containers/$container.image" unknown)
    case "__DOLLAR__{FAKE_FAIL_STAGE:-}:$container:$image" in
        api_b_health:vocadb_api_b:new-api) printf '%s\n' unhealthy ;;
        candidate_health:diva_api_gateway_candidate_*:new-gateway) printf '%s\n' unhealthy ;;
        gateway_health:vocadb_api_gateway:new-gateway) printf '%s\n' unhealthy ;;
        *) read_value "$containers/$container.health" healthy ;;
    esac
}

if [ "$1" = "inspect" ]; then
    shift
    format=""
    if [ "__DOLLAR__{1:-}" = "--format" ]; then format="$2"; shift 2; fi
    container="$1"
    case "$format" in
        *State.Running*) read_value "$containers/$container.running" true ;;
        *State.Health*) container_health "$container" ;;
        *Config.Labels*) read_value "$containers/$container.config_hash" unknown-config ;;
        *Image*) read_value "$containers/$container.image" unknown ;;
        *) exit 1 ;;
    esac
    exit 0
fi

if [ "$1" = "image" ]; then
    operation="$2"
    case "$operation" in
        tag) exit 0 ;;
        inspect)
            image=""
            for argument in "$@"; do image="$argument"; done
            image_id "$image"
            exit 0
            ;;
    esac
fi

if [ "$1" = "exec" ]; then
    command=$(cat)
    case "$command" in
        "show stat")
            for slot in api_a api_b; do
                status=$(read_value "$fake_root/$slot.route" UP)
                sessions=0
                if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "drain" ] && [ "$slot" = "api_a" ] \
                    && [ "$status" = "MAINT" ]; then sessions=1; fi
                awk -v slot="$slot" -v sessions="$sessions" -v status="$status" 'BEGIN {
                    for (i = 1; i <= 18; i += 1) field[i] = "";
                    field[1] = "api_nodes"; field[2] = slot;
                    field[5] = sessions; field[18] = status;
                    for (i = 1; i <= 18; i += 1) printf "%s%s", field[i], (i == 18 ? "\n" : ",");
                }'
            done
            ;;
        "disable server api_nodes/"*)
            slot=__DOLLAR__{command##*/}
            write_value "$fake_root/$slot.route" MAINT
            ;;
        "enable server api_nodes/"*)
            slot=__DOLLAR__{command##*/}
            write_value "$fake_root/$slot.route" UP
            ;;
        *) exit 1 ;;
    esac
    exit 0
fi

case "$1" in
    logs) exit 0 ;;
    rm)
        target=""
        for argument in "$@"; do target="$argument"; done
        write_value "$containers/$target.running" false
        exit 0
        ;;
    stop)
        target=""
        for argument in "$@"; do target="$argument"; done
        write_value "$containers/$target.running" false
        exit 0
        ;;
    start)
        write_value "$containers/$2.running" true
        exit 0
        ;;
esac

if [ "$1" != "compose" ]; then exit 1; fi
shift
if [ "__DOLLAR__{1:-}" = "-f" ]; then shift 2; fi
operation="$1"
shift

case "$operation" in
    build) exit 0 ;;
    run)
        detached=false
        service=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -d) detached=true; shift ;;
                --rm|--no-deps) shift ;;
                --name) candidate_name="$2"; shift 2 ;;
                api_gateway|api_a|web|migrate) service="$1"; shift; break ;;
                *) shift ;;
            esac
        done
        if [ "$service" = "migrate" ] && [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "migration" ]; then exit 1; fi
        if [ "$service" = "api_gateway" ] && [ "$detached" = "true" ]; then
            write_value "$containers/$candidate_name.image" "__DOLLAR__{FAKE_NEW_GATEWAY_IMAGE:-new-gateway}"
            write_value "$containers/$candidate_name.config_hash" "__DOLLAR__{FAKE_NEW_GATEWAY_CONFIG_HASH:-new-config}"
            write_value "$containers/$candidate_name.running" true
            printf '%s\n' candidate-id
        fi
        if [ "$service" = "api_a" ] && [ "$detached" = "true" ]; then
            write_value "$containers/$candidate_name.image" new-api
            write_value "$containers/$candidate_name.running" true
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "api_candidate_health" ]; then
                write_value "$containers/$candidate_name.health" unhealthy
            else
                write_value "$containers/$candidate_name.health" healthy
            fi
            printf '%s\n' candidate-api-id
        fi
        if [ "$service" = "web" ] && [ "$detached" = "true" ]; then
            write_value "$containers/$candidate_name.image" new-web
            write_value "$containers/$candidate_name.running" true
            write_value "$containers/$candidate_name.health" healthy
            printf '%s\n' candidate-web-id
        fi
        exit 0
        ;;
    up)
        services=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -d|--no-deps|--no-build|--force-recreate) shift ;;
                *) services="$services $1"; shift ;;
            esac
        done
        for service in $services; do
            case "$service" in
                api_a|api_b)
                    image=$(image_id "__DOLLAR__{DIVA_API_IMAGE:-diva-player-api:local}")
                    write_value "$containers/vocadb_$service.image" "$image"
                    write_value "$containers/vocadb_$service.running" true
                    ;;
                api_gateway)
                    image=$(image_id "__DOLLAR__{DIVA_GATEWAY_IMAGE:-diva-player-api-gateway:local}")
                    write_value "$containers/vocadb_api_gateway.image" "$image"
                    write_value "$containers/vocadb_api_gateway.config_hash" "__DOLLAR__{FAKE_NEW_GATEWAY_CONFIG_HASH:-new-config}"
                    write_value "$containers/vocadb_api_gateway.running" true
                    ;;
                web)
                    image=$(image_id "__DOLLAR__{DIVA_WEB_IMAGE:-diva-player-web:local}")
                    write_value "$containers/vocadb_web.image" "$image"
                    write_value "$containers/vocadb_web.running" true
                    write_value "$containers/vocadb_web.health" healthy
                    ;;
            esac
        done
        exit 0
        ;;
    stop)
        write_value "$containers/vocadb_api_gateway.running" false
        exit 0
        ;;
esac

exit 1
`.replaceAll('__DOLLAR__', '$');

const fakeCurl = String.raw`#!/bin/sh
set -eu
printf '%s\n' "$*" >> "__DOLLAR__{FAKE_DOCKER_STATE:?}/curl.log"
exit 0
`.replaceAll('__DOLLAR__', '$');

const fakeSleep = String.raw`#!/bin/sh
exit 0
`;

const fakeHook = String.raw`#!/bin/sh
set -eu
phase="$1"
if [ "$phase" != "__DOLLAR__{FAKE_HOOK_PHASE:-}" ]; then exit 0; fi
case "__DOLLAR__{FAKE_HOOK_ACTION:-fail}" in
    signal)
        kill -TERM "__DOLLAR__{DIVA_DEPLOYMENT_PID:?}"
        exit 0
        ;;
    fail) exit 42 ;;
esac
`.replaceAll('__DOLLAR__', '$');

async function createScenario(name) {
  const root = await mkdtemp(join(scriptsDirectory, `.rolling-deployment-test-${name}-`));
  const bin = join(root, 'bin');
  const fakeState = join(root, 'fake-docker');
  const containers = join(fakeState, 'containers');
  const deploymentState = join(root, 'deploy-state');
  await Promise.all([mkdir(bin), mkdir(containers, { recursive: true }), mkdir(deploymentState)]);

  const dockerPath = join(bin, 'docker');
  const curlPath = join(bin, 'curl');
  const sleepPath = join(bin, 'sleep');
  const hookPath = join(bin, 'hook');
  await Promise.all([
    writeFile(dockerPath, fakeDocker, 'utf8'),
    writeFile(curlPath, fakeCurl, 'utf8'),
    writeFile(sleepPath, fakeSleep, 'utf8'),
    writeFile(hookPath, fakeHook, 'utf8'),
  ]);
  await Promise.all([
    chmod(dockerPath, 0o755),
    chmod(curlPath, 0o755),
    chmod(sleepPath, 0o755),
    chmod(hookPath, 0o755),
  ]);

  const initialFiles = {
    'vocadb_api_a.image': 'old-api-a',
    'vocadb_api_b.image': 'old-api-b',
    'vocadb_api_gateway.image': 'old-gateway',
    'vocadb_api_a.running': 'true',
    'vocadb_api_b.running': 'true',
    'vocadb_api_gateway.running': 'true',
    'vocadb_api_a.health': 'healthy',
    'vocadb_api_b.health': 'healthy',
    'vocadb_api_gateway.health': 'healthy',
    'vocadb_api_gateway.config_hash': 'old-config',
    'vocadb_web.image': 'old-web',
    'vocadb_web.running': 'true',
    'vocadb_web.health': 'healthy',
    'vocadb_api.image': 'old-legacy-api',
    'vocadb_api.running': name.startsWith('bootstrap-') ? 'true' : 'false',
  };
  await Promise.all(Object.entries(initialFiles).map(([file, value]) =>
    writeFile(join(containers, file), `${value}\n`, 'utf8')));
  if (name.startsWith('bootstrap-')) {
    await writeFile(join(containers, 'vocadb_api_gateway.running'), 'false\n', 'utf8');
  }
  await Promise.all([
    writeFile(join(fakeState, 'api_a.route'), 'UP\n', 'utf8'),
    writeFile(join(fakeState, 'api_b.route'), 'UP\n', 'utf8'),
  ]);

  return { root, fakeState, deploymentState, dockerPath, curlPath, sleepPath, hookPath };
}

async function readDeploymentState(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const deployment = entries.find((entry) => entry.isDirectory() && entry.name !== 'deploy.lock');
  assert.ok(deployment, 'deployment state directory was not created');
  return readFile(join(directory, deployment.name, 'state'), 'utf8');
}

async function runScenario(name, failStage = '', hookPhase = '', hookAction = '', lockHeld = false) {
  const scenario = await createScenario(name);
  try {
    if (lockHeld) {
      const lockDirectory = join(scenario.deploymentState, 'deploy.lock');
      await mkdir(lockDirectory);
      await writeFile(join(lockDirectory, 'owner'), 'pid=existing started=2026-08-10T00:00:00Z\n', 'utf8');
    }
    const result = spawnSync('sh', [shellPath(deploymentScript)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        DIVA_DOCKER_COMMAND: shellPath(scenario.dockerPath),
        DIVA_CURL_COMMAND: shellPath(scenario.curlPath),
        DIVA_SLEEP_COMMAND: shellPath(scenario.sleepPath),
        DIVA_DEPLOY_HOOK_COMMAND: shellPath(scenario.hookPath),
        DIVA_DEPLOY_STATE_DIR: shellPath(scenario.deploymentState),
        DIVA_DEPLOY_HEALTH_ATTEMPTS: '1',
        DIVA_DEPLOY_DRAIN_ATTEMPTS: '1',
        DIVA_DEPLOY_ROUTE_ATTEMPTS: '1',
        DIVA_DEPLOY_WAIT_SECONDS: '0',
        FAKE_DOCKER_STATE: shellPath(scenario.fakeState),
        FAKE_FAIL_STAGE: failStage,
        FAKE_HOOK_PHASE: hookPhase,
        FAKE_HOOK_ACTION: hookAction,
        FAKE_NEW_GATEWAY_IMAGE: name === 'config-only' || name === 'unchanged'
          ? 'old-gateway'
          : 'new-gateway',
        FAKE_NEW_GATEWAY_CONFIG_HASH: name === 'unchanged' ? 'old-config' : 'new-config',
      },
    });
    const [dockerLog, state, apiARoute, apiBRoute] = await Promise.all([
      readFile(join(scenario.fakeState, 'docker.log'), 'utf8').catch(() => ''),
      readDeploymentState(scenario.deploymentState).catch(() => ''),
      readFile(join(scenario.fakeState, 'api_a.route'), 'utf8'),
      readFile(join(scenario.fakeState, 'api_b.route'), 'utf8'),
    ]);
    return { result, dockerLog, state, apiARoute: apiARoute.trim(), apiBRoute: apiBRoute.trim() };
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
}

const successful = await runScenario('success');
assert.equal(successful.result.status, 0, successful.result.stderr);
assert.match(successful.state, /api_a\.old_image=old-api-a/);
assert.match(successful.state, /api_b\.old_image=old-api-b/);
assert.match(successful.state, /gateway\.old_image=old-gateway/);
assert.match(successful.state, /migration\.rollback=not-attempted-forward-only/);
assert.match(successful.state, /gateway\.candidate=healthy/);
assert.match(successful.state, /api\.candidate=healthy/);
assert.match(successful.state, /gateway\.update=completed/);
assert.match(successful.state, /deployment\.status=completed/);
assert.match(successful.state, /deployment\.lock=acquired/);
assert.match(successful.dockerLog, /run -d --no-deps --name diva_api_gateway_candidate_/);
assert.match(successful.dockerLog, /up -d --no-deps --no-build --force-recreate api_gateway\|api=diva-player-api:local\|gateway=diva-player-api-gateway:local/);

const configOnly = await runScenario('config-only');
assert.equal(configOnly.result.status, 0, configOnly.result.stderr);
assert.match(configOnly.state, /gateway\.old_image=old-gateway/);
assert.match(configOnly.state, /gateway\.new_image=old-gateway/);
assert.match(configOnly.state, /gateway\.old_config_hash=old-config/);
assert.match(configOnly.state, /gateway\.candidate_config_hash=new-config/);
assert.match(configOnly.state, /gateway\.update=completed/);
assert.match(configOnly.dockerLog, /force-recreate api_gateway/);

const unchanged = await runScenario('unchanged');
assert.equal(unchanged.result.status, 0, unchanged.result.stderr);
assert.match(unchanged.state, /gateway\.update=unchanged/);
assert.doesNotMatch(unchanged.dockerLog, /force-recreate api_gateway/);

const migrationFailure = await runScenario('migration', 'migration');
assert.notEqual(migrationFailure.result.status, 0);
assert.match(migrationFailure.state, /migration\.status=failed/);
assert.doesNotMatch(migrationFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(migrationFailure.dockerLog, /force-recreate api_b/);

const credentialFailure = await runScenario('api-credential', 'api_candidate_health');
assert.notEqual(credentialFailure.result.status, 0);
assert.match(credentialFailure.state, /Candidate API could not become ready/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_b/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_gateway/);

const lockFailure = await runScenario('lock-held', '', '', '', true);
assert.equal(lockFailure.result.status, 75);
assert.match(lockFailure.state, /Another rolling deployment holds/);
assert.equal(lockFailure.dockerLog, '');

const drainFailure = await runScenario('drain', 'drain');
assert.notEqual(drainFailure.result.status, 0);
assert.match(drainFailure.state, /failure=Active sessions did not drain from api_a/);
assert.doesNotMatch(drainFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(drainFailure.dockerLog, /force-recreate api_b/);
assert.equal(drainFailure.apiARoute, 'UP');

const disableInterruption = await runScenario(
  'disable-interruption',
  '',
  'slot-disabled:api_a',
  'signal',
);
assert.notEqual(disableInterruption.result.status, 0);
assert.match(disableInterruption.state, /deployment\.signal=TERM/);
assert.match(disableInterruption.state, /recovery\.status=completed/);
assert.equal(disableInterruption.apiARoute, 'UP');
assert.doesNotMatch(disableInterruption.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(disableInterruption.dockerLog, /force-recreate api_b/);

const replaceInterruption = await runScenario(
  'replace-interruption',
  '',
  'slot-replaced:api_a',
  'fail',
);
assert.notEqual(replaceInterruption.result.status, 0);
assert.match(replaceInterruption.state, /hook\.failure=slot-replaced:api_a/);
assert.match(replaceInterruption.state, /api_a\.rollback=completed/);
assert.match(replaceInterruption.state, /recovery\.status=completed/);
assert.match(replaceInterruption.dockerLog, /force-recreate api_a\|api=diva-player-api:rollback-api-a/);
assert.doesNotMatch(replaceInterruption.dockerLog, /force-recreate api_b/);

const slotFailure = await runScenario('slot', 'api_b_health');
assert.notEqual(slotFailure.result.status, 0);
assert.match(slotFailure.state, /api_b\.rollback=completed/);
assert.match(slotFailure.state, /api_a\.rollback=completed/);
assert.doesNotMatch(slotFailure.state, /gateway\.update=started/);
assert.match(slotFailure.dockerLog, /force-recreate api_b\|api=diva-player-api:rollback-api-b/);
assert.match(slotFailure.dockerLog, /force-recreate api_a\|api=diva-player-api:rollback-api-a/);

const candidateFailure = await runScenario('candidate', 'candidate_health');
assert.notEqual(candidateFailure.result.status, 0);
assert.match(candidateFailure.state, /failure=Candidate gateway could not reach both API slots/);
assert.match(candidateFailure.state, /api_b\.rollback=completed/);
assert.match(candidateFailure.state, /api_a\.rollback=completed/);
assert.doesNotMatch(candidateFailure.dockerLog, /force-recreate api_gateway\|api=diva-player-api:local\|gateway=diva-player-api-gateway:local/);

const gatewayFailure = await runScenario('gateway', 'gateway_health');
assert.notEqual(gatewayFailure.result.status, 0);
assert.match(gatewayFailure.state, /gateway\.rollback=completed/);
assert.match(gatewayFailure.state, /api_b\.rollback=completed/);
assert.match(gatewayFailure.state, /api_a\.rollback=completed/);
assert.match(gatewayFailure.dockerLog, /force-recreate api_gateway\|api=diva-player-api:local\|gateway=diva-player-api-gateway:rollback/);

const bootstrapWebFailure = await runScenario(
  'bootstrap-web-failure',
  '',
  'web-replaced',
  'fail',
);
assert.notEqual(bootstrapWebFailure.result.status, 0);
assert.match(bootstrapWebFailure.state, /web\.rollback=completed/);
assert.match(bootstrapWebFailure.state, /bootstrap\.recovery=completed/);
assert.match(bootstrapWebFailure.dockerLog, /start vocadb_api/);
assert.match(bootstrapWebFailure.dockerLog, /force-recreate web\|api=diva-player-api:local\|gateway=diva-player-api-gateway:local\|web=diva-player-web:rollback/);

console.log('PASS transactional rolling deployment execution');
