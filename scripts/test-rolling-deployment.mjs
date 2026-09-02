import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(scriptsDirectory, '..');
const deploymentScript = join(scriptsDirectory, 'deploy-sbc-api-rolling.sh');
const deploymentSource = await readFile(deploymentScript, 'utf8');
const retiredAllInOneUpdaterSource = await readFile(
  join(scriptsDirectory, 'sbc_update.sh'),
  'utf8',
);
assert.match(
  retiredAllInOneUpdaterSource,
  /sbc_update\.sh is retired and intentionally performs no update\./u,
  'the unsafe legacy all-in-one updater must remain explicitly retired',
);
assert.match(
  retiredAllInOneUpdaterSource,
  /exit 78\s*$/u,
  'the retired updater must fail closed with a stable refusal status',
);
assert.doesNotMatch(
  retiredAllInOneUpdaterSource,
  /^\s*(?:git\s+(?:pull|fetch|switch)\b|docker\s+compose\b|sudo\b)/mu,
  'the retired updater must not retain a repository or container mutation path',
);
const configuredScenarioTimeout = Number.parseInt(
  process.env.DIVA_ROLLING_TEST_TIMEOUT_MS
    ?? (process.platform === 'win32' ? '900000' : '300000'),
  10,
);
assert.ok(
  Number.isSafeInteger(configuredScenarioTimeout) && configuredScenarioTimeout >= 60_000,
  'DIVA_ROLLING_TEST_TIMEOUT_MS must be an integer of at least 60000',
);
const playerCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectDirectory,
  encoding: 'utf8',
}).stdout.trim();
assert.match(playerCommit, /^[0-9a-f]{40}$/u);
const playerAncestorResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD^'], {
  cwd: projectDirectory,
  encoding: 'utf8',
});
assert.equal(
  playerAncestorResult.status,
  0,
  `git rev-parse --verify HEAD^ failed: ${playerAncestorResult.stderr.trim() || 'no stderr'}`,
);
assert.equal(
  playerAncestorResult.stderr,
  '',
  `git rev-parse --verify HEAD^ wrote stderr: ${playerAncestorResult.stderr.trim()}`,
);
const playerAncestorCommit = playerAncestorResult.stdout.trim();
assert.match(playerAncestorCommit, /^[0-9a-f]{40}$/u);
const qdrantImageId = `sha256:${'1'.repeat(64)}`;
const qdrantDockerfileSha256 = 'cd094d3ab1147d5ca9e4369a9bb1e41d0bdac0bd9989a1769bc0b04a557796c1';
const postgresImageId = `sha256:${'2'.repeat(64)}`;
const postgresMigrateImageId = `sha256:${'7'.repeat(64)}`;
const oldApiAImageId = `sha256:${'a'.repeat(64)}`;
const oldApiBImageId = `sha256:${'b'.repeat(64)}`;
const oldGatewayImageId = `sha256:${'c'.repeat(64)}`;
const oldWebImageId = `sha256:${'d'.repeat(64)}`;
const newApiImageId = `sha256:${'e'.repeat(64)}`;
const newGatewayImageId = `sha256:${'f'.repeat(64)}`;
const newWebImageId = `sha256:${'9'.repeat(64)}`;
const legacyApiImageId = `sha256:${'8'.repeat(64)}`;
const backendEnvironmentFixture = [
  'POSTGRES_PASSWORD=deterministic-test-only',
  'PAGES_PROXY_KEY=deterministic-test-only',
  '',
].join('\n');
const postgresImageReference = 'diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1';
const postgresMigrateImageReference = 'diva-player-postgres-migrate:16.15-hardened-r1';
const fakeStatefulComposeConfig = {
  services: {
    api_a: {
      image: 'diva-player-api:local',
      environment: { Application__Name: 'DivaApiA', SHARED_SECRET: 'test-api-secret' },
      networks: { default: null },
    },
    api_b: {
      image: 'diva-player-api:local',
      environment: { Application__Name: 'DivaApiB', SHARED_SECRET: 'test-api-secret' },
      networks: { default: null },
    },
    api_gateway: {
      image: 'diva-player-api-gateway:local',
      environment: {},
      networks: { default: null },
    },
    web: {
      image: 'diva-player-web:local',
      environment: {},
      networks: { default: null },
    },
    migrate: {
      image: postgresMigrateImageReference,
      environment: { SHARED_SECRET: 'test-api-secret' },
      networks: { default: null },
    },
    postgres: {
      image: postgresImageReference,
      environment: {
        POSTGRES_DB: 'vocadb',
        POSTGRES_PASSWORD: 'test-secret',
        UNICODE_CONTRACT_SENTINEL: '初音ミク🎵',
      },
      networks: { default: null },
      read_only: false,
      volumes: [{ type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' }],
    },
    qdrant: {
      image: 'diva-player-qdrant:v1.19.0-hardened-r1',
      environment: { QDRANT__TELEMETRY_DISABLED: 'true' },
      networks: { default: null },
      read_only: true,
      volumes: [{ type: 'volume', source: 'qdrant_data', target: '/qdrant/storage' }],
    },
  },
  volumes: {
    postgres_data: { name: 'backend_postgres_data' },
    qdrant_data: { name: 'backend_qdrant_data' },
  },
  networks: { default: { name: 'backend_default' } },
};

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, deepSort(value[key])]));
  }
  return value;
}

function jsonEnsureAscii(value) {
  return JSON.stringify(value).split('').map(character => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit > 0x7f ? `\\u${codeUnit.toString(16).padStart(4, '0')}` : character;
  }).join('');
}

function statefulProjectionSha256(configuration) {
  const services = {};
  const volumeSources = new Set();
  const networkSources = new Set();
  for (const serviceName of ['postgres', 'qdrant']) {
    const service = structuredClone(configuration.services[serviceName]);
    service.environment = Object.fromEntries(Object.entries(service.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        createHash('sha256').update(jsonEnsureAscii([key, value])).digest('hex'),
      ]));
    for (const mount of service.volumes ?? []) {
      if (mount.type === 'volume') volumeSources.add(mount.source);
    }
    for (const network of Object.keys(service.networks ?? {})) networkSources.add(network);
    services[serviceName] = service;
  }
  const selectDefinitions = (kind, sources) => Object.fromEntries([...sources].sort().map(source => {
    const matches = Object.entries(configuration[kind])
      .filter(([key, definition]) => key === source || definition?.name === source);
    assert.equal(matches.length, 1);
    return matches[0];
  }));
  const projection = deepSort({
    schema: 1,
    services,
    volumes: selectDefinitions('volumes', volumeSources),
    networks: selectDefinitions('networks', networkSources),
  });
  return createHash('sha256').update(`${jsonEnsureAscii(projection)}\n`).digest('hex');
}
const statefulComposeProjectionSha256 = statefulProjectionSha256(fakeStatefulComposeConfig);
const driftedStatefulComposeConfig = structuredClone(fakeStatefulComposeConfig);
driftedStatefulComposeConfig.services.qdrant.read_only = false;
const apiOnlyComposeConfig = structuredClone(fakeStatefulComposeConfig);
apiOnlyComposeConfig.services.api_a = { image: 'diva-player-api:ordinary-release' };
assert.equal(
  statefulProjectionSha256(apiOnlyComposeConfig),
  statefulComposeProjectionSha256,
  'API-only Compose changes must not invalidate the stateful runtime contract',
);

function shellPath(path) {
  return relative(projectDirectory, path).replaceAll('\\', '/');
}

function shellCommandPath(command) {
  return isAbsolute(command) ? shellPath(command) : command.replaceAll('\\', '/');
}

const nativeExactPythonCommand = process.env.DIVA_ROLLING_TEST_NATIVE_PYTHON
  ?? (process.platform === 'win32'
    ? join(projectDirectory, '..', 'diva-data-pipeline', 'ml_pipeline', '.venv', 'Scripts', 'python.exe')
    : 'python3');
const nativeExactPythonProbe = spawnSync(nativeExactPythonCommand, ['--version'], {
  cwd: projectDirectory,
  encoding: 'utf8',
  timeout: 10_000,
});
assert.equal(
  nativeExactPythonProbe.error,
  undefined,
  `native exact-cleanup Python could not be executed: ${nativeExactPythonCommand}`,
);
assert.equal(
  nativeExactPythonProbe.status,
  0,
  `native exact-cleanup Python failed its version probe: ${nativeExactPythonCommand}`,
);
const nativeExactPythonShellCommand = shellCommandPath(nativeExactPythonCommand);

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

resolve_container_name() {
    requested="$1"
    for id_file in "$containers"/*.id; do
        [ -f "$id_file" ] || continue
        if [ "$(cat "$id_file")" = "$requested" ]; then
            resolved=__DOLLAR__{id_file##*/}
            printf '%s\n' "__DOLLAR__{resolved%.id}"
            return 0
        fi
    done
    printf '%s\n' "$requested"
}

image_id() {
    case "$1" in
        diva-player-api:local) printf '%s\n' __NEW_API_ID__ ;;
        diva-player-api:rollback-api-a) printf '%s\n' __OLD_API_A_ID__ ;;
        diva-player-api:rollback-api-b) printf '%s\n' __OLD_API_B_ID__ ;;
        diva-player-api:candidate-*) read_value "$fake_root/api_candidate_tag" __NEW_API_ID__ ;;
        diva-player-api-gateway:local) printf '%s\n' "__DOLLAR__{FAKE_NEW_GATEWAY_IMAGE:-__NEW_GATEWAY_ID__}" ;;
        diva-player-api-gateway:rollback) printf '%s\n' __OLD_GATEWAY_ID__ ;;
        diva-player-api-gateway:candidate-*) read_value "$fake_root/gateway_candidate_tag" __NEW_GATEWAY_ID__ ;;
        diva-player-web:local) printf '%s\n' __NEW_WEB_ID__ ;;
        diva-player-web:rollback) printf '%s\n' __OLD_WEB_ID__ ;;
        diva-player-web:candidate-*)
            read_value "$fake_root/web_candidate_tag" __NEW_WEB_ID__
            ;;
        diva-player-qdrant:v1.19.0-hardened-r1)
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_contract_invalid_image_output" ]; then
                printf '%s\n' "sha256:123"
            elif [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_contract_retag" ]; then
                printf '%s\n' "sha256:__WRONG_QDRANT_ID__"
            else
                printf '%s\n' "sha256:__QDRANT_ID__"
            fi
            ;;
        diva-player-postgres:16.15-pgvector-0.8.6-hardened-r1)
            printf '%s\n' "sha256:__POSTGRES_ID__"
            ;;
        diva-player-postgres-migrate:16.15-hardened-r1)
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_contract_migrate_retag" ]; then
                printf '%s\n' "sha256:__WRONG_POSTGRES_MIGRATE_ID__"
            else
                printf '%s\n' "sha256:__POSTGRES_MIGRATE_ID__"
            fi
            ;;
        *) printf '%s\n' "$1" ;;
    esac
}

container_health() {
    container=$(resolve_container_name "$1")
    image=$(read_value "$containers/$container.image" unknown)
    case "__DOLLAR__{FAKE_FAIL_STAGE:-}:$container:$image" in
        api_b_health:vocadb_api_b:__NEW_API_ID__) printf '%s\n' unhealthy ;;
        candidate_health:diva_api_gateway_candidate_*:__NEW_GATEWAY_ID__) printf '%s\n' unhealthy ;;
        gateway_health:vocadb_api_gateway:__NEW_GATEWAY_ID__) printf '%s\n' unhealthy ;;
        *) read_value "$containers/$container.health" healthy ;;
    esac
}

if [ "$1" = "context" ] && [ "__DOLLAR__{2:-}" = "show" ]; then
    [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" != "platform_context_error" ] || exit 42
    if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "platform_context_remote" ]; then
        printf '%s\n' remote
    else
        printf '%s\n' default
    fi
    exit 0
fi

if [ "$1" = "context" ] && [ "__DOLLAR__{2:-}" = "inspect" ]; then
    [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" != "platform_endpoint_error" ] || exit 42
    if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "platform_endpoint_remote" ]; then
        printf '%s\n' tcp://remote.example.invalid:2376
    else
        printf '%s\n' unix:///var/run/docker.sock
    fi
    exit 0
fi

if [ "$1" = "info" ]; then
    [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" != "platform_info_error" ] || exit 42
    if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "platform_daemon" ]; then
        printf '%s\n' linux/amd64
    else
        printf '%s\n' linux/aarch64
    fi
    exit 0
fi

if [ "$1" = "inspect" ]; then
    shift
    format=""
    if [ "__DOLLAR__{1:-}" = "--format" ]; then format="$2"; shift 2; fi
    case "$format" in
        *State.StartedAt*RestartCount*)
            for requested_container in "$@"; do
                container=$(resolve_container_name "$requested_container")
                value=$(read_value "$containers/$container.id" "")
                [ -n "$value" ] || exit 1
                running=$(read_value "$containers/$container.running" true)
                image=$(read_value "$containers/$container.image" unknown)
                config_hash=$(read_value "$containers/$container.config_hash" unknown-config)
                printf '%s|/%s|%s|2026-08-28T09:51:08.000000000Z|0|%s|%s\n' \
                    "$value" "$container" "$running" "$image" "$config_hash"
            done
            exit 0
            ;;
    esac
    container=$(resolve_container_name "$1")
    case "$format" in
        *'{{.Id}}'*)
            value=$(read_value "$containers/$container.id" "")
            [ -n "$value" ] || exit 1
            printf '%s\n' "$value"
            ;;
        *State.Running*) read_value "$containers/$container.running" true ;;
        *State.Health*) container_health "$container" ;;
        *State.Status*) read_value "$containers/$container.status" running ;;
        *State.ExitCode*) read_value "$containers/$container.exit_code" 0 ;;
        *State.OOMKilled*) read_value "$containers/$container.oom_killed" false ;;
        *State.Error*) read_value "$containers/$container.runtime_error" "" ;;
        *HostConfig.MemoryReservation*) read_value "$containers/$container.memory_reservation" 67108864 ;;
        *HostConfig.Memory*) read_value "$containers/$container.memory" 268435456 ;;
        *HostConfig.PidsLimit*) read_value "$containers/$container.pids_limit" 128 ;;
        *HostConfig.NetworkMode*) read_value "$containers/$container.network" none ;;
        *HostConfig.AutoRemove*) read_value "$containers/$container.auto_remove" false ;;
        *HostConfig.RestartPolicy.Name*) read_value "$containers/$container.restart_policy" unless-stopped ;;
        *HostConfig.ReadonlyRootfs*) read_value "$containers/$container.read_only" true ;;
        *HostConfig.CapDrop*) printf '%s\n' '["ALL"]' ;;
        *HostConfig.SecurityOpt*) printf '%s\n' '["no-new-privileges=true"]' ;;
        *HostConfig.Tmpfs*) printf '%s\n' 'size=16m,mode=1777' ;;
        *'.Mounts'*) printf '%s\n' '[]' ;;
        *'com.diva.role'*) read_value "$containers/$container.role" "" ;;
        *'com.diva.deployment'*) read_value "$containers/$container.deployment" "" ;;
        *Config.Cmd*) read_value "$containers/$container.command" '[]' ;;
        *Config.User*) read_value "$containers/$container.user" "" ;;
        *Config.Labels*) read_value "$containers/$container.config_hash" unknown-config ;;
        *Image*) read_value "$containers/$container.image" unknown ;;
        *) exit 1 ;;
    esac
    exit 0
fi

if [ "$1" = "container" ] && [ "__DOLLAR__{2:-}" = "ls" ]; then
    target=""
    exact_id=""
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "--filter" ]; then
            case "$2" in
                name=^/*)
                    target=__DOLLAR__{2#name=^/}
                    target=__DOLLAR__{target%\$}
                    ;;
                id=*) exact_id=__DOLLAR__{2#id=} ;;
            esac
            shift 2
        else
            shift
        fi
    done
    if { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "web_inventory" ] && [ "$target" = "vocadb_web" ]; } \
        || { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "gateway_inventory" ] && [ "$target" = "vocadb_api_gateway" ]; }; then
        exit 1
    fi
    if [ -n "$exact_id" ]; then
        for id_file in "$containers"/*.id; do
            [ -f "$id_file" ] || continue
            [ "$(cat "$id_file")" = "$exact_id" ] || continue
            printf '%s\n' "$exact_id"
            break
        done
        exit 0
    fi
    if [ -n "$target" ] && [ -f "$containers/$target.id" ]; then
        cat "$containers/$target.id"
    fi
    exit 0
fi

if [ "$1" = "image" ]; then
    operation="$2"
    case "$operation" in
        ls)
            reference=""
            while [ "$#" -gt 0 ]; do
                if [ "$1" = "--filter" ]; then
                    reference=__DOLLAR__{2#reference=}
                    shift 2
                else
                    shift
                fi
            done
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "candidate_tag_presence_error" ]; then
                exit 2
            fi
            case "$reference" in
                diva-player-api:candidate-*) [ -f "$fake_root/api_candidate_tag" ] || exit 0 ;;
                diva-player-api-gateway:candidate-*) [ -f "$fake_root/gateway_candidate_tag" ] || exit 0 ;;
                diva-player-web:candidate-*) [ -f "$fake_root/web_candidate_tag" ] || exit 0 ;;
            esac
            printf '%s\n' "$reference"
            exit 0
            ;;
        tag)
            source="$3"
            destination=""
            for argument in "$@"; do destination="$argument"; done
            case "$destination" in
                diva-player-api:candidate-*)
                    write_value "$fake_root/api_candidate_tag" "$(image_id "$source")"
                    ;;
                diva-player-api-gateway:candidate-*)
                    write_value "$fake_root/gateway_candidate_tag" "$(image_id "$source")"
                    ;;
                diva-player-web:candidate-*)
                    write_value "$fake_root/web_candidate_tag" "$(image_id "$source")"
                    ;;
            esac
            exit 0
            ;;
        inspect)
            format=""
            image=""
            images=""
            shift 2
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --format) format="$2"; shift 2 ;;
                    *)
                        image="$1"
                        images="$images $1"
                        shift
                        ;;
                esac
            done
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_contract_image_error" ] \
                && [ "$image" = "diva-player-qdrant:v1.19.0-hardened-r1" ]; then
                exit 2
            fi
            case "$image" in
                diva-player-api:candidate-*)
                    [ -f "$fake_root/api_candidate_tag" ] || exit 1
                    ;;
                diva-player-api-gateway:candidate-*)
                    [ -f "$fake_root/gateway_candidate_tag" ] || exit 1
                    ;;
                diva-player-web:candidate-*)
                    [ -f "$fake_root/web_candidate_tag" ] || exit 1
                    ;;
            esac
            case "$format" in
                *'com.diva.qdrant.dockerfile-sha256'*)
                    if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_contract_qdrant_provenance_drift" ]; then
                        printf '%s\n' '__WRONG_QDRANT_DOCKERFILE_SHA256__'
                    else
                        printf '%s\n' '__QDRANT_DOCKERFILE_SHA256__'
                    fi
                    ;;
                *'.Id}'*Architecture*)
                    for observed_image in $images; do
                        printf '%s|linux/arm64\n' "$(image_id "$observed_image")"
                    done
                    ;;
                *Architecture*/*Os*|*Os*/*Architecture*)
                    if { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = candidate_platform ] \
                        && [ "$image" = __NEW_API_ID__ ]; } \
                        || { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = published_platform ] \
                            && [ -f "$fake_root/published-platform-active" ] \
                            && [ "$image" = __NEW_WEB_ID__ ]; } \
                        || { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" \
                                = published_unchanged_gateway_platform ] \
                            && [ -f "$fake_root/published-platform-active" ] \
                            && [ "$image" = __OLD_GATEWAY_ID__ ]; }; then
                        printf '%s\n' linux/amd64
                    else
                        printf '%s\n' linux/arm64
                    fi
                    ;;
                *Architecture*) printf '%s\n' arm64 ;;
                *Os*) printf '%s\n' linux ;;
                *) image_id "$image" ;;
            esac
            exit 0
            ;;
        rm)
            image=""
            for argument in "$@"; do image="$argument"; done
            case "$image" in
                diva-player-api:candidate-*) rm -f "$fake_root/api_candidate_tag" ;;
                diva-player-api-gateway:candidate-*) rm -f "$fake_root/gateway_candidate_tag" ;;
                diva-player-web:candidate-*) rm -f "$fake_root/web_candidate_tag" ;;
            esac
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
    create)
        shift
        name=""
        config_hash=""
        role=""
        deployment=""
        restart_policy=no
        read_only=false
        user=""
        network=""
        tmpfs=""
        memory_reservation=""
        memory=""
        pids_limit=""
        cap_drop=""
        security_opt=""
        validation_key=false
        image=""
        command='[]'
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --name) name="$2"; shift 2 ;;
                --label)
                    case "$2" in
                        com.docker.compose.config-hash=*) config_hash=__DOLLAR__{2#*=} ;;
                        com.diva.role=*) role=__DOLLAR__{2#*=} ;;
                        com.diva.deployment=*) deployment=__DOLLAR__{2#*=} ;;
                    esac
                    shift 2
                    ;;
                --restart) restart_policy="$2"; shift 2 ;;
                --read-only) read_only=true; shift ;;
                --user) user="$2"; shift 2 ;;
                --network) network="$2"; shift 2 ;;
                --tmpfs) tmpfs="$2"; shift 2 ;;
                --memory-reservation) memory_reservation="$2"; shift 2 ;;
                --memory) memory="$2"; shift 2 ;;
                --pids-limit) pids_limit="$2"; shift 2 ;;
                --cap-drop) cap_drop="$2"; shift 2 ;;
                --security-opt) security_opt="$2"; shift 2 ;;
                --env)
                    [ "$2" != GATEWAY_PROXY_KEY=config-validation-only ] \
                        || validation_key=true
                    shift 2
                    ;;
                --network-alias|--env-file|--expose|--publish|--health-cmd|--health-interval|--health-timeout|--health-retries|--health-start-period|--stop-timeout|--log-driver|--log-opt)
                    shift 2
                    ;;
                diva-player-*:*|sha256:*) image="$1"; shift ;;
                -c)
                    [ "__DOLLAR__{2:-}" = -f ] \
                        && [ "__DOLLAR__{3:-}" = /usr/local/etc/haproxy/haproxy.cfg ] \
                        || exit 64
                    command='["-c","-f","/usr/local/etc/haproxy/haproxy.cfg"]'
                    shift 3
                    ;;
                *) shift ;;
            esac
        done
        case "$name" in
            vocadb_api_a) id=4444444444444444444444444444444444444444444444444444444444444444 ;;
            vocadb_api_b) id=5555555555555555555555555555555555555555555555555555555555555555 ;;
            vocadb_api_gateway) id=6666666666666666666666666666666666666666666666666666666666666666 ;;
            vocadb_web) id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
            diva_gateway_config_validation_*)
                [ -n "$image" ] && [ "$role" = gateway-config-validation ] \
                    && [ -n "$deployment" ] && [ "$user" = haproxy ] \
                    && [ "$network" = none ] && [ "$read_only" = true ] \
                    && [ "$tmpfs" = /tmp:size=16m,mode=1777 ] \
                    && [ "$memory_reservation" = 64m ] && [ "$memory" = 256m ] \
                    && [ "$pids_limit" = 128 ] && [ "$cap_drop" = ALL ] \
                    && [ "$security_opt" = no-new-privileges=true ] \
                    && [ "$validation_key" = true ] \
                    && [ "$command" = '["-c","-f","/usr/local/etc/haproxy/haproxy.cfg"]' ] \
                    || exit 64
                if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = gateway_validation_create_absent ]; then
                    exit 137
                fi
                id=7777777777777777777777777777777777777777777777777777777777777777
                ;;
            *) exit 64 ;;
        esac
        [ -n "$name" ] && [ -n "$image" ] || exit 64
        case "$name" in
            diva_gateway_config_validation_*) ;;
            *) [ -n "$config_hash" ] || exit 64 ;;
        esac
        write_value "$containers/$name.id" "$id"
        write_value "$containers/$name.image" "$(image_id "$image")"
        write_value "$containers/$name.config_hash" "$config_hash"
        write_value "$containers/$name.role" "$role"
        write_value "$containers/$name.deployment" "$deployment"
        write_value "$containers/$name.command" "$command"
        write_value "$containers/$name.user" "$user"
        write_value "$containers/$name.restart_policy" "$restart_policy"
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = runtime_contract_drift ] \
            && [ "$name" = vocadb_api_a ]; then
            read_only=false
        fi
        write_value "$containers/$name.read_only" "$read_only"
        write_value "$containers/$name.running" false
        write_value "$containers/$name.status" created
        write_value "$containers/$name.exit_code" 0
        write_value "$containers/$name.oom_killed" false
        write_value "$containers/$name.runtime_error" ""
        write_value "$containers/$name.memory_reservation" 67108864
        write_value "$containers/$name.memory" 268435456
        write_value "$containers/$name.pids_limit" 128
        write_value "$containers/$name.network" "__DOLLAR__{network:-none}"
        write_value "$containers/$name.auto_remove" false
        write_value "$containers/$name.health" healthy
        [ "$name" != vocadb_web ] || : > "$fake_root/published-platform-active"
        printf '%s\n' "$id"
        case "__DOLLAR__{FAKE_FAIL_STAGE:-}" in
            gateway_validation_create_client_137|gateway_validation_clients_137) exit 137 ;;
        esac
        exit 0
        ;;
    update)
        [ "__DOLLAR__{2:-}" = --restart ] || exit 64
        target=$(resolve_container_name "$4")
        write_value "$containers/$target.restart_policy" "$3"
        exit 0
        ;;
    wait)
        target=$(resolve_container_name "$2")
        case "$target" in
            diva_gateway_config_validation_*) ;;
            *) exit 64 ;;
        esac
        case "__DOLLAR__{FAKE_FAIL_STAGE:-}" in
            gateway_validation_wait_client_137) exit 137 ;;
            gateway_validation_wait_mismatch) printf '%s\n' 1; exit 0 ;;
            gateway_validation_wait_multiline) printf '%s\n' 0 0; exit 0 ;;
        esac
        read_value "$containers/$target.exit_code" 0
        exit 0
        ;;
    rm)
        target=""
        for argument in "$@"; do target="$argument"; done
        target=$(resolve_container_name "$target")
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "web_old_rm_timeout" ]; then
            case "$target" in
                diva_web_previous_*)
                    (
                        # Keep the daemon-side removal later than the bounded
                        # two-sample settlement window even on a loaded CI
                        # host. The test must deterministically exercise the
                        # unresolved post-commit retention branch.
                        sleep 5
                        rm -f "$containers/$target".*
                        printf '%s\n' "$target" > "$fake_root/late-old-web-rm"
                    ) >/dev/null 2>&1 &
                    exit 124
                    ;;
            esac
        fi
        rm -f "$containers/$target".*
        case "__DOLLAR__{FAKE_FAIL_STAGE:-}:$target" in
            gateway_validation_remove_client_137:diva_gateway_config_validation_* \
                |gateway_validation_clients_137:diva_gateway_config_validation_*) exit 137 ;;
        esac
        exit 0
        ;;
    stop)
        target=""
        for argument in "$@"; do target="$argument"; done
        target=$(resolve_container_name "$target")
        write_value "$containers/$target.running" false
        exit 0
        ;;
    start)
        requested="$2"
        target=$(resolve_container_name "$requested")
        case "$target" in
            diva_gateway_config_validation_*)
                case "__DOLLAR__{FAKE_FAIL_STAGE:-}" in
                    gateway_validation_identity_swap)
                        write_value "$containers/$target.id" 9999999999999999999999999999999999999999999999999999999999999999
                        printf '%s\n' "$requested"
                        exit 0
                        ;;
                    gateway_validation_created_noop)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" created
                        exit 137
                        ;;
                    gateway_validation_running)
                        write_value "$containers/$target.running" true
                        write_value "$containers/$target.status" running
                        exit 137
                        ;;
                    gateway_validation_oom)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" exited
                        write_value "$containers/$target.exit_code" 137
                        write_value "$containers/$target.oom_killed" true
                        ;;
                    gateway_validation_config_error)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" exited
                        write_value "$containers/$target.exit_code" 1
                        write_value "$containers/$target.oom_killed" false
                        ;;
                    gateway_validation_dead)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" dead
                        write_value "$containers/$target.exit_code" 0
                        ;;
                    gateway_validation_runtime_error)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" exited
                        write_value "$containers/$target.exit_code" 0
                        write_value "$containers/$target.runtime_error" daemon-error
                        ;;
                    *)
                        write_value "$containers/$target.running" false
                        write_value "$containers/$target.status" exited
                        write_value "$containers/$target.exit_code" 0
                        write_value "$containers/$target.oom_killed" false
                        write_value "$containers/$target.runtime_error" ""
                        ;;
                esac
                case "__DOLLAR__{FAKE_FAIL_STAGE:-}" in
                    gateway_validation_start_client_137|gateway_validation_clients_137) exit 137 ;;
                esac
                printf '%s\n' "$requested"
                exit 0
                ;;
        esac
        write_value "$containers/$target.running" true
        write_value "$containers/$target.status" running
        exit 0
        ;;
    rename)
        source=$(resolve_container_name "$2")
        destination="$3"
        found=false
        for file in "$containers/$source".*; do
            [ -e "$file" ] || continue
            found=true
            suffix=__DOLLAR__{file#"$containers/$source"}
            mv "$file" "$containers/$destination$suffix"
        done
        [ "$found" = "true" ] || exit 1
        exit 0
        ;;
esac

if [ "$1" != "compose" ]; then exit 1; fi
shift
while [ "$#" -gt 0 ]; do
    case "$1" in
        --env-file)
            [ -f "__DOLLAR__{2:-}" ] || exit 64
            shift 2
            ;;
        --project-name)
            [ "__DOLLAR__{2:-}" = "backend" ] || exit 64
            shift 2
            ;;
        -f) shift 2 ;;
        *) break ;;
    esac
done
operation="$1"
shift

case "$operation" in
    config)
        if [ "__DOLLAR__{1:-}" = "-q" ]; then exit 0; fi
        [ "__DOLLAR__{1:-}" = "--format" ] && [ "__DOLLAR__{2:-}" = "json" ] || exit 64
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_projection_drift" ]; then
            printf '%s\n' '__DRIFTED_COMPOSE_CONFIG_JSON__'
        else
            printf '%s\n' '__COMPOSE_CONFIG_JSON__'
        fi
        exit 0
        ;;
    build) exit 0 ;;
    run)
        detached=false
        service=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -d) detached=true; shift ;;
                --rm|--no-deps) shift ;;
                --name) candidate_name="$2"; shift 2 ;;
                api_gateway|api_a|api_b|web|migrate) service="$1"; shift; break ;;
                *) shift ;;
            esac
        done
        reconcile_acl=false
        if [ "$service" = "migrate" ] && [ "__DOLLAR__{1:-}" = "--reconcile-migration-acl-only" ]; then
            reconcile_acl=true
        fi
        if [ "$service" = "migrate" ] && [ "$reconcile_acl" = "false" ] \
            && [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "migration" ]; then exit 1; fi
        if [ "$service" = "api_gateway" ] && [ "$detached" = "true" ]; then
            write_value "$containers/$candidate_name.id" 2222222222222222222222222222222222222222222222222222222222222222
            write_value "$containers/$candidate_name.image" "__DOLLAR__{FAKE_NEW_GATEWAY_IMAGE:-__NEW_GATEWAY_ID__}"
            write_value "$containers/$candidate_name.config_hash" "__DOLLAR__{FAKE_NEW_GATEWAY_CONFIG_HASH:-new-config}"
            write_value "$containers/$candidate_name.running" true
            printf '%s\n' candidate-id
        fi
        if { [ "$service" = "api_a" ] || [ "$service" = "api_b" ]; } \
            && [ "$detached" = "true" ]; then
            if [ "$service" = "api_a" ]; then
                candidate_id=3333333333333333333333333333333333333333333333333333333333333333
                candidate_config=api-a-config
            else
                candidate_id=7777777777777777777777777777777777777777777777777777777777777777
                candidate_config=api-b-config
            fi
            write_value "$containers/$candidate_name.id" "$candidate_id"
            write_value "$containers/$candidate_name.image" __NEW_API_ID__
            write_value "$containers/$candidate_name.config_hash" "$candidate_config"
            write_value "$containers/$candidate_name.running" true
            if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "api_candidate_health" ]; then
                write_value "$containers/$candidate_name.health" unhealthy
            else
                write_value "$containers/$candidate_name.health" healthy
            fi
            printf '%s\n' candidate-api-id
        fi
        if [ "$service" = "web" ] && [ "$detached" = "true" ]; then
            write_value "$containers/$candidate_name.id" cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
            write_value "$containers/$candidate_name.image" __NEW_WEB_ID__
            write_value "$containers/$candidate_name.config_hash" web-config
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
                    rm -f "$containers/vocadb_$service".*
                    if [ "$service" = api_a ]; then
                        write_value "$containers/vocadb_$service.id" \
                            4444444444444444444444444444444444444444444444444444444444444444
                    else
                        write_value "$containers/vocadb_$service.id" \
                            5555555555555555555555555555555555555555555555555555555555555555
                    fi
                    write_value "$containers/vocadb_$service.image" "$image"
                    if [ "$service" = api_a ]; then
                        write_value "$containers/vocadb_$service.config_hash" api-a-config
                    else
                        write_value "$containers/vocadb_$service.config_hash" api-b-config
                    fi
                    write_value "$containers/vocadb_$service.running" true
                    write_value "$containers/vocadb_$service.health" healthy
                    ;;
                api_gateway)
                    image=$(image_id "__DOLLAR__{DIVA_GATEWAY_IMAGE:-diva-player-api-gateway:local}")
                    rm -f "$containers/vocadb_api_gateway".*
                    write_value "$containers/vocadb_api_gateway.id" \
                        6666666666666666666666666666666666666666666666666666666666666666
                    write_value "$containers/vocadb_api_gateway.image" "$image"
                    write_value "$containers/vocadb_api_gateway.config_hash" "__DOLLAR__{FAKE_NEW_GATEWAY_CONFIG_HASH:-new-config}"
                    write_value "$containers/vocadb_api_gateway.running" true
                    write_value "$containers/vocadb_api_gateway.health" healthy
                    ;;
                web)
                    image=$(image_id "__DOLLAR__{DIVA_WEB_IMAGE:-diva-player-web:local}")
                    write_value "$containers/vocadb_web.id" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
                    write_value "$containers/vocadb_web.image" "$image"
                    write_value "$containers/vocadb_web.config_hash" web-config
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
`
  .replaceAll('__DOLLAR__', '$')
  .replaceAll('__QDRANT_ID__', '1'.repeat(64))
  .replaceAll('__WRONG_QDRANT_ID__', '3'.repeat(64))
  .replaceAll('__WRONG_QDRANT_DOCKERFILE_SHA256__', '8'.repeat(64))
  .replaceAll('__QDRANT_DOCKERFILE_SHA256__', qdrantDockerfileSha256)
  .replaceAll('__POSTGRES_ID__', '2'.repeat(64))
  .replaceAll('__POSTGRES_MIGRATE_ID__', '7'.repeat(64))
  .replaceAll('__WRONG_POSTGRES_MIGRATE_ID__', '6'.repeat(64))
  .replaceAll('__OLD_API_A_ID__', oldApiAImageId)
  .replaceAll('__OLD_API_B_ID__', oldApiBImageId)
  .replaceAll('__OLD_GATEWAY_ID__', oldGatewayImageId)
  .replaceAll('__OLD_WEB_ID__', oldWebImageId)
  .replaceAll('__NEW_API_ID__', newApiImageId)
  .replaceAll('__NEW_GATEWAY_ID__', newGatewayImageId)
  .replaceAll('__NEW_WEB_ID__', newWebImageId)
  .replaceAll('__COMPOSE_CONFIG_JSON__', JSON.stringify(fakeStatefulComposeConfig))
  .replaceAll('__DRIFTED_COMPOSE_CONFIG_JSON__', JSON.stringify(driftedStatefulComposeConfig));

const fakeCurl = String.raw`#!/bin/sh
set -eu
printf '%s\n' "$*" >> "__DOLLAR__{FAKE_DOCKER_STATE:?}/curl.log"
exit 0
`.replaceAll('__DOLLAR__', '$');

const fakeCompose = String.raw`#!/bin/sh
set -eu
exec "__DOLLAR__{DIVA_DOCKER_COMMAND:?}" compose "$@"
`.replaceAll('__DOLLAR__', '$');

const fakeSleep = String.raw`#!/bin/sh
exit 0
`;

const fakeTrivy = String.raw`#!/bin/sh
set -eu
operation="$1"
shift
printf '%s\n' "$operation $*" >> "__DOLLAR__{FAKE_DOCKER_STATE:?}/trivy.log"
case "$operation" in
    prepare) exit 0 ;;
    scan)
        service="$1"
        receipt="$4"
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = trivy_gateway_scan ] \
            && [ "$service" = gateway ]; then
            exit 1
        fi
        printf '{"service":"%s","imageId":"%s","status":"passed"}\n' \
            "$service" "$3" > "$receipt"
        ;;
    verify)
        service="$1"
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = trivy_receipt_verify ] \
            && [ "$service" = gateway ]; then
            exit 1
        fi
        ;;
    *) exit 64 ;;
esac
`.replaceAll('__DOLLAR__', '$');

const fakeProjectionPython = String.raw`#!/bin/sh
set -eu
if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "stateful_projection_drift" ]; then
    printf '%s\n' '__DRIFTED_PROJECTION__'
else
    printf '%s\n' '__EXPECTED_PROJECTION__'
fi
`
  .replaceAll('__DOLLAR__', '$')
  .replaceAll('__EXPECTED_PROJECTION__', statefulComposeProjectionSha256)
  .replaceAll(
    '__DRIFTED_PROJECTION__',
    statefulProjectionSha256(driftedStatefulComposeConfig),
  );

const fakeHook = String.raw`#!/bin/sh
set -eu
phase="$1"
if [ "$phase" != "__DOLLAR__{FAKE_HOOK_PHASE:-}" ]; then exit 0; fi
case "__DOLLAR__{FAKE_HOOK_ACTION:-fail}" in
    signal)
        kill -TERM "__DOLLAR__{DIVA_DEPLOYMENT_PID:?}"
        exit 0
        ;;
    hard-kill)
        # SIGKILL deliberately bypasses every shell trap so the next process
        # must reconcile only the exact durable journal/owner identities.
        kill -KILL "__DOLLAR__{DIVA_DEPLOYMENT_PID:?}"
        exit 0
        ;;
    replace-api-a|replace-api-a-and-fail)
        printf '%s\n' 9999999999999999999999999999999999999999999999999999999999999999 \
            > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_a.id"
        printf '%s\n' true > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_a.running"
        printf '%s\n' healthy > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_a.health"
        [ "__DOLLAR__{FAKE_HOOK_ACTION}" != replace-api-a-and-fail ] || exit 42
        ;;
    replace-gateway|replace-gateway-and-fail)
        printf '%s\n' 8888888888888888888888888888888888888888888888888888888888888888 \
            > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_gateway.id"
        printf '%s\n' true > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_gateway.running"
        printf '%s\n' healthy > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api_gateway.health"
        [ "__DOLLAR__{FAKE_HOOK_ACTION}" != replace-gateway-and-fail ] || exit 42
        ;;
    replace-web-and-fail)
        printf '%s\n' 0000000000000000000000000000000000000000000000000000000000000000 \
            > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_web.id"
        printf '%s\n' true > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_web.running"
        printf '%s\n' healthy > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_web.health"
        exit 42
        ;;
    replace-legacy)
        printf '%s\n' 9999999999999999999999999999999999999999999999999999999999999999 \
            > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api.id"
        printf '%s\n' true > "__DOLLAR__{FAKE_DOCKER_STATE:?}/containers/vocadb_api.running"
        ;;
    replace-backend-secret-and-fail)
        rm -f -- "__DOLLAR__{DIVA_PRIVATE_BACKEND_ENV_FILE:?}"
        printf '%s\n' 'ATTACKER_REPLACEMENT=must-not-be-deleted' \
            > "__DOLLAR__{DIVA_PRIVATE_BACKEND_ENV_FILE}"
        chmod 600 "__DOLLAR__{DIVA_PRIVATE_BACKEND_ENV_FILE}"
        exit 42
        ;;
    block-lock-cleanup-and-fail)
        printf '%s\n' blocker > "__DOLLAR__{DIVA_DEPLOY_LOCK_DIR:?}/blocker"
        exit 42
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
  const privateRuntime = join(root, 'runtime-private');
  const backendEnvironmentSource = join(root, 'backend.env.source');
  await Promise.all([mkdir(bin), mkdir(containers, { recursive: true }), mkdir(deploymentState)]);

  const dockerPath = join(bin, 'docker');
  const composePath = join(bin, 'docker-compose');
  const curlPath = join(bin, 'curl');
  const sleepPath = join(bin, 'sleep');
  const syncPath = join(bin, 'sync');
  const pythonPath = join(bin, 'python3');
  const trivyPath = join(bin, 'trivy');
  const hookPath = join(bin, 'hook');
  await Promise.all([
    writeFile(dockerPath, fakeDocker, 'utf8'),
    writeFile(composePath, fakeCompose, 'utf8'),
    writeFile(curlPath, fakeCurl, 'utf8'),
    writeFile(sleepPath, fakeSleep, 'utf8'),
    writeFile(syncPath, fakeSleep, 'utf8'),
    writeFile(pythonPath, fakeProjectionPython, 'utf8'),
    writeFile(trivyPath, fakeTrivy, 'utf8'),
    writeFile(hookPath, fakeHook, 'utf8'),
  ]);
  await Promise.all([
    chmod(dockerPath, 0o755),
    chmod(composePath, 0o755),
    chmod(curlPath, 0o755),
    chmod(sleepPath, 0o755),
    chmod(syncPath, 0o755),
    chmod(pythonPath, 0o755),
    chmod(trivyPath, 0o755),
    chmod(hookPath, 0o755),
  ]);

  const initialFiles = {
    'vocadb_api_a.image': oldApiAImageId,
    'vocadb_api_a.id': 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'vocadb_api_b.image': oldApiBImageId,
    'vocadb_api_b.id': 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'vocadb_api_gateway.image': oldGatewayImageId,
    'vocadb_api_gateway.id': 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'vocadb_api_a.running': 'true',
    'vocadb_api_b.running': 'true',
    'vocadb_api_gateway.running': 'true',
    'vocadb_api_a.health': 'healthy',
    'vocadb_api_b.health': 'healthy',
    'vocadb_api_gateway.health': 'healthy',
    'vocadb_api_gateway.config_hash': 'old-config',
    'vocadb_web.image': oldWebImageId,
    'vocadb_web.id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'vocadb_web.running': 'true',
    'vocadb_web.health': 'healthy',
    'vocadb_api.image': legacyApiImageId,
    'vocadb_api.id': '1111111111111111111111111111111111111111111111111111111111111111',
    'vocadb_api.running': name.startsWith('bootstrap-') ? 'true' : 'false',
  };
  await Promise.all(Object.entries(initialFiles).map(([file, value]) =>
    writeFile(join(containers, file), `${value}\n`, 'utf8')));
  if (name.startsWith('bootstrap-')) {
    await Promise.all([
      'vocadb_api_a',
      'vocadb_api_b',
      'vocadb_api_gateway',
    ].flatMap((container) => [
      rm(join(containers, `${container}.id`), { force: true }),
      rm(join(containers, `${container}.image`), { force: true }),
      rm(join(containers, `${container}.running`), { force: true }),
      rm(join(containers, `${container}.health`), { force: true }),
      rm(join(containers, `${container}.config_hash`), { force: true }),
    ]));
  }
  await Promise.all([
    writeFile(join(fakeState, 'api_a.route'), 'UP\n', 'utf8'),
    writeFile(join(fakeState, 'api_b.route'), 'UP\n', 'utf8'),
  ]);
  const runtimeContract = [
    'schema=1',
    'status=completed',
    'run=20260830T000000Z-1',
    'qdrant_stable_tag=diva-player-qdrant:v1.19.0-hardened-r1',
    `qdrant_image_id=${qdrantImageId}`,
    `qdrant_source_commit=${name === 'stateful-contract-qdrant-source-untrusted'
      ? 'f'.repeat(40)
      : playerCommit}`,
    `qdrant_dockerfile_sha256=${qdrantDockerfileSha256}`,
    `postgres_image_reference=${postgresImageReference}`,
    `postgres_image_id=${postgresImageId}`,
    `postgres_migrate_image_reference=${postgresMigrateImageReference}`,
    `postgres_migrate_image_id=${postgresMigrateImageId}`,
    `qdrant_image_scan_receipt_sha256=${'a'.repeat(64)}`,
    `qdrant_audit_image_scan_receipt_sha256=${'b'.repeat(64)}`,
    `postgres_image_scan_receipt_sha256=${'c'.repeat(64)}`,
    `postgres_migrate_image_scan_receipt_sha256=${'d'.repeat(64)}`,
    `postgres_dockerfile_sha256=${'e'.repeat(64)}`,
    `postgres_schema_sha256=${'f'.repeat(64)}`,
    `postgres_source_bundle_sha256=${'0'.repeat(64)}`,
    `postgres_migrate_dockerfile_sha256=${'9'.repeat(64)}`,
    `stateful_compose_projection_sha256=${statefulComposeProjectionSha256}`,
    `promotion_manifest_sha256=${'c'.repeat(64)}`,
    `player_commit=${name === 'stateful-contract-ancestor' ? playerAncestorCommit : playerCommit}`,
    `pipeline_commit=${'d'.repeat(40)}`,
    '',
  ].join('\n');
  const runtimeContractPath = join(deploymentState, 'stateful-runtime-contract');
  await writeFile(runtimeContractPath, runtimeContract, 'utf8');
  await chmod(runtimeContractPath, 0o600);
  await writeFile(
    backendEnvironmentSource,
    backendEnvironmentFixture,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(backendEnvironmentSource, 0o600);

  return {
    root, fakeState, deploymentState, privateRuntime, dockerPath, composePath, curlPath, sleepPath,
    syncPath, pythonPath, trivyPath, hookPath, backendEnvironmentSource,
  };
}

async function readDeploymentState(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const deployment = entries.find((entry) => entry.isDirectory() && entry.name !== 'deploy.lock');
  assert.ok(deployment, 'deployment state directory was not created');
  return readFile(join(directory, deployment.name, 'state'), 'utf8');
}

function scenarioEnvironment(
  scenario,
  name,
  failStage = '',
  hookPhase = '',
  hookAction = '',
  overrides = {},
) {
  return {
    ...process.env,
    DIVA_DEPLOY_TEST_MODE: '1',
    DIVA_DOCKER_COMMAND: shellPath(scenario.dockerPath),
    DIVA_COMPOSE_COMMAND: shellPath(scenario.composePath),
    DIVA_CURL_COMMAND: shellPath(scenario.curlPath),
    DIVA_SLEEP_COMMAND: shellPath(scenario.sleepPath),
    DIVA_SYNC_COMMAND: shellPath(scenario.syncPath),
    DIVA_DEPLOY_PYTHON_COMMAND: shellPath(scenario.pythonPath),
    // Projection calculation remains a deterministic fake, while security-
    // sensitive exact-inode cleanup executes the same isolated Python branch
    // as production with a real native interpreter.
    DIVA_DEPLOY_EXACT_PYTHON_COMMAND: nativeExactPythonShellCommand,
    DIVA_TRIVY_COMMAND: shellPath(scenario.trivyPath),
    DIVA_DEPLOY_HOOK_COMMAND: shellPath(scenario.hookPath),
    DIVA_DEPLOY_STATE_DIR: shellPath(scenario.deploymentState),
    DIVA_DEPLOY_PRIVATE_RUNTIME_DIR: shellPath(scenario.privateRuntime),
    DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE: shellPath(scenario.backendEnvironmentSource),
    DIVA_DEPLOY_TEST_PLATFORM_PROBE: 'skip',
    DIVA_DEPLOY_HEALTH_ATTEMPTS: '1',
    DIVA_DEPLOY_DRAIN_ATTEMPTS: '1',
    DIVA_DEPLOY_ROUTE_ATTEMPTS: '3',
    DIVA_DEPLOY_DAEMON_SETTLE_ATTEMPTS: '2',
    DIVA_DEPLOY_DAEMON_STABLE_SAMPLES: '2',
    DIVA_DEPLOY_WAIT_SECONDS: '0',
    FAKE_DOCKER_STATE: shellPath(scenario.fakeState),
    FAKE_FAIL_STAGE: failStage,
    FAKE_HOOK_PHASE: hookPhase,
    FAKE_HOOK_ACTION: hookAction,
    FAKE_NEW_GATEWAY_IMAGE: name === 'config-only' || name === 'unchanged'
      ? oldGatewayImageId
      : newGatewayImageId,
    FAKE_NEW_GATEWAY_CONFIG_HASH: name === 'unchanged' ? 'old-config' : 'new-config',
    ...overrides,
  };
}

function executeScenario(
  scenario,
  name,
  {
    failStage = '',
    hookPhase = '',
    hookAction = '',
    environment = {},
    timeout = configuredScenarioTimeout,
  } = {},
) {
  return spawnSync('sh', [shellPath(deploymentScript)], {
    cwd: projectDirectory,
    encoding: 'utf8',
    timeout,
    env: scenarioEnvironment(
      scenario,
      name,
      failStage,
      hookPhase,
      hookAction,
      environment,
    ),
  });
}

async function runScenario(name, failStage = '', hookPhase = '', hookAction = '', lockHeld = false) {
  const scenario = await createScenario(name);
  try {
    if (lockHeld) {
      const lockDirectory = join(scenario.deploymentState, 'deploy.lock');
      await mkdir(lockDirectory);
      await writeFile(join(lockDirectory, 'owner'), 'pid=existing started=2026-08-10T00:00:00Z\n', 'utf8');
    }
    // Finite Docker-query wrappers deliberately put every fake inspect/ls
    // behind a process deadline. Git Bash process startup dominates this
    // execution matrix on Windows, so allow the measured nominal path to
    // finish without weakening any per-command timeout in production.
    const result = executeScenario(scenario, name, {
      failStage,
      hookPhase,
      hookAction,
    });
    assert.equal(result.error, undefined, `rolling scenario ${name} failed to execute`);
    assert.notEqual(result.status, null, `rolling scenario ${name} ended without an exit status`);
    if (failStage === 'web_old_rm_timeout') {
      await new Promise(resolve => setTimeout(resolve, 5_500));
    }
    const [
      dockerLog, state, apiARoute, apiBRoute, webId, webImage, webRunning,
      apiAId, apiBId, gatewayId, containerEntries,
      activeJournal, lockOwner, lateOldWebRemoval, legacyId, legacyRunning,
      trivyLog, privateBackendEnvironment, lockBlocker, privateRuntimeEntries,
    ] = await Promise.all([
      readFile(join(scenario.fakeState, 'docker.log'), 'utf8').catch(() => ''),
      readDeploymentState(scenario.deploymentState).catch(() => ''),
      readFile(join(scenario.fakeState, 'api_a.route'), 'utf8'),
      readFile(join(scenario.fakeState, 'api_b.route'), 'utf8'),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_web.id'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_web.image'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_web.running'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_api_a.id'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_api_b.id'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_api_gateway.id'), 'utf8').catch(() => ''),
      readdir(join(scenario.fakeState, 'containers')).catch(() => []),
      readFile(join(scenario.deploymentState, 'rolling-deployment-active'), 'utf8').catch(() => ''),
      readFile(join(scenario.deploymentState, 'deploy.lock', 'owner'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'late-old-web-rm'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_api.id'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'containers', 'vocadb_api.running'), 'utf8').catch(() => ''),
      readFile(join(scenario.fakeState, 'trivy.log'), 'utf8').catch(() => ''),
      readFile(join(scenario.privateRuntime, 'backend.env.private'), 'utf8').catch(() => ''),
      readFile(join(scenario.deploymentState, 'deploy.lock', 'blocker'), 'utf8').catch(() => ''),
      readdir(scenario.privateRuntime).catch(() => null),
    ]);
    return {
      result,
      dockerLog,
      state,
      apiARoute: apiARoute.trim(),
      apiBRoute: apiBRoute.trim(),
      webId: webId.trim(),
      webImage: webImage.trim(),
      webRunning: webRunning.trim(),
      apiAId: apiAId.trim(),
      apiBId: apiBId.trim(),
      gatewayId: gatewayId.trim(),
      containerEntries,
      activeJournal: activeJournal.trim(),
      lockOwner: lockOwner.trim(),
      lateOldWebRemoval: lateOldWebRemoval.trim(),
      legacyId: legacyId.trim(),
      legacyRunning: legacyRunning.trim(),
      trivyLog,
      privateBackendEnvironment,
      lockBlocker: lockBlocker.trim(),
      privateRuntimeEntries,
    };
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
}

function assertExactOldRollingIdentities(result) {
  assert.equal(result.apiAId, 'd'.repeat(64));
  assert.equal(result.apiBId, 'e'.repeat(64));
  assert.equal(result.gatewayId, 'f'.repeat(64));
  assert.equal(result.containerEntries.some(entry => entry.includes('_previous_')), false);
}

async function testStatefulQdrantProvenanceDriftFailsClosed() {
  const result = await runScenario(
    'stateful-contract-qdrant-provenance-drift',
    'stateful_contract_qdrant_provenance_drift',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /failure=Qdrant image Dockerfile provenance drifted from the completed runtime contract/,
  );
  assert.doesNotMatch(
    result.dockerLog,
    /compose [^\n]*--project-name backend .* build/u,
  );
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
}

async function testStatefulQdrantSourceCommitFailsClosed() {
  const result = await runScenario('stateful-contract-qdrant-source-untrusted');
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /failure=Stateful runtime contract Qdrant source commit is not an ancestor of this release/,
  );
  assert.doesNotMatch(result.dockerLog, /image inspect|compose [^\n]* build/u);
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
}

function assertGatewayValidationCleanlyRemoved(result) {
  assertExactOldRollingIdentities(result);
  assert.equal(
    result.containerEntries.some(entry => entry.includes('diva_gateway_config_validation_')),
    false,
    'exact HAProxy validation container residue remained after a settled result',
  );
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
  assert.doesNotMatch(result.state, /daemon_mutation\.terminal_release=forbidden/u);
}

async function testGatewayConfigValidationSettlementContract() {
  const clientKilled = await runScenario(
    'gateway-validation-clients-killed',
    'gateway_validation_clients_137',
    'before-migration-publication-quiesce',
    'fail',
  );
  assert.equal(clientKilled.result.status, 97, JSON.stringify({
    stdout: clientKilled.result.stdout,
    stderr: clientKilled.result.stderr,
    state: clientKilled.state,
  }, null, 2));
  assert.match(
    clientKilled.state,
    /daemon_mutation\.\d+\.phase=settled-client-exit-137-exact-created/u,
  );
  assert.match(clientKilled.state, /gateway\.config_validation_client_exit=137/u);
  assert.match(
    clientKilled.state,
    /gateway\.config_validation_cleanup=exact-removed-client-exit-137/u,
  );
  assert.match(
    clientKilled.state,
    /gateway\.config_validation=passed-exact-container-client-exit-137/u,
  );
  assert.match(clientKilled.state, /gateway\.config_validation_wait=exact-one-line-exit-0/u);
  assert.match(clientKilled.state, /hook\.failure=before-migration-publication-quiesce/u);
  assertGatewayValidationCleanlyRemoved(clientKilled);

  const oomKilled = await runScenario(
    'gateway-validation-oom',
    'gateway_validation_oom',
  );
  assert.notEqual(oomKilled.result.status, 0);
  assert.match(oomKilled.result.stderr, /validation was OOM-killed \(exit 137\)/u);
  assert.match(
    oomKilled.state,
    /gateway\.config_validation_runtime=status-exited-exit-137-oom-true/u,
  );
  assert.doesNotMatch(oomKilled.state, /gateway\.config_validation=passed/u);
  assertGatewayValidationCleanlyRemoved(oomKilled);

  const configError = await runScenario(
    'gateway-validation-config-error',
    'gateway_validation_config_error',
  );
  assert.notEqual(configError.result.status, 0);
  assert.match(
    configError.result.stderr,
    /configuration validation failed with exit 1/u,
  );
  assert.match(
    configError.state,
    /gateway\.config_validation_runtime=status-exited-exit-1-oom-false/u,
  );
  assert.doesNotMatch(configError.state, /gateway\.config_validation=passed/u);
  assert.doesNotMatch(configError.dockerLog, /compose .* run .* migrate/u);
  assertGatewayValidationCleanlyRemoved(configError);

  const dead = await runScenario(
    'gateway-validation-dead',
    'gateway_validation_dead',
  );
  assert.notEqual(dead.result.status, 0);
  assert.match(
    dead.result.stderr,
    /did not reach the exact exited state \(status dead\)/u,
  );
  assert.match(
    dead.state,
    /gateway\.config_validation_runtime=status-dead-exit-0-oom-false/u,
  );
  assert.doesNotMatch(dead.state, /gateway\.config_validation=passed/u);
  assertGatewayValidationCleanlyRemoved(dead);

  const waitKilled = await runScenario(
    'gateway-validation-wait-killed',
    'gateway_validation_wait_client_137',
  );
  assert.notEqual(waitKilled.result.status, 0);
  assert.match(waitKilled.result.stderr, /wait receipt was not an exact one-line/u);
  assert.match(
    waitKilled.state,
    /gateway\.config_validation_wait_observed=client-exit-137-lines-0/u,
  );
  assert.doesNotMatch(waitKilled.state, /gateway\.config_validation=passed/u);
  assertGatewayValidationCleanlyRemoved(waitKilled);

  const identityDrift = await runScenario(
    'gateway-validation-identity-drift',
    'gateway_validation_identity_swap',
  );
  assert.notEqual(identityDrift.result.status, 0);
  assertExactOldRollingIdentities(identityDrift);
  assert.match(
    identityDrift.state,
    /daemon_mutation\.terminal_release=forbidden-docker-start-gateway-config-validation-initial-contract-drift/u,
  );
  assert.equal(identityDrift.activeJournal.length > 0, true);
  assert.equal(identityDrift.lockOwner.length > 0, true);
  assert.equal(
    identityDrift.containerEntries.some(
      entry => entry.includes('diva_gateway_config_validation_'),
    ),
    true,
    'identity drift evidence must be retained',
  );
  assert.doesNotMatch(identityDrift.dockerLog, /rm 7777777777777777777777777777777777777777777777777777777777777777/u);
  assert.doesNotMatch(identityDrift.dockerLog, /rm 9999999999999999999999999999999999999999999999999999999999999999/u);
}

async function testWebOldRemovalTimeout() {
  const result = await runScenario('web-old-rm-timeout', 'web_old_rm_timeout');
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /deployment\.status=committed-daemon-cleanup-unresolved-manual-reconciliation-required/u,
  );
  assert.match(result.state, /web\.previous_cleanup=deferred-safe-retention/u);
  assert.doesNotMatch(result.state, /web\.rollback=/u);
  assert.equal(result.webId, 'b'.repeat(64));
  assert.equal(result.webImage, newWebImageId);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
  assert.match(result.lateOldWebRemoval, /^diva_web_previous_/u);
  assert.equal(result.apiAId, '4'.repeat(64));
  assert.equal(result.apiBId, '5'.repeat(64));
  assert.equal(result.gatewayId, '6'.repeat(64));
}

async function testBootstrapGatewayPublishedFailure() {
  const result = await runScenario(
    'bootstrap-gateway-published-failure',
    '',
    'bootstrap-gateway-published',
    'fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /bootstrap\.gateway_id=6{64}/u);
  assert.match(result.state, /bootstrap\.recovery=completed/u);
  assert.match(result.dockerLog, /rm -f 6{64}/u);
  assert.match(result.dockerLog, /rm -f 4{64}/u);
  assert.match(result.dockerLog, /rm -f 5{64}/u);
  assert.equal(result.gatewayId, '');
  assert.equal(result.apiAId, '');
  assert.equal(result.apiBId, '');
  assert.equal(result.legacyId, '1'.repeat(64));
  assert.equal(result.legacyRunning, 'true');
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
}

async function testUnownedApiReplacementIsPreserved() {
  const result = await runScenario(
    'unowned-api-replacement',
    '',
    'slot-replaced:api_a',
    'replace-api-a-and-fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.equal(result.apiAId, '9'.repeat(64));
  assert.doesNotMatch(result.dockerLog, /rm -f 9{64}/u);
  assert.match(result.state, /topology_drift\.interlock=vocadb_api_a-rollback-owned-4{64}-observed-9{64}/u);
  assert.match(result.state, /recovery\.status=incomplete-manual-intervention-required/u);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
}

async function testPreflightLegacyReplacementIsPreserved() {
  const result = await runScenario(
    'bootstrap-legacy-replacement',
    '',
    'before-migration-publication-quiesce',
    'replace-legacy',
  );
  assert.notEqual(result.result.status, 0);
  assert.equal(result.legacyId, '9'.repeat(64));
  assert.equal(result.legacyRunning, 'true');
  assert.doesNotMatch(result.dockerLog, /stop --time 30 9{64}/u);
  assert.match(result.state, /topology_drift\.interlock=legacy-migration-expected-1{64}-observed-9{64}/u);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
}

async function testUnownedGatewayReplacementIsPreserved() {
  const result = await runScenario(
    'unowned-gateway-replacement',
    '',
    'gateway-replaced',
    'replace-gateway-and-fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.equal(result.gatewayId, '8'.repeat(64));
  assert.doesNotMatch(result.dockerLog, /rm -f 8{64}/u);
  assert.match(result.state, /topology_drift\.interlock=gateway-rollback-owned-6{64}-observed-8{64}/u);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
}

async function testUnownedWebReplacementIsPreserved() {
  const result = await runScenario(
    'unowned-web-replacement',
    '',
    'web-replaced',
    'replace-web-and-fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.equal(result.webId, '0'.repeat(64));
  assert.doesNotMatch(result.dockerLog, /rm -f 0{64}/u);
  assert.match(result.state, /topology_drift\.interlock=web-rollback-owned-b{64}-observed-0{64}/u);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
}

async function testGatewayAndRouteIdentitySwapsFailClosed() {
  const gateway = await runScenario(
    'gateway-identity-swap',
    '',
    'before-migration-publication-quiesce',
    'replace-gateway',
  );
  assert.notEqual(gateway.result.status, 0);
  assert.equal(gateway.gatewayId, '8'.repeat(64));
  assert.doesNotMatch(gateway.dockerLog, /exec -i 8{64}/u);
  assert.match(gateway.state, /topology_drift\.interlock=gateway-running-expected-f{64}-observed-8{64}/u);
  assert.notEqual(gateway.activeJournal, '');

  const route = await runScenario(
    'route-identity-swap',
    '',
    'before-route-enable:api_a',
    'replace-api-a',
  );
  assert.notEqual(route.result.status, 0);
  assert.equal(route.apiAId, '9'.repeat(64));
  assert.doesNotMatch(route.dockerLog, /rm -f 9{64}/u);
  assert.match(route.state, /topology_drift\.interlock=vocadb_api_a-expected-d{64}-observed-9{64}/u);
  assert.notEqual(route.activeJournal, '');
}

async function testStatefulMigrateContractRetagFailsClosed() {
  const result = await runScenario(
    'stateful-migrate-contract-retag',
    'stateful_contract_migrate_retag',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /failure=Stateful Docker image references drifted from the completed runtime contract/,
  );
  assert.match(
    result.dockerLog,
    /image inspect --format \{\{\.Id\}\} diva-player-postgres-migrate:16\.15-hardened-r1/u,
  );
  assert.doesNotMatch(
    result.dockerLog,
    /compose [^\n]*--project-name backend .* build/u,
  );
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
}

async function testNormalCandidatePlatformFailsClosed() {
  const result = await runScenario('normal-candidate-platform', 'candidate_platform');
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /failure=A rolling candidate is not a native linux\/arm64 image/u);
  assert.equal(result.trivyLog, '');
  assert.match(result.state, /backend_env\.private_cleanup=durable-exact-inode-unlink/u);
  assert.match(result.state, /backend_env\.private_runtime_cleanup=durable-tmpfs-dirfd-release/u);
  assert.match(result.state, /deployment\.journal_cleanup=durable-exact-inode-release/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.privateRuntimeEntries, null);
  assert.equal(result.lockOwner, '');
  assertExactOldRollingIdentities(result);
}

async function testPrivateRuntimeSignalCleanup() {
  const result = await runScenario(
    'private-runtime-signal',
    '',
    'private-runtime-captured',
    'signal',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /deployment\.signal=TERM/u);
  assert.match(result.state, /backend_env\.private_cleanup=durable-exact-inode-unlink/u);
  assert.match(result.state, /backend_env\.private_runtime_cleanup=durable-tmpfs-dirfd-release/u);
  assert.match(result.state, /deployment\.journal_cleanup=durable-exact-inode-release/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.privateRuntimeEntries, null);
  assert.equal(result.activeJournal, '');
  assert.equal(result.lockOwner, '');
  assertExactOldRollingIdentities(result);
}

async function testDockerPlatformPreflightFailureCleanup() {
  for (const failStage of [
    'platform_context_error',
    'platform_context_remote',
    'platform_endpoint_error',
    'platform_endpoint_remote',
    'platform_info_error',
    'platform_daemon',
  ]) {
    const name = `platform-preflight-${failStage}`;
    const scenario = await createScenario(name);
    try {
      const result = executeScenario(scenario, name, {
        failStage,
        environment: { DIVA_DEPLOY_TEST_PLATFORM_PROBE: 'native' },
      });
      assert.equal(result.error, undefined, `${name} failed to execute`);
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
      assert.match(
        result.stderr,
        /production host\/Docker endpoint\/daemon platform is not trusted native linux\/aarch64/u,
      );
      const state = await readDeploymentState(scenario.deploymentState);
      assert.match(
        state,
        /failure=production host\/Docker endpoint\/daemon platform is not trusted native linux\/aarch64/u,
      );
      assert.match(state, /deployment\.status=failed/u);
      assert.doesNotMatch(state, /daemon_mutation\.terminal_release/u);
      assert.doesNotMatch(state, /deployment\.interlock/u);

      const dockerLog = await readFile(join(scenario.fakeState, 'docker.log'), 'utf8');
      assert.match(dockerLog, /^context show\|/mu);
      if (
        failStage === 'platform_context_error'
        || failStage === 'platform_context_remote'
        || failStage === 'platform_endpoint_error'
        || failStage === 'platform_endpoint_remote'
      ) {
        assert.doesNotMatch(dockerLog, /^info /mu);
      } else {
        assert.match(dockerLog, /^info --format /mu);
      }
      const dockerCommands = dockerLog.trim().split('\n').map(line => line.split('|', 1)[0]);
      const expectedDockerCommands = ['context show'];
      if (failStage !== 'platform_context_error' && failStage !== 'platform_context_remote') {
        expectedDockerCommands.push(
          'context inspect --format {{.Endpoints.docker.Host}} default',
        );
      }
      if (
        ![
          'platform_context_error',
          'platform_context_remote',
          'platform_endpoint_error',
          'platform_endpoint_remote',
        ].includes(failStage)
      ) {
        expectedDockerCommands.push('info --format {{.OSType}}/{{.Architecture}}');
      }
      assert.deepEqual(
        dockerCommands,
        expectedDockerCommands,
      );

      const deploymentEntries = await readdir(scenario.deploymentState, {
        withFileTypes: true,
      });
      assert.ok(!deploymentEntries.some(entry => entry.name === 'deploy.lock'));
      assert.ok(!deploymentEntries.some(entry => entry.name === 'rolling-deployment-active'));
      const deployment = deploymentEntries.find(
        entry => entry.isDirectory() && entry.name !== 'deploy.lock',
      );
      assert.ok(deployment);
      const runEntries = await readdir(join(scenario.deploymentState, deployment.name));
      assert.ok(!runEntries.includes('docker-query-output'));
      assert.equal(
        await readFile(
          join(scenario.deploymentState, 'rolling-deployment-active'),
          'utf8',
        ).catch(() => ''),
        '',
      );
      assert.equal(
        await readFile(
          join(scenario.deploymentState, 'deploy.lock', 'owner'),
          'utf8',
        ).catch(() => ''),
        '',
      );
      assert.equal(await readdir(scenario.privateRuntime).catch(() => null), null);
    } finally {
      await rm(scenario.root, { recursive: true, force: true });
    }
  }
}

function testBridgeTrivyAndExactImageContract() {
  assert.match(
    deploymentSource,
    /if \[ "\$DEPLOYMENT_STATE_INITIALIZED" != "true" \][\s\S]*?exit "\$original_exit_code"\s+fi/u,
  );
  assert.doesNotMatch(
    deploymentSource,
    /fail "[^"\n]+"\n\s+exit 75/u,
    'fail returns nonzero, so deliberate temporary-failure exits must preserve 75 explicitly',
  );
  assert.match(
    deploymentSource,
    /\[ -z "\$\{DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE\+x\}" \] \|\| \{\s+printf '%s\\n' 'ERROR: production backend environment source override is forbidden'/u,
  );
  assert.match(
    deploymentSource,
    /\[ -n "\$\{DIVA_DEPLOY_TEST_BACKEND_ENV_SOURCE:-\}" \] \|\| \{\s+printf '%s\\n' 'ERROR: deterministic deployment test backend environment source is required'/u,
  );
  assert.match(
    deploymentSource,
    /capture_private_backend_environment\(\) \{\s+local source="\$BACKEND_ENV_SOURCE"/u,
  );
  assert.match(
    deploymentSource,
    /1:--bootstrap-legacy-qdrant-bridge\) BRIDGE_BOOTSTRAP_MODE=true/u,
  );
  assert.match(
    deploymentSource,
    /if \[ "\$BRIDGE_BOOTSTRAP_MODE" != "true" \]; then\s+if ! validate_stateful_runtime_contract;/u,
  );
  assert.match(
    deploymentSource,
    /qdrant_image_id\nqdrant_source_commit\nqdrant_dockerfile_sha256\npostgres_image_reference/u,
  );
  assert.match(
    deploymentSource,
    /com\.diva\.qdrant\.dockerfile-sha256/u,
  );
  assert.match(
    deploymentSource,
    /bounded_compose "\$BUILD_TIMEOUT_SECONDS" build api_a api_gateway web/u,
  );
  assert.match(
    deploymentSource,
    /if ! scan_all_rolling_candidate_images; then/u,
  );
  assert.match(
    deploymentSource,
    /verify_production_docker_platform\(\) \{[\s\S]*?\[ "\$DEPLOYMENT_STATE_INITIALIZED" = "true" \][\s\S]*?stat -c '%d:%i' "\$DEPLOYMENT_DIR"[\s\S]*?run_bounded_docker_preflight_query context show[\s\S]*?run_bounded_docker_preflight_query context inspect[\s\S]*?\[ "\$context_endpoint" = "unix:\/\/\/var\/run\/docker\.sock" \]/u,
    'production Docker queries must require an initialized, identity-pinned deployment directory',
  );
  const preflightQueryStart = deploymentSource.indexOf(
    'run_bounded_docker_preflight_query() {',
  );
  const boundedQueryStart = deploymentSource.indexOf(
    'run_bounded_docker_query() {',
    preflightQueryStart,
  );
  const preflightQueryContract = deploymentSource.slice(
    preflightQueryStart,
    boundedQueryStart,
  );
  assert.match(
    preflightQueryContract,
    /DAEMON_MUTATION_SEQUENCE" -eq 0[\s\S]*DEPLOY_LOCK_HELD" = "false"[\s\S]*ACTIVE_JOURNAL_CREATED" = "false"/u,
    'platform capture must remain a pre-mutation, pre-lock, pre-journal read',
  );
  assert.doesNotMatch(
    preflightQueryContract,
    /mark_daemon_unresolved/u,
    'a failed read-only platform capture must not claim an unresolved Docker mutation',
  );
  const mainPreflightStart = deploymentSource.lastIndexOf(
    'for positive_setting in "$HEALTH_ATTEMPTS"',
  );
  const mainPreflight = deploymentSource.slice(
    mainPreflightStart,
    deploymentSource.indexOf('if ! create_private_runtime_root; then', mainPreflightStart),
  );
  const stateDirectoryCreation = mainPreflight.indexOf(
    'if ! create_deployment_state_directory; then',
  );
  const deployLockAcquisition = mainPreflight.indexOf('if ! acquire_deploy_lock; then');
  const activeJournalCreation = mainPreflight.indexOf('ACTIVE_JOURNAL_CREATED=true');
  const platformVerification = mainPreflight.indexOf('verify_production_docker_platform');
  assert.ok(
    stateDirectoryCreation >= 0
      && stateDirectoryCreation < platformVerification
      && platformVerification < deployLockAcquisition
      && deployLockAcquisition < activeJournalCreation,
    'production Docker platform queries must run after state initialization but before mutation ownership',
  );
  assert.match(
    deploymentSource,
    /migration\.status" "forbidden-by-pre-stateful-stateless-bootstrap"[\s\S]*verify_bridge_legacy_contract/u,
  );
  assert.match(
    deploymentSource,
    /verify_bridge_stateful_contract\(\)[\s\S]*compose_service_container_ids migrate[\s\S]*capture_bridge_stateful_runtime_snapshot[\s\S]*capture_bridge_stateful_platform_snapshot/u,
  );
  assert.match(
    deploymentSource,
    /capture_bridge_stateful_runtime_snapshot\(\)[\s\S]*\.State\.StartedAt[\s\S]*\.RestartCount[\s\S]*com\.docker\.compose\.config-hash/u,
  );
  assert.match(
    deploymentSource,
    /canonicalize_bridge_mounts_json\(\)[\s\S]*json\.load\(sys\.stdin\)[\s\S]*encoded = sorted[\s\S]*sort_keys=True[\s\S]*capture_bridge_stateful_mounts_snapshot/u,
  );
  assert.match(
    deploymentSource,
    /BRIDGE_STATEFUL_MOUNTS_SNAPSHOT=\$\(printf[\s\S]*BRIDGE_QDRANT_MOUNTS_JSON[\s\S]*mounts_snapshot=.*capture_bridge_stateful_mounts_snapshot[\s\S]*mounts-snapshot-changed/u,
  );
  assert.match(
    deploymentSource,
    /BRIDGE_STATEFUL_RUNTIME_SNAPSHOT=.*capture_bridge_stateful_runtime_snapshot[\s\S]*runtime_snapshot=.*capture_bridge_stateful_runtime_snapshot[\s\S]*runtime-snapshot-changed/u,
  );
  assert.match(
    deploymentSource,
    /capture_bridge_stateful_platform_snapshot\(\)[\s\S]*image inspect[\s\S]*\.Os[\s\S]*\.Architecture[\s\S]*platform-snapshot-changed/u,
  );
  assert.match(
    deploymentSource,
    /--api-scan-receipt-sha256 "\$API_SCAN_RECEIPT_SHA"[\s\S]*--gateway-scan-receipt-sha256 "\$GATEWAY_SCAN_RECEIPT_SHA"[\s\S]*--web-scan-receipt-sha256 "\$WEB_SCAN_RECEIPT_SHA"/u,
  );
  assert.match(
    deploymentSource,
    /CANDIDATE_SCAN_REVERIFY_SEQUENCE=0[\s\S]*verification="\$IMAGE_SCAN_ROOT\/\$service\.reverification\.\$sequence\.json"[\s\S]*CANDIDATE_SCAN_REVERIFY_SEQUENCE=\$\(\(CANDIDATE_SCAN_REVERIFY_SEQUENCE \+ 1\)\)[\s\S]*image_scan\.reverification\.\$sequence/u,
  );
  assert.match(
    deploymentSource,
    /create_managed_service_container "\$slot" "\$expected_config_hash" \\\s+"\$CANDIDATE_API_IMAGE_ID" "\$CANDIDATE_API_IMAGE_ID"/u,
  );
  assert.match(
    deploymentSource,
    /create_managed_service_container api_gateway "\$CANDIDATE_CONFIG_HASH" \\\s+"\$CANDIDATE_GATEWAY_IMAGE_ID" "\$CANDIDATE_GATEWAY_IMAGE_ID"/u,
  );
  const mainRollingFlow = deploymentSource.slice(
    deploymentSource.lastIndexOf('if [ "$GATEWAY_WAS_RUNNING" = "true" ]; then'),
  );
  const apiAUpdate = mainRollingFlow.indexOf('update_slot api_a');
  const apiBUpdate = mainRollingFlow.indexOf('update_slot api_b');
  const gatewayUpdate = mainRollingFlow.indexOf('apply_gateway_image');
  const webUpdate = mainRollingFlow.indexOf('replace_web');
  const bridgeFinalVerification = mainRollingFlow.indexOf(
    'verifying-pre-stateful-stateless-bridge',
  );
  const bridgeReceipt = mainRollingFlow.indexOf('prepare_and_publish_bridge_receipt');
  assert.ok(
    apiAUpdate >= 0 && apiAUpdate < apiBUpdate && apiBUpdate < gatewayUpdate
      && gatewayUpdate < webUpdate && webUpdate < bridgeFinalVerification
      && bridgeFinalVerification < bridgeReceipt,
    'explicit bridge receipt must be the last step after API, gateway, Web, and stateful reproof',
  );
  assert.match(
    mainRollingFlow.slice(bridgeFinalVerification, bridgeReceipt),
    /verify_bridge_stateful_contract[\s\S]*verify_all_rolling_candidate_scan_receipts/u,
  );
  assert.match(
    deploymentSource,
    /API_BRIDGE_PUBLISHED=true[\s\S]*API_CANDIDATE_TAG_CREATED=false[\s\S]*GATEWAY_CANDIDATE_TAG_CREATED=false[\s\S]*WEB_CANDIDATE_TAG_CREATED=false/u,
  );
  const receiptFunctionStart = deploymentSource.indexOf(
    'prepare_and_publish_bridge_receipt() {',
  );
  const receiptFunctionEnd = deploymentSource.indexOf(
    '\nrelease_active_journal() {',
    receiptFunctionStart,
  );
  assert.ok(receiptFunctionStart >= 0 && receiptFunctionEnd > receiptFunctionStart);
  const receiptFunction = deploymentSource.slice(receiptFunctionStart, receiptFunctionEnd);
  const preparationRevalidation = receiptFunction.indexOf('before-receipt-preparation');
  const receiptProducer = receiptFunction.indexOf('"$PYTHON_COMMAND" -I "$producer"');
  const publicationHook = receiptFunction.indexOf(
    'run_test_hook "before-bridge-receipt-publication"',
  );
  const publicationRevalidation = receiptFunction.indexOf(
    'before-receipt-publication',
    preparationRevalidation + 1,
  );
  const livePublicationEvidence = receiptFunction.indexOf(
    'verify_bridge_live_publication_evidence "$producer"',
  );
  const postProbeRevalidation = receiptFunction.indexOf(
    'verify_bridge_backup_post_probe_boundary',
    livePublicationEvidence,
  );
  const receiptPublisher = receiptFunction.indexOf(
    '"$PYTHON_COMMAND" -I "$publisher" publish',
  );
  assert.ok(
    preparationRevalidation >= 0 && preparationRevalidation < receiptProducer
      && receiptProducer < publicationHook && publicationHook < publicationRevalidation
      && publicationRevalidation < livePublicationEvidence
      && livePublicationEvidence < postProbeRevalidation
      && postProbeRevalidation < receiptPublisher,
    'backup and live publication evidence must be revalidated before canonical publication',
  );
  assert.match(
    receiptFunction,
    /prepare_bridge_backup_contract "\$BRIDGE_QDRANT_BACKUP_BINDING" \\\s+"\$BRIDGE_QDRANT_PUBLICATION_GENERATION" before-receipt-preparation \\\s+\|\| return 1/u,
  );
  assert.match(
    receiptFunction,
    /prepare_bridge_backup_contract "\$BRIDGE_QDRANT_BACKUP_BINDING" \\\s+"\$BRIDGE_QDRANT_PUBLICATION_GENERATION" before-receipt-publication \\\s+\|\| return 1/u,
  );
  assert.match(
    deploymentSource,
    /computed_binding="off-host-evidence-sha256-\$binding_sha"[\s\S]*\[ "\$computed_binding" = "\$expected_binding" \][\s\S]*\[ "\$computed_generation" = "\$expected_generation" \][\s\S]*BRIDGE_QDRANT_BACKUP_BINDING="\$computed_binding"/u,
  );
  assert.match(
    deploymentSource,
    /BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=14400/u,
  );
  assert.doesNotMatch(
    deploymentSource,
    /BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=\$\{DIVA_/u,
    'the four-hour bridge lifetime is a fixed production bound, not an environment override',
  );
  for (const phase of [
    'after-build', 'after-scan', 'before-first-live-mutation',
    'before-receipt-preparation', 'before-receipt-publication',
    'after-live-publication-probe',
  ]) {
    assert.match(deploymentSource, new RegExp(`verify_bridge_backup_lifetime "\\$phase"|${phase}`, 'u'));
  }
  assert.match(
    deploymentSource,
    /verify_bridge_attester_source\(\)[\s\S]*\[ "\$current_metadata" = 644:1 \][\s\S]*expected_owner=0:0[\s\S]*\[ "\$snapshot_metadata" = "\$expected_owner:644:1" \][\s\S]*\[ "\$snapshot_sha" = "\$current_sha" \]/u,
  );
  assert.match(
    deploymentSource,
    /\[ "\$\(stat -c '%a' "\$attestation_file"\)" = 600 \] \|\| return 1/u,
    'the external backup attestation remains an exact owner-only evidence file',
  );
}

async function testCandidateScanBatchTimestampContract() {
  const functionStart = deploymentSource.indexOf('prepare_candidate_image_scan_database() {');
  const functionEnd = deploymentSource.indexOf(
    '\nverify_all_rolling_candidate_scan_receipts() {',
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const scanFunctions = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');
  const preparation = deploymentSource.slice(
    functionStart,
    deploymentSource.indexOf('\nscan_exact_candidate_image() {', functionStart),
  );
  assert.ok(
    preparation.indexOf('IMAGE_SCAN_BATCH_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)')
      < preparation.indexOf('--download-db-only'),
    'the one batch timestamp must be captured before the Trivy DB download',
  );
  assert.match(
    scanFunctions,
    /started_at="\$IMAGE_SCAN_BATCH_STARTED_AT"[\s\S]*--scan-started-at "\$started_at"/u,
  );
  assert.doesNotMatch(
    scanFunctions.slice(
      scanFunctions.indexOf('scan_exact_candidate_image() {'),
      scanFunctions.indexOf('verify_exact_candidate_scan_receipt() {'),
    ),
    /started_at=\$\(date /u,
  );

  const root = await mkdtemp(join(scriptsDirectory, '.candidate-scan-batch-'));
  const scanRoot = join(root, 'scan');
  const fakeTrivyPath = join(root, 'trivy');
  const fakePythonPath = join(root, 'python3');
  const validatorPath = join(root, 'validator.py');
  const validatorLog = join(root, 'validator.log');
  const dateCounter = join(root, 'date-counter');
  const harnessPath = join(root, 'harness.sh');
  try {
    const fakeTrivySource = '#!/bin/sh\nexit 99\n';
    const scannerSha = createHash('sha256').update(fakeTrivySource).digest('hex');
    const fakePython = `#!/bin/sh
set -eu
[ "$1" = -I ]
shift 2
[ "$1" = validate ]
shift
service=
receipt=
started=
completed=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --service) service="$2"; shift 2 ;;
        --receipt) receipt="$2"; shift 2 ;;
        --scan-started-at) started="$2"; shift 2 ;;
        --scan-completed-at) completed="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "$service" ] && [ -n "$receipt" ] && [ -n "$started" ] && [ -n "$completed" ]
printf '{"service":"%s","status":"passed"}\n' "$service" > "$receipt"
printf '%s|%s|%s\n' "$service" "$started" "$completed" >> "${shellPath(validatorLog)}"
printf '%s\n' '{}'
`;
    await Promise.all([
      writeFile(fakeTrivyPath, fakeTrivySource, 'utf8'),
      writeFile(fakePythonPath, fakePython, 'utf8'),
      writeFile(validatorPath, '', 'utf8'),
    ]);
    await Promise.all([chmod(fakeTrivyPath, 0o755), chmod(fakePythonPath, 0o755)]);

    const harness = `#!/bin/sh
set -eu
IMAGE_SCAN_ROOT="${shellPath(scanRoot)}"
TRIVY_RUN_CACHE="$IMAGE_SCAN_ROOT/trivy-cache"
TRIVY_EMPTY_CONFIG="$IMAGE_SCAN_ROOT/trivy-empty.yaml"
TRIVY_EMPTY_IGNORE="$IMAGE_SCAN_ROOT/trivy-empty.ignore"
TRIVY_COMMAND="${shellPath(fakeTrivyPath)}"
TRIVY_BINARY_SHA256=${scannerSha}
TRIVY_VERSION=0.74.0
TRIVY_SCANNER_SHA=
IMAGE_SCAN_BATCH_STARTED_AT=
API_SCAN_RECEIPT_SHA=
GATEWAY_SCAN_RECEIPT_SHA=
WEB_SCAN_RECEIPT_SHA=
TEST_MODE=0
BUILD_TIMEOUT_SECONDS=7200
SYNC_COMMAND=true
PYTHON_COMMAND="${shellPath(fakePythonPath)}"
IMAGE_SCAN_VALIDATOR_RELEASE="${shellPath(validatorPath)}"
API_CANDIDATE_IMAGE=api-reference
GATEWAY_CANDIDATE_IMAGE=gateway-reference
WEB_CANDIDATE_IMAGE=web-reference
NEW_API_IMAGE=sha256:${'1'.repeat(64)}
NEW_GATEWAY_IMAGE=sha256:${'2'.repeat(64)}
NEW_WEB_IMAGE=sha256:${'3'.repeat(64)}
DATE_COUNTER="${shellPath(dateCounter)}"
date() {
    count=0
    [ ! -f "$DATE_COUNTER" ] || count=$(cat "$DATE_COUNTER")
    count=$((count + 1))
    printf '%s\n' "$count" > "$DATE_COUNTER"
    case "$count" in
        1) printf '%s\n' 2026-09-01T00:00:00Z ;;
        2) printf '%s\n' 2026-09-01T00:01:00Z ;;
        3) printf '%s\n' 2026-09-01T00:10:00Z ;;
        4) printf '%s\n' 2026-09-01T00:20:00Z ;;
        *) exit 81 ;;
    esac
}
run_with_timeout() {
    shift
    case " $* " in
        *' --download-db-only '*)
            mkdir -p "$TRIVY_RUN_CACHE/db"
            printf '%s\n' '{}' > "$TRIVY_RUN_CACHE/db/metadata.json"
            printf '%s\n' database > "$TRIVY_RUN_CACHE/db/trivy.db"
            ;;
        *)
            output=
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --output) output="$2"; shift 2 ;;
                    *) shift ;;
                esac
            done
            [ -n "$output" ]
            printf '%s\n' '{}' > "$output"
            ;;
    esac
}
record_state() { :; }
image_ref_id() {
    case "$1" in
        api-reference) printf '%s\n' "$NEW_API_IMAGE" ;;
        gateway-reference) printf '%s\n' "$NEW_GATEWAY_IMAGE" ;;
        web-reference) printf '%s\n' "$NEW_WEB_IMAGE" ;;
        *) return 1 ;;
    esac
}
verify_image_linux_arm64() { :; }
${scanFunctions}
scan_all_rolling_candidate_images
[ "$(cat "$DATE_COUNTER")" = 4 ]
`;
    await writeFile(harnessPath, harness, 'utf8');
    await chmod(harnessPath, 0o755);
    const result = spawnSync('sh', [shellPath(harnessPath)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
    const lines = (await readFile(validatorLog, 'utf8')).trim().split('\n');
    assert.deepEqual(lines, [
      'api|2026-09-01T00:00:00Z|2026-09-01T00:01:00Z',
      'gateway|2026-09-01T00:00:00Z|2026-09-01T00:10:00Z',
      'web|2026-09-01T00:00:00Z|2026-09-01T00:20:00Z',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBridgeBackupLifetimeContract() {
  const functionStart = deploymentSource.indexOf('read_bridge_backup_clock() {');
  const functionEnd = deploymentSource.indexOf('\nprepare_bridge_backup_contract() {', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const lifetimeFunctions = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');
  const backupFunction = deploymentSource.slice(
    functionEnd,
    deploymentSource.indexOf('\ncompose_service_container_ids() {', functionEnd),
  );
  assert.match(
    backupFunction,
    /if phase == "initial":\s+require\(-300 <= attestation_age <= 900,/u,
    'only the initial backup attestation check retains the short freshness window',
  );
  assert.match(
    backupFunction,
    /if phase == "initial":\s+require\(all\(-900 <= age <= max_age_hours \* 3600 for age in ages\),/u,
    'backup status/manifest UTC freshness is also initial-admission-only',
  );
  assert.match(
    backupFunction,
    /evidence_selection_sha[\s\S]*phase-evidence-selection-changed/u,
  );
  assert.match(
    backupFunction,
    /publication_sha" = "\$BRIDGE_QDRANT_PUBLICATION_SHA256/u,
  );
  assert.match(
    lifetimeFunctions,
    /\/proc\/sys\/kernel\/random\/boot_id[\s\S]*CLOCK_BOOTTIME/u,
  );

  const root = await mkdtemp(join(scriptsDirectory, '.bridge-backup-lifetime-'));
  const harnessPath = join(root, 'harness.sh');
  try {
    const harness = `#!/bin/sh
set -eu
BRIDGE_BACKUP_ANCHOR_UTC_EPOCH=
BRIDGE_BACKUP_ANCHOR_BOOT_ID=
BRIDGE_BACKUP_ANCHOR_BOOTTIME_NS=
BRIDGE_BACKUP_LAST_UTC_EPOCH=
BRIDGE_BACKUP_LAST_BOOTTIME_NS=
BRIDGE_BACKUP_LIFETIME_FAILED=false
BRIDGE_BACKUP_MAX_ELAPSED_SECONDS=14400
record_state() { :; }
run_with_timeout() { return 99; }
PYTHON_COMMAND=python3
DOCKER_READ_TIMEOUT_SECONDS=10
${lifetimeFunctions}
read_bridge_backup_clock() {
    printf '%s\n%s\n%s\n' "$CLOCK_UTC" "$CLOCK_BOOT" "$CLOCK_BOOTTIME"
}
reset_anchor() {
    BRIDGE_BACKUP_ANCHOR_UTC_EPOCH=
    BRIDGE_BACKUP_ANCHOR_BOOT_ID=
    BRIDGE_BACKUP_ANCHOR_BOOTTIME_NS=
    BRIDGE_BACKUP_LAST_UTC_EPOCH=
    BRIDGE_BACKUP_LAST_BOOTTIME_NS=
    BRIDGE_BACKUP_LIFETIME_FAILED=false
    CLOCK_UTC=2000000000
    CLOCK_BOOT=11111111-2222-3333-4444-555555555555
    CLOCK_BOOTTIME=5000000000000
    initialize_bridge_backup_lifetime
}
expect_elapsed_success() {
    seconds="$1"
    phase="$2"
    reset_anchor
    CLOCK_UTC=$((2000000000 + seconds))
    CLOCK_BOOTTIME=$((5000000000000 + seconds * 1000000000))
    verify_bridge_backup_lifetime "$phase"
    [ "$BRIDGE_BACKUP_LIFETIME_FAILED" = false ]
}
expect_elapsed_failure() {
    seconds="$1"
    phase="$2"
    reset_anchor
    CLOCK_UTC=$((2000000000 + seconds))
    CLOCK_BOOTTIME=$((5000000000000 + seconds * 1000000000))
    if verify_bridge_backup_lifetime "$phase"; then exit 71; fi
    [ "$BRIDGE_BACKUP_LIFETIME_FAILED" = true ]
    CLOCK_UTC=2000000001
    CLOCK_BOOTTIME=5001000000000
    if verify_bridge_backup_lifetime "$phase"; then exit 72; fi
}
[ "$BRIDGE_BACKUP_MAX_ELAPSED_SECONDS" = 14400 ]
  expect_elapsed_success 901 after-build
  expect_elapsed_success 14399 after-scan
  expect_elapsed_failure 14400 before-receipt-preparation
  expect_elapsed_failure 14401 after-live-publication-probe
reset_anchor
CLOCK_UTC=1999999999
CLOCK_BOOTTIME=5001000000000
verify_bridge_backup_lifetime before-receipt-publication
[ "$BRIDGE_BACKUP_LIFETIME_FAILED" = false ]
reset_anchor
CLOCK_UTC=2000000001
CLOCK_BOOT=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
CLOCK_BOOTTIME=5001000000000
if verify_bridge_backup_lifetime before-receipt-publication; then exit 74; fi
[ "$BRIDGE_BACKUP_LIFETIME_FAILED" = true ]
reset_anchor
CLOCK_UTC=2000000001
CLOCK_BOOTTIME=4999999999999
if verify_bridge_backup_lifetime before-receipt-publication; then exit 75; fi
[ "$BRIDGE_BACKUP_LIFETIME_FAILED" = true ]
`;
    await writeFile(harnessPath, harness, 'utf8');
    await chmod(harnessPath, 0o755);
    const result = spawnSync('sh', [shellPath(harnessPath)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        DIVA_BRIDGE_BACKUP_MAX_ELAPSED_SECONDS: '999999999',
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBridgeLivePublicationEvidenceContract() {
  const functionStart = deploymentSource.indexOf('verify_bridge_live_publication_evidence() {');
  const functionEnd = deploymentSource.indexOf('\nprepare_and_publish_bridge_receipt() {', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const evidenceFunction = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');
  assert.match(
    evidenceFunction,
    /verify-live-publication[\s\S]*--gateway-id "\$NEW_GATEWAY_CONTAINER_ID"[\s\S]*--api-a-id "\$NEW_API_A_CONTAINER_ID" --api-b-id "\$NEW_API_B_CONTAINER_ID"/u,
  );
  assert.match(
    evidenceFunction,
    /document\.get\("projectionSha256"\) != expected_projection_sha/u,
  );
  assert.match(
    evidenceFunction,
    /slots\.get\("api_a"\) != read_matrix_sha[\s\S]*slots\.get\("api_b"\) != read_matrix_sha/u,
  );

  const generation = 'legacy';
  const projection = deepSort({
    aliases: {
      song_hybrid_active: 'song_hybrid',
      song_metadata_active: 'song_metadata',
      songs_v2_active: 'songs_v2',
    },
    collections: ['song_audio', 'song_hybrid', 'song_metadata', 'songs_v2'],
    generation,
  });
  const projectionSha = createHash('sha256')
    .update(JSON.stringify(projection))
    .digest('hex');
  const matrixSha = 'e'.repeat(64);
  const validDocument = deepSort({
    kind: 'diva.sbc-api-bridge-live-publication.v1',
    projection,
    projectionSha256: projectionSha,
    readMatrixSha256: matrixSha,
    schemaVersion: 1,
    slots: { api_a: matrixSha, api_b: matrixSha },
  });
  const invalidDocument = { ...validDocument, projectionSha256: '0'.repeat(64) };

  for (const [mode, document, expectedSuccess] of [
    ['valid', validDocument, true],
    ['projection-drift', invalidDocument, false],
  ]) {
    const root = await mkdtemp(join(scriptsDirectory, `.bridge-live-publication-${mode}-`));
    const deploymentDirectory = join(root, 'deployment');
    const evidencePath = join(deploymentDirectory, 'bridge-live-publication.json');
    const producerPath = join(root, 'producer.py');
    const pythonWrapperPath = join(root, 'python3');
    const stateLog = join(root, 'state.log');
    const harnessPath = join(root, 'harness.sh');
    try {
      await mkdir(deploymentDirectory);
      await writeFile(producerPath, '', 'utf8');
      const pythonWrapper = `#!/bin/sh
set -eu
if [ "$#" -ge 2 ] && [ "$1" = -I ] && [ "$2" = - ]; then
    exec "${nativeExactPythonShellCommand}" "$@"
fi
[ "$1" = -I ]
shift
[ "$1" = "${shellPath(producerPath)}" ]
shift
[ "$1" = verify-live-publication ]
printf '%s\n' '${JSON.stringify(document)}'
`;
      await writeFile(pythonWrapperPath, pythonWrapper, 'utf8');
      await chmod(pythonWrapperPath, 0o755);
      const harness = `#!/bin/sh
set -eu
DEPLOYMENT_DIR="${shellPath(deploymentDirectory)}"
BRIDGE_LIVE_PUBLICATION_EVIDENCE="${shellPath(evidencePath)}"
PYTHON_COMMAND="${shellPath(pythonWrapperPath)}"
DOCKER_COMMAND=docker
NEW_GATEWAY_CONTAINER_ID=${'1'.repeat(64)}
NEW_API_A_CONTAINER_ID=${'2'.repeat(64)}
NEW_API_B_CONTAINER_ID=${'3'.repeat(64)}
BRIDGE_QDRANT_PUBLICATION_GENERATION=${generation}
BRIDGE_QDRANT_PUBLICATION_SHA256=${projectionSha}
TEST_MODE=1
SYNC_COMMAND=true
DOCKER_READ_TIMEOUT_SECONDS=30
run_with_timeout() { shift; "$@"; }
record_state() { printf '%s=%s\n' "$1" "$2" >> "${shellPath(stateLog)}"; }
stat() {
    if [ "$1" = -c ] && [ "$2" = '%u:%g:%a:%h' ] \
        && [ "$3" = "$BRIDGE_LIVE_PUBLICATION_EVIDENCE" ]; then
        owner=$(/usr/bin/stat -c '%u:%g' "$3")
        printf '%s:600:1\n' "$owner"
        return 0
    fi
    /usr/bin/stat "$@"
}
${evidenceFunction}
case "${mode}" in
    valid)
        verify_bridge_live_publication_evidence "${shellPath(producerPath)}"
        grep -Eq '^bridge\.live_publication_evidence_sha256=[0-9a-f]{64}$' \
            "${shellPath(stateLog)}"
        ;;
    projection-drift)
        if verify_bridge_live_publication_evidence "${shellPath(producerPath)}"; then
            exit 91
        fi
        [ -s "$BRIDGE_LIVE_PUBLICATION_EVIDENCE" ]
        [ ! -e "${shellPath(join(root, 'canonical-receipt.json'))}" ]
        ;;
esac
`;
      await writeFile(harnessPath, harness, 'utf8');
      await chmod(harnessPath, 0o755);
      const result = spawnSync('sh', [shellPath(harnessPath)], {
        cwd: projectDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, JSON.stringify({
        mode,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
      const artifact = await readFile(evidencePath, 'utf8');
      assert.equal(artifact, `${JSON.stringify(document)}\n`);
      assert.equal(expectedSuccess, mode === 'valid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function testBridgeAttesterSourceModeContract() {
  const functionStart = deploymentSource.indexOf('verify_bridge_attester_source() {');
  const functionEnd = deploymentSource.indexOf('\nprepare_bridge_backup_contract() {', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const verificationFunction = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');
  const root = await mkdtemp(join(scriptsDirectory, '.bridge-attester-source-'));
  const currentRoot = join(root, 'current');
  const currentScripts = join(currentRoot, 'scripts');
  const snapshotScripts = join(root, 'snapshot', 'scripts');
  const currentAttester = join(currentScripts, 'attest-disaster-backup-payloads.py');
  const snapshotAttester = join(snapshotScripts, 'attest-disaster-backup-payloads.py');
  const harnessPath = join(root, 'harness.sh');
  const payload = 'print("reviewed attester fixture")\n';
  try {
    await Promise.all([
      mkdir(currentScripts, { recursive: true }),
      mkdir(snapshotScripts, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(currentAttester, payload, 'utf8'),
      writeFile(snapshotAttester, payload, 'utf8'),
    ]);
    await Promise.all([chmod(currentAttester, 0o644), chmod(snapshotAttester, 0o644)]);
    const expectedSha = createHash('sha256').update(payload).digest('hex');
    const harness = `#!/bin/sh
set -eu
ORIGINAL_ROOT_DIR="${shellPath(currentRoot)}"
SNAPSHOT_FILE="${shellPath(snapshotAttester)}"
TEST_MODE=1
SIMULATED_MODE="${'${1:-real}'}"
CURRENT_FILE="$ORIGINAL_ROOT_DIR/scripts/attest-disaster-backup-payloads.py"
stat() {
    if [ "$SIMULATED_MODE" = current-664 ] \
        && [ "$1" = -c ] && [ "$2" = '%a:%h' ] \
        && [ "$3" = "$CURRENT_FILE" ]; then
        printf '%s\n' '664:1'
        return 0
    fi
    if [ "$SIMULATED_MODE" != real ] && [ "$SIMULATED_MODE" != current-664 ] \
        && [ "$1" = -c ] && [ "$2" = '%u:%g:%a:%h' ] \
        && [ "$3" = "$SNAPSHOT_FILE" ]; then
        owner=$(/usr/bin/stat -c '%u:%g' "$3")
        printf '%s:%s:1\n' "$owner" "$SIMULATED_MODE"
        return 0
    fi
    /usr/bin/stat "$@"
}
${verificationFunction}
case "$SIMULATED_MODE" in
    real)
        [ "$(verify_bridge_attester_source "$SNAPSHOT_FILE")" = "${expectedSha}" ]
        ;;
    646|664|current-664)
        if verify_bridge_attester_source "$SNAPSHOT_FILE" >/dev/null; then
            exit 91
        fi
        ;;
    *) exit 92 ;;
esac
`;
    await writeFile(harnessPath, harness, 'utf8');
    await chmod(harnessPath, 0o755);
    for (const mode of ['real', '646', '664', 'current-664']) {
      const result = spawnSync('sh', [shellPath(harnessPath), mode], {
        cwd: projectDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, JSON.stringify({
        mode,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBridgePublicationWriterBarrierContract() {
  const barrierStart = deploymentSource.indexOf('observe_bridge_publication_writer_barrier() {');
  const barrierEnd = deploymentSource.indexOf('\nprepare_and_publish_bridge_receipt() {', barrierStart);
  assert.ok(barrierStart >= 0 && barrierEnd > barrierStart);
  const barrierFunctions = deploymentSource.slice(barrierStart, barrierEnd)
    .replaceAll('\r\n', '\n');
  assert.match(
    barrierFunctions,
    /pg_try_advisory_lock\(hashtext\('diva-data-pipeline-publication-v1'\)\)[\s\S]*pg_try_advisory_lock\(hashtext\('diva-data-pipeline-child-v1'\)\)[\s\S]*pg_try_advisory_lock\(hashtextextended\('diva-recommendation-publication-v1', 0\)\)/u,
    'the persistent psql session acquires all three writer locks',
  );
  assert.match(
    barrierFunctions,
    /INSERT INTO sync_state\(key, value, updated_at\)[\s\S]*'diva_stateful_maintenance_gate', :'token'[\s\S]*pg_stat_activity/u,
    'writer idleness and the exact maintenance token are established together',
  );
  const pipelineActivityChecks = [
    ...barrierFunctions.matchAll(/FROM pg_stat_activity AS activity/g),
  ].length;
  assert.equal(pipelineActivityChecks, 3, 'all three pipeline-session checks remain present');
  assert.equal(
    [...barrierFunctions.matchAll(/activity\.backend_type = 'client backend'/g)].length,
    pipelineActivityChecks,
    'every pipeline-session check excludes PostgreSQL auxiliary processes',
  );
  assert.equal(
    [...barrierFunctions.matchAll(
      /JOIN pg_roles AS parent_role ON parent_role\.oid = membership\.roleid/g,
    )].length,
    pipelineActivityChecks,
    'pipeline sessions are identified by exact direct runtime-role membership',
  );
  assert.doesNotMatch(
    barrierFunctions,
    /pg_has_role\(role\.oid, 'diva_pipeline_runtime', 'MEMBER'\)/u,
    'superuser monitoring sessions must not impersonate pipeline writers',
  );
  assert.doesNotMatch(
    barrierFunctions,
    /\\quit\s+[0-9]+/u,
    'psql meta-command quit does not accept a numeric exit status',
  );
  assert.match(
    barrierFunctions,
    /preserve_bridge_publication_writer_gate\(\)[\s\S]*\[ "\$barrier_exit" = 0 \][\s\S]*"ready\|\$BRIDGE_PUBLICATION_WRITER_BARRIER_TOKEN"/u,
    'preserving the gate accepts only normal psql exit plus the exact ready evidence',
  );
  assert.match(
    barrierFunctions,
    /\) < "\$BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO"[\s\S]*&[\s\S]*exec 9> "\$BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO"/u,
    'the lock-owning psql connection remains alive behind a private FIFO',
  );
  assert.match(
    barrierFunctions,
    /DELETE FROM sync_state\s+WHERE key = 'diva_stateful_maintenance_gate' AND value = :'token'/u,
    'release can delete only this deployment exact token',
  );
  assert.match(
    barrierFunctions,
    /actual_result[\s\S]*pl=[\s\S]*WHERE key = 'diva_stateful_maintenance_gate' AND value = :'token'[\s\S]*"not-owned\|0"/u,
    'a reasoned clean refusal is reaped only after proving no owned token/session remains',
  );
  assert.match(
    barrierFunctions,
    /'refused\|pl=' \|\| \(:'pipeline'::boolean\)::text[\s\S]*'\|cl=' \|\| \(:'child'::boolean\)::text[\s\S]*'\|rl=' \|\| \(:'publication'::boolean\)::text/u,
    'psql t/f variables are normalized to strict true/false refusal evidence',
  );
  assert.match(
    barrierFunctions,
    /acquire_bridge_publication_writer_barrier_with_retry\(\)[\s\S]*ROUTE_ATTEMPTS[\s\S]*acquire_status" -eq 2[\s\S]*REFUSAL_RETRYABLE" = true/u,
    'only exact clean transient refusals receive a bounded retry',
  );
  assert.match(
    barrierFunctions,
    /verify_bridge_publication_writer_barrier[\s\S]*verify_bridge_backup_lifetime "\$phase"/u,
    'the post-probe boundary re-proves both the held writer barrier and monotonic lifetime',
  );

  const receiptStart = deploymentSource.indexOf('prepare_and_publish_bridge_receipt() {');
  const receiptEnd = deploymentSource.indexOf('\nrelease_active_journal() {', receiptStart);
  const receiptFunction = deploymentSource.slice(receiptStart, receiptEnd)
    .replaceAll('\r\n', '\n');
  const finalFullRehash = receiptFunction.indexOf('before-receipt-publication');
  const acquire = receiptFunction.indexOf('acquire_bridge_publication_writer_barrier_with_retry');
  const liveProbe = receiptFunction.indexOf('verify_bridge_live_publication_evidence');
  const postProbe = receiptFunction.indexOf('verify_bridge_backup_post_probe_boundary');
  const publisher = receiptFunction.indexOf('"$publisher" publish');
  const release = receiptFunction.lastIndexOf('release_bridge_publication_writer_barrier');
  assert.ok(
    finalFullRehash >= 0 && finalFullRehash < acquire && acquire < liveProbe
      && liveProbe < postProbe && postProbe < publisher && publisher < release,
    'full evidence rehash, held-lock probe, lifetime boundary, atomic publish, and release are ordered',
  );
  const heldBoundary = receiptFunction.slice(acquire, liveProbe);
  assert.match(
    heldBoundary,
    /verify_bridge_publication_writer_barrier[\s\S]*verify_bridge_stateful_contract[\s\S]*verify_exact_rolling_topology[\s\S]*verify_published_web[\s\S]*verify_all_rolling_candidate_scan_receipts[\s\S]*verify_private_source_snapshot[\s\S]*API_BRIDGE_PREPARED_SHA[\s\S]*verify_bridge_publication_writer_barrier/u,
    'mutable receipt inputs are re-proved while the acquired barrier is held',
  );
  assert.doesNotMatch(
    receiptFunction,
    /prepare_bridge_backup_contract[^\n]*[\s\S]{0,200}after-live-publication-probe/u,
  );
  const cleanupStart = deploymentSource.indexOf('cleanup() {');
  const cleanupEnd = deploymentSource.indexOf('\nhandle_signal() {', cleanupStart);
  const cleanupFunction = deploymentSource.slice(cleanupStart, cleanupEnd)
    .replaceAll('\r\n', '\n');
  assert.match(
    cleanupFunction,
    /BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = "true" \] \\\n+        && \[ "\$DEPLOYMENT_SUCCEEDED" = "true"/u,
    'only a durable/ambiguous canonical commit may release the barrier before rollback',
  );
  const rollbackSlots = cleanupFunction.indexOf('rollback_updated_slots');
  const rollbackWeb = cleanupFunction.indexOf('rollback_web');
  const restoreImages = cleanupFunction.indexOf('restore_canonical_image_state');
  const failureRelease = cleanupFunction.lastIndexOf('release_bridge_publication_writer_barrier');
  assert.ok(
    rollbackSlots >= 0 && rollbackSlots < rollbackWeb && rollbackWeb < restoreImages
      && restoreImages < failureRelease,
    'an unpublished failure retains the writer barrier through exact stateless rollback',
  );

  const refusalStart = barrierFunctions.indexOf(
    'settle_bridge_publication_writer_barrier_refusal() {',
  );
  const refusalEnd = barrierFunctions.indexOf(
    '\nacquire_bridge_publication_writer_barrier() {',
    refusalStart,
  );
  assert.ok(refusalStart >= 0 && refusalEnd > refusalStart);
  const refusalFunction = barrierFunctions.slice(refusalStart, refusalEnd);
  const refusalRoot = await mkdtemp(join(scriptsDirectory, '.bridge-writer-refusal-'));
  const refusalHarness = join(refusalRoot, 'harness.sh');
  try {
    const fifo = join(refusalRoot, 'barrier.fifo');
    const resultPath = join(refusalRoot, 'barrier.result');
    const errorPath = join(refusalRoot, 'barrier.error');
    const exitPath = join(refusalRoot, 'barrier.exit');
    const statePath = join(refusalRoot, 'state.log');
    const harness = `#!/bin/sh
set -eu
BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE=true
BRIDGE_PUBLICATION_WRITER_BARRIER_UNRESOLVED=true
BRIDGE_PUBLICATION_WRITER_BARRIER_FD_OPEN=true
BRIDGE_PUBLICATION_WRITER_BARRIER_TOKEN=diva-bridge-test
BRIDGE_PUBLICATION_WRITER_BARRIER_APPLICATION=diva_bridge_test
BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO="${shellPath(fifo)}"
BRIDGE_PUBLICATION_WRITER_BARRIER_RESULT="${shellPath(resultPath)}"
BRIDGE_PUBLICATION_WRITER_BARRIER_ERROR="${shellPath(errorPath)}"
BRIDGE_PUBLICATION_WRITER_BARRIER_EXIT="${shellPath(exitPath)}"
PRIVATE_RUNTIME_ROOT="${shellPath(refusalRoot)}"
DEPLOYMENT_DIR="${shellPath(refusalRoot)}"
BRIDGE_POSTGRES_ID=${'1'.repeat(64)}
DOCKER_READ_TIMEOUT_SECONDS=30
DOCKER_COMMAND=docker
SYNC_COMMAND=true
printf '%s\n' fifo > "$BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO"
printf '%s\n' 'refused|pl=true|cl=true|rl=false|pm=0|rm=0|mg=0|lr=0|rc=0' \
    > "$BRIDGE_PUBLICATION_WRITER_BARRIER_RESULT"
: > "$BRIDGE_PUBLICATION_WRITER_BARRIER_ERROR"
printf '%s\n' 0 > "$BRIDGE_PUBLICATION_WRITER_BARRIER_EXIT"
(exit 0) &
BRIDGE_PUBLICATION_WRITER_BARRIER_PID=$!
exec 9>/dev/null
run_with_timeout() { printf '%s\n' 'not-owned|0'; }
record_state() { printf '%s=%s\n' "$1" "$2" >> "${shellPath(statePath)}"; }
${refusalFunction}
settle_bridge_publication_writer_barrier_refusal
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = false ]
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_UNRESOLVED" = false ]
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_FD_OPEN" = false ]
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_RETRYABLE" = true ]
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_REASON" = \
    'refused|pl=true|cl=true|rl=false|pm=0|rm=0|mg=0|lr=0|rc=0' ]
[ -z "$BRIDGE_PUBLICATION_WRITER_BARRIER_PID" ]
[ ! -e "$BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO" ]
[ ! -e "$BRIDGE_PUBLICATION_WRITER_BARRIER_RESULT" ]
[ ! -e "$BRIDGE_PUBLICATION_WRITER_BARRIER_ERROR" ]
[ ! -e "$BRIDGE_PUBLICATION_WRITER_BARRIER_EXIT" ]
grep -Fx 'bridge.publication_writer_barrier=refused-busy:diva-bridge-test:refused|pl=true|cl=true|rl=false|pm=0|rm=0|mg=0|lr=0|rc=0' \
    "${shellPath(statePath)}" >/dev/null
BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE=true
BRIDGE_PUBLICATION_WRITER_BARRIER_UNRESOLVED=true
BRIDGE_PUBLICATION_WRITER_BARRIER_FD_OPEN=true
printf '%s\n' fifo > "$BRIDGE_PUBLICATION_WRITER_BARRIER_FIFO"
printf '%s\n' 'refused|pl=true|cl=true|rl=true|pm=0|rm=0|mg=1|lr=0|rc=0' \
    > "$BRIDGE_PUBLICATION_WRITER_BARRIER_RESULT"
: > "$BRIDGE_PUBLICATION_WRITER_BARRIER_ERROR"
printf '%s\n' 0 > "$BRIDGE_PUBLICATION_WRITER_BARRIER_EXIT"
(exit 0) &
BRIDGE_PUBLICATION_WRITER_BARRIER_PID=$!
exec 9>/dev/null
settle_bridge_publication_writer_barrier_refusal
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_RETRYABLE" = false ]
[ "$BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_REASON" = \
    'refused|pl=true|cl=true|rl=true|pm=0|rm=0|mg=1|lr=0|rc=0' ]
`;
    await writeFile(refusalHarness, harness, 'utf8');
    await chmod(refusalHarness, 0o755);
    const result = spawnSync('sh', [shellPath(refusalHarness)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
  } finally {
    await rm(refusalRoot, { recursive: true, force: true });
  }

  const retryStart = barrierFunctions.indexOf(
    'acquire_bridge_publication_writer_barrier_with_retry() {',
  );
  const retryEnd = barrierFunctions.indexOf(
    '\nverify_bridge_publication_writer_barrier() {',
    retryStart,
  );
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retryFunction = barrierFunctions.slice(retryStart, retryEnd);
  const retryRoot = await mkdtemp(join(scriptsDirectory, '.bridge-writer-retry-'));
  const retryHarness = join(retryRoot, 'harness.sh');
  try {
    const countPath = join(retryRoot, 'count');
    const waitPath = join(retryRoot, 'wait');
    const statePath = join(retryRoot, 'state');
    const harness = `#!/bin/sh
set -eu
ROUTE_ATTEMPTS=3
BRIDGE_PUBLICATION_WRITER_BARRIER_UNRESOLVED=false
BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_RETRYABLE=false
BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_REASON=
SCENARIO=eventual
acquire_bridge_publication_writer_barrier() {
    count=0
    [ ! -f "${shellPath(countPath)}" ] || count=$(cat "${shellPath(countPath)}")
    count=$((count + 1))
    printf '%s\n' "$count" > "${shellPath(countPath)}"
    if [ "$SCENARIO" = fatal ]; then return 1; fi
    if [ "$SCENARIO" = exhausted ] || [ "$count" -eq 1 ]; then
        BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_RETRYABLE=true
        BRIDGE_PUBLICATION_WRITER_BARRIER_REFUSAL_REASON=transient
        return 2
    fi
    return 0
}
record_state() { printf '%s=%s\n' "$1" "$2" >> "${shellPath(statePath)}"; }
wait_once() { printf '%s\n' wait >> "${shellPath(waitPath)}"; }
${retryFunction}
acquire_bridge_publication_writer_barrier_with_retry
[ "$(cat "${shellPath(countPath)}")" = 2 ]
[ "$(wc -l < "${shellPath(waitPath)}")" = 1 ]
grep -Fx 'bridge.publication_writer_barrier_retry=waiting:1:transient' \
    "${shellPath(statePath)}" >/dev/null
grep -Fx 'bridge.publication_writer_barrier_retry=acquired:2' \
    "${shellPath(statePath)}" >/dev/null
rm -f "${shellPath(countPath)}" "${shellPath(waitPath)}" "${shellPath(statePath)}"
SCENARIO=exhausted
if acquire_bridge_publication_writer_barrier_with_retry; then exit 71; fi
[ "$(cat "${shellPath(countPath)}")" = 3 ]
[ "$(wc -l < "${shellPath(waitPath)}")" = 2 ]
grep -Fx 'bridge.publication_writer_barrier_retry=exhausted:3:transient' \
    "${shellPath(statePath)}" >/dev/null
rm -f "${shellPath(countPath)}" "${shellPath(waitPath)}" "${shellPath(statePath)}"
SCENARIO=fatal
if acquire_bridge_publication_writer_barrier_with_retry; then exit 72; fi
[ "$(cat "${shellPath(countPath)}")" = 1 ]
[ ! -e "${shellPath(waitPath)}" ]
`;
    await writeFile(retryHarness, harness, 'utf8');
    await chmod(retryHarness, 0o755);
    const result = spawnSync('sh', [shellPath(retryHarness)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
  } finally {
    await rm(retryRoot, { recursive: true, force: true });
  }

  const root = await mkdtemp(join(scriptsDirectory, '.bridge-post-probe-binding-'));
  const harnessPath = join(root, 'harness.sh');
  try {
    const evidenceNames = [
      'postgres-status.json', 'postgres-manifest.json', 'qdrant-status.json',
      'qdrant-manifest.json', 'attestation.json',
    ];
    const evidence = {};
    for (const [index, name] of evidenceNames.entries()) {
      const path = join(root, name);
      const payload = `evidence-${index}\n`;
      await writeFile(path, payload, 'utf8');
      evidence[name] = {
        path: shellPath(path),
        sha: createHash('sha256').update(payload).digest('hex'),
      };
    }
    const postBoundaryStart = barrierFunctions.indexOf('verify_bridge_backup_post_probe_boundary() {');
    assert.ok(postBoundaryStart >= 0);
    const postBoundaryFunction = barrierFunctions.slice(postBoundaryStart);
    const harness = `#!/bin/sh
set -eu
BRIDGE_BACKUP_CONTRACT_FAILED=false
BRIDGE_BACKUP_LIFETIME_FAILED=false
BRIDGE_QDRANT_BACKUP_BINDING=off-host-evidence-sha256-${'a'.repeat(64)}
BRIDGE_QDRANT_PUBLICATION_GENERATION=legacy
BRIDGE_QDRANT_PUBLICATION_SHA256=${'b'.repeat(64)}
DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID=${'1'.repeat(32)}
DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE="${evidence['postgres-status.json'].path}"
DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256=${evidence['postgres-status.json'].sha}
DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE="${evidence['postgres-manifest.json'].path}"
DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256=${evidence['postgres-manifest.json'].sha}
DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID=${'2'.repeat(32)}
DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE="${evidence['qdrant-status.json'].path}"
DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256=${evidence['qdrant-status.json'].sha}
DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE="${evidence['qdrant-manifest.json'].path}"
DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256=${evidence['qdrant-manifest.json'].sha}
DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE="${evidence['attestation.json'].path}"
DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256=${evidence['attestation.json'].sha}
DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE=${'3'.repeat(64)}
DIVA_EXPECTED_BACKUP_VERIFIER_HOST=verifier
DIVA_EXPECTED_BACKUP_SOURCE_HOST=source
record_state() { :; }
verify_bridge_publication_writer_barrier() { :; }
verify_bridge_backup_lifetime() { [ "$1" = after-live-publication-probe ]; }
mark_bridge_backup_contract_failed() { BRIDGE_BACKUP_CONTRACT_FAILED=true; }
${postBoundaryFunction}
BRIDGE_BACKUP_EVIDENCE_SELECTION_SHA256=$(printf '%s\n' \
    "postgres_run=$DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID" \
    "postgres_status=$DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_FILE" \
    "postgres_status_sha256=$DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256" \
    "postgres_manifest=$DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_FILE" \
    "postgres_manifest_sha256=$DIVA_VERIFIED_POSTGRES_BACKUP_MANIFEST_SHA256" \
    "qdrant_run=$DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID" \
    "qdrant_status=$DIVA_VERIFIED_QDRANT_BACKUP_STATUS_FILE" \
    "qdrant_status_sha256=$DIVA_VERIFIED_QDRANT_BACKUP_STATUS_SHA256" \
    "qdrant_manifest=$DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_FILE" \
    "qdrant_manifest_sha256=$DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256" \
    "attestation=$DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_FILE" \
    "attestation_sha256=$DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256" \
    "challenge=$DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_CHALLENGE" \
    "verifier_host=$DIVA_EXPECTED_BACKUP_VERIFIER_HOST" \
    "source_host=$DIVA_EXPECTED_BACKUP_SOURCE_HOST" | sha256sum | awk '{print $1}')
verify_bridge_backup_post_probe_boundary
original_sha=$DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256
DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256=${'0'.repeat(64)}
if verify_bridge_backup_post_probe_boundary; then exit 81; fi
[ "$BRIDGE_BACKUP_CONTRACT_FAILED" = true ]
DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256=$original_sha
if verify_bridge_backup_post_probe_boundary; then exit 82; fi
`;
    await writeFile(harnessPath, harness, 'utf8');
    await chmod(harnessPath, 0o755);
    const result = spawnSync('sh', [shellPath(harnessPath)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBridgeRollbackTagsRetainedAfterMutation() {
  const functionStart = deploymentSource.indexOf('cleanup_unpublished_bridge_rollback_tags() {');
  const functionEnd = deploymentSource.indexOf('\ncleanup() {', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const cleanupFunction = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');
  const root = await mkdtemp(join(scriptsDirectory, '.bridge-rollback-tag-retention-'));
  const harnessPath = join(root, 'harness.sh');
  const removeLog = join(root, 'remove.log');
  try {
    const harness = `#!/bin/sh
set -eu
DEPLOYMENT_SUCCEEDED=false
API_BRIDGE_PUBLISHED=false
API_A_BRIDGE_ROLLBACK_TAG_CREATED=true
API_B_BRIDGE_ROLLBACK_TAG_CREATED=true
API_A_BRIDGE_ROLLBACK_IMAGE=rollback-a
API_B_BRIDGE_ROLLBACK_IMAGE=rollback-b
OLD_API_A_IMAGE=old-a
OLD_API_B_IMAGE=old-b
BRIDGE_LIVE_MUTATION_STARTED=false
REMOVE_LOG="${shellPath(removeLog)}"
record_state() { :; }
remove_owned_image_ref() { printf '%s|%s\n' "$1" "$2" >> "$REMOVE_LOG"; }
${cleanupFunction}
cleanup_unpublished_bridge_rollback_tags 0
[ "$API_A_BRIDGE_ROLLBACK_TAG_CREATED" = false ]
[ "$API_B_BRIDGE_ROLLBACK_TAG_CREATED" = false ]
[ "$(wc -l < "$REMOVE_LOG")" = 2 ]
: > "$REMOVE_LOG"
API_A_BRIDGE_ROLLBACK_TAG_CREATED=true
API_B_BRIDGE_ROLLBACK_TAG_CREATED=true
BRIDGE_LIVE_MUTATION_STARTED=true
cleanup_unpublished_bridge_rollback_tags 0
[ "$API_A_BRIDGE_ROLLBACK_TAG_CREATED" = true ]
[ "$API_B_BRIDGE_ROLLBACK_TAG_CREATED" = true ]
[ ! -s "$REMOVE_LOG" ]
BRIDGE_LIVE_MUTATION_STARTED=false
cleanup_unpublished_bridge_rollback_tags 1
[ "$API_A_BRIDGE_ROLLBACK_TAG_CREATED" = true ]
[ "$API_B_BRIDGE_ROLLBACK_TAG_CREATED" = true ]
[ ! -s "$REMOVE_LOG" ]
`;
    await writeFile(harnessPath, harness, 'utf8');
    await chmod(harnessPath, 0o755);
    const result = spawnSync('sh', [shellPath(harnessPath)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBridgeBackupRevalidationStopsPublication() {
  const functionStart = deploymentSource.indexOf('prepare_and_publish_bridge_receipt() {');
  const functionEnd = deploymentSource.indexOf('\nrelease_active_journal() {', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const receiptFunction = deploymentSource.slice(functionStart, functionEnd)
    .replaceAll('\r\n', '\n');

  for (const failAt of [0, 1, 2, 3, 4, 5]) {
    const root = await mkdtemp(join(scriptsDirectory, `.bridge-backup-revalidation-${failAt}-`));
    const sourceScripts = join(root, 'source', 'scripts');
    const deploymentDirectory = join(root, 'deployment');
    const imageScanRoot = join(deploymentDirectory, 'image-scan');
    const fakePythonPath = join(root, 'python3');
    const harnessPath = join(root, 'harness.sh');
    const pythonLog = join(root, 'python.log');
    const revalidationCount = join(root, 'revalidation-count');
    const canonicalReceipt = join(root, 'api-bridge-receipt.json');
    const preparedReceipt = join(deploymentDirectory, 'api-bridge-receipt.prepared.json');
    const previousReceipt = join(deploymentDirectory, 'api-bridge-previous.receipt');
    const liveEvidence = join(deploymentDirectory, 'bridge-live-publication.json');
    try {
      await Promise.all([
        mkdir(sourceScripts, { recursive: true }),
        mkdir(imageScanRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(sourceScripts, 'sbc-api-bridge-receipt.py'), '', 'utf8'),
        writeFile(join(sourceScripts, 'wsl-dr-api-bridge-receipt.py'), '', 'utf8'),
        writeFile(join(sourceScripts, 'sbc-api-bridge-publication.py'), '', 'utf8'),
      ]);
      const fakePython = String.raw`#!/bin/sh
set -eu
log="${shellPath(pythonLog)}"
[ "$1" = -I ]
script="$2"
shift 2
case "$script" in
    */sbc-api-bridge-receipt.py)
        previous=""
        receipt=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --previous-output) previous="$2"; shift 2 ;;
                --receipt-output) receipt="$2"; shift 2 ;;
                *) shift ;;
            esac
        done
        printf '%s\n' producer >> "$log"
        printf '%s\n' '{"schemaVersion":2}' > "$previous"
        printf '%s\n' '{"schemaVersion":2}' > "$receipt"
        ;;
    */wsl-dr-api-bridge-receipt.py)
        printf '%s\n' helper >> "$log"
        printf '%s\n' '{}'
        ;;
    */sbc-api-bridge-publication.py)
        printf '%s\n' publisher >> "$log"
        [ "$FAIL_AT" = 0 ] || exit 97
        [ "$1" = publish ]
        shift
        prepared=""
        canonical=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --prepared) prepared="$2"; shift 2 ;;
                --canonical) canonical="$2"; shift 2 ;;
                --expected-sha256) shift 2 ;;
                *) exit 95 ;;
            esac
        done
        mv "$prepared" "$canonical"
        printf '%s\n' published
        ;;
    *) exit 96 ;;
esac
`;
      await writeFile(fakePythonPath, fakePython, 'utf8');
      await chmod(fakePythonPath, 0o755);

      const harness = `#!/bin/sh
set -eu
SOURCE_SNAPSHOT_ROOT="${shellPath(join(root, 'source'))}"
DEPLOYMENT_DIR="${shellPath(deploymentDirectory)}"
IMAGE_SCAN_ROOT="${shellPath(imageScanRoot)}"
API_BRIDGE_RECEIPT="${shellPath(canonicalReceipt)}"
API_BRIDGE_PREPARED_RECEIPT="${shellPath(preparedReceipt)}"
API_BRIDGE_PREVIOUS_RECEIPT="${shellPath(previousReceipt)}"
BRIDGE_LIVE_PUBLICATION_EVIDENCE="${shellPath(liveEvidence)}"
PYTHON_COMMAND="${shellPath(fakePythonPath)}"
SYNC_COMMAND=true
DOCKER_COMMAND=docker
TEST_MODE=1
NEW_GATEWAY_CONTAINER_ID=${'6'.repeat(64)}
NEW_WEB_CONTAINER_ID=${'7'.repeat(64)}
NEW_API_A_CONTAINER_ID=${'4'.repeat(64)}
NEW_API_B_CONTAINER_ID=${'5'.repeat(64)}
OLD_API_A_CONTAINER_ID=${'d'.repeat(64)}
OLD_API_B_CONTAINER_ID=${'e'.repeat(64)}
BRIDGE_QDRANT_ID=${'1'.repeat(64)}
DEPLOYMENT_ID=test-deployment
GIT_COMMIT=${'a'.repeat(40)}
SOURCE_TREE_ENTRIES_FILE=source.entries
SOURCE_SNAPSHOT_SHA256=${'b'.repeat(64)}
BRIDGE_QDRANT_BACKUP_BINDING=off-host-evidence-sha256-${'c'.repeat(64)}
BRIDGE_QDRANT_PUBLICATION_GENERATION=legacy
API_A_BRIDGE_ROLLBACK_IMAGE=rollback-a
API_B_BRIDGE_ROLLBACK_IMAGE=rollback-b
OLD_API_A_IMAGE=old-a
OLD_API_B_IMAGE=old-b
API_SCAN_RECEIPT_SHA=${'1'.repeat(64)}
GATEWAY_SCAN_RECEIPT_SHA=${'2'.repeat(64)}
WEB_SCAN_RECEIPT_SHA=${'3'.repeat(64)}
RECOVERY_ARMED=true
BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE=false
BRIDGE_HARNESS_LOG="${shellPath(pythonLog)}"
export BRIDGE_HARNESS_LOG
REVALIDATION_COUNT="${shellPath(revalidationCount)}"
FAIL_AT=${failAt}
export FAIL_AT
ALIAS_STATE=expected
verify_bridge_stateful_contract() { :; }
verify_exact_rolling_topology() { :; }
verify_published_web() { :; }
verify_all_rolling_candidate_scan_receipts() { :; }
verify_private_source_snapshot() { :; }
verify_bridge_live_publication_evidence() {
    if [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = true ]; then
        printf '%s\n' alias-writer-blocked >> "$BRIDGE_HARNESS_LOG"
    else
        ALIAS_STATE=drifted
    fi
    [ "$ALIAS_STATE" = expected ]
    printf '%s\n' live-probe >> "$BRIDGE_HARNESS_LOG"
    printf '%s\n' '{"probe":"passed"}' > "$BRIDGE_LIVE_PUBLICATION_EVIDENCE"
    [ "$FAIL_AT" != 5 ]
}
acquire_bridge_publication_writer_barrier_with_retry() {
    printf '%s\n' gate-acquire >> "$BRIDGE_HARNESS_LOG"
    BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE=true
}
verify_bridge_publication_writer_barrier() {
    printf '%s\n' gate-verify >> "$BRIDGE_HARNESS_LOG"
    [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = true ]
}
release_bridge_publication_writer_barrier() {
    printf '%s\n' gate-release >> "$BRIDGE_HARNESS_LOG"
    BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE=false
}
record_state() { :; }
run_test_hook() { :; }
image_ref_id() {
    case "$1" in
        rollback-a) printf '%s\n' old-a ;;
        rollback-b) printf '%s\n' old-b ;;
        *) return 1 ;;
    esac
}
stat() {
    if [ "$1" = -c ] && [ "$2" = '%a:%h' ] \
        && [ "$3" = "$API_BRIDGE_RECEIPT" ]; then
        printf '%s\n' 600:1
        return 0
    fi
    /usr/bin/stat "$@"
}
prepare_bridge_backup_contract() {
    count=0
    [ ! -f "$REVALIDATION_COUNT" ] || count=$(cat "$REVALIDATION_COUNT")
    count=$((count + 1))
    printf '%s\n' "$count" > "$REVALIDATION_COUNT"
    case "$count:$3" in
        1:before-receipt-preparation|2:before-receipt-publication) ;;
        *) return 88 ;;
    esac
    [ "$count" -ne "$FAIL_AT" ]
}
verify_bridge_backup_post_probe_boundary() {
    count=0
    [ ! -f "$REVALIDATION_COUNT" ] || count=$(cat "$REVALIDATION_COUNT")
    count=$((count + 1))
    printf '%s\n' "$count" > "$REVALIDATION_COUNT"
    [ "$count" = 3 ] || return 89
    printf '%s\n' post-probe-boundary >> "$BRIDGE_HARNESS_LOG"
    [ "$count" -ne "$FAIL_AT" ]
}
${receiptFunction}
if [ "$FAIL_AT" = 0 ]; then
    if ! prepare_and_publish_bridge_receipt; then
        printf 'canonical=%s prepared=%s mode=%s sha=%s expected=%s\n' \
            "$(test -f "$API_BRIDGE_RECEIPT" && echo file || echo absent)" \
            "$(test -e "$API_BRIDGE_PREPARED_RECEIPT" && echo present || echo absent)" \
            "$(stat -c '%a:%h' "$API_BRIDGE_RECEIPT" 2>/dev/null || echo missing)" \
            "$(sha256sum "$API_BRIDGE_RECEIPT" 2>/dev/null | awk '{print $1}')" \
            "$API_BRIDGE_PREPARED_SHA" >&2
        exit 93
    fi
    [ "$(cat "$REVALIDATION_COUNT")" = 3 ]
    [ -f "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ]
    [ ! -e "$API_BRIDGE_PREPARED_RECEIPT" ]
    [ "$API_BRIDGE_PUBLISHED" = true ]
    [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = false ]
    [ "$ALIAS_STATE" = expected ]
    actual=$(cat "$BRIDGE_HARNESS_LOG")
    expected=$(printf '%s\n' producer helper gate-acquire gate-verify gate-verify \
        alias-writer-blocked live-probe post-probe-boundary publisher gate-release)
    [ "$actual" = "$expected" ]
    exit 0
fi
if prepare_and_publish_bridge_receipt; then
    exit 90
fi
case "$FAIL_AT" in
    1|2|3) [ "$(cat "$REVALIDATION_COUNT")" = "$FAIL_AT" ] ;;
    4) [ "$(cat "$REVALIDATION_COUNT")" = 3 ] ;;
    5) [ "$(cat "$REVALIDATION_COUNT")" = 2 ] ;;
    *) exit 94 ;;
esac
[ ! -e "$API_BRIDGE_RECEIPT" ] && [ ! -L "$API_BRIDGE_RECEIPT" ]
case "$FAIL_AT" in
    1)
        [ ! -e "$API_BRIDGE_PREPARED_RECEIPT" ]
        [ ! -e "$BRIDGE_HARNESS_LOG" ]
        ;;
    2)
        [ -f "$API_BRIDGE_PREPARED_RECEIPT" ]
        grep -Fx producer "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx publisher "$BRIDGE_HARNESS_LOG" >/dev/null
        ;;
    3)
        [ -f "$API_BRIDGE_PREPARED_RECEIPT" ]
        [ -f "$BRIDGE_LIVE_PUBLICATION_EVIDENCE" ]
        [ "$RECOVERY_ARMED" = true ]
        [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = true ]
        grep -Fx producer "$BRIDGE_HARNESS_LOG" >/dev/null
        grep -Fx gate-acquire "$BRIDGE_HARNESS_LOG" >/dev/null
        grep -Fx gate-verify "$BRIDGE_HARNESS_LOG" >/dev/null
        grep -Fx live-probe "$BRIDGE_HARNESS_LOG" >/dev/null
        grep -Fx post-probe-boundary "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx publisher "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx gate-release "$BRIDGE_HARNESS_LOG" >/dev/null
        ;;
    4)
        [ -f "$API_BRIDGE_PREPARED_RECEIPT" ]
        [ -f "$BRIDGE_LIVE_PUBLICATION_EVIDENCE" ]
        [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = true ]
        grep -Fx post-probe-boundary "$BRIDGE_HARNESS_LOG" >/dev/null
        grep -Fx publisher "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx gate-release "$BRIDGE_HARNESS_LOG" >/dev/null
        ;;
    5)
        [ -f "$API_BRIDGE_PREPARED_RECEIPT" ]
        [ -f "$BRIDGE_LIVE_PUBLICATION_EVIDENCE" ]
        [ "$BRIDGE_PUBLICATION_WRITER_BARRIER_ACTIVE" = true ]
        grep -Fx live-probe "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx post-probe-boundary "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx publisher "$BRIDGE_HARNESS_LOG" >/dev/null
        ! grep -Fx gate-release "$BRIDGE_HARNESS_LOG" >/dev/null
        ;;
esac
`;
      await writeFile(harnessPath, harness, 'utf8');
      await chmod(harnessPath, 0o755);
      const result = spawnSync('sh', [shellPath(harnessPath)], {
        cwd: projectDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      const harnessLog = await readFile(pythonLog, 'utf8').catch(() => '<absent>');
      const countLog = await readFile(revalidationCount, 'utf8').catch(() => '<absent>');
      assert.equal(result.status, 0, JSON.stringify({
        failAt,
        stdout: result.stdout,
        stderr: result.stderr,
        harnessLog,
        countLog,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function assertMigrationFailureStopsWithUnresolvedDaemonMutation(result) {
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /daemon_mutation\.(\d+)\.intent=compose-run\ndaemon_mutation\.\1\.phase=submitted-possible\ndaemon_mutation\.terminal_release=forbidden-compose-run-client-exit-1\ndaemon_mutation\.\1\.phase=unresolved-client-exit-1-terminal-release-forbidden/u,
  );
  assert.match(result.state, /migration\.acl_reconciliation=failed/);
  assert.match(
    result.state,
    /deployment\.status=daemon-unresolved-fail-stop-manual-reconciliation-required/,
  );
  assert.match(result.state, /recovery\.status=forbidden-no-conflicting-daemon-mutation/);
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
  assert.equal(result.apiARoute, 'MAINT');
  assert.equal(result.apiBRoute, 'MAINT');
  assert.doesNotMatch(result.dockerLog, /force-recreate api_a/);
  assert.doesNotMatch(result.dockerLog, /force-recreate api_b/);
}

function assertContainerQueryFailureStopsWithUnresolvedDaemonMutation(result, failurePattern) {
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, failurePattern);
  assert.match(
    result.state,
    /daemon_mutation\.terminal_release=forbidden-docker-container-query-exit-1/u,
  );
  assert.match(
    result.state,
    /deployment\.status=daemon-unresolved-fail-stop-manual-reconciliation-required/u,
  );
  assert.match(result.state, /recovery\.status=forbidden-no-conflicting-daemon-mutation/u);
  assert.match(
    result.state,
    /deployment\.interlock=active-journal-and-deploy-lock-retained/u,
  );
  assert.match(result.state, /backend_env\.private_cleanup=durable-exact-inode-unlink/u);
  assert.match(
    result.state,
    /backend_env\.private_runtime_cleanup=durable-tmpfs-dirfd-release/u,
  );
  assert.notEqual(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.privateRuntimeEntries, null);
}

async function testWebInventoryQueryFailureFailsClosed() {
  const result = await runScenario('web-inventory', 'web_inventory');
  assertContainerQueryFailureStopsWithUnresolvedDaemonMutation(
    result,
    /failure=Container inventory query failed while reading the image for vocadb_web/u,
  );
  assert.doesNotMatch(result.dockerLog, /compose .* build /u);
  assert.doesNotMatch(result.dockerLog, /force-recreate web/u);
  assertExactOldRollingIdentities(result);
}

async function testGatewayInventoryQueryFailureFailsClosed() {
  const result = await runScenario('gateway-inventory', 'gateway_inventory');
  assertContainerQueryFailureStopsWithUnresolvedDaemonMutation(
    result,
    /failure=gateway inventory could not be read during preflight/u,
  );
  assert.doesNotMatch(result.dockerLog, /compose .* build /u);
  assert.doesNotMatch(result.dockerLog, /force-recreate api_gateway/u);
  assertExactOldRollingIdentities(result);
}

async function testCandidateTrivyScanFailsClosed() {
  const result = await runScenario('candidate-trivy-scan', 'trivy_gateway_scan');
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /failure=An exact rolling candidate failed the local Trivy receipt gate/u);
  assert.match(result.trivyLog, /^prepare /mu);
  assert.match(result.trivyLog, /^scan api /mu);
  assert.match(result.trivyLog, /^scan gateway /mu);
  assert.doesNotMatch(result.trivyLog, /^scan web /mu);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.lockOwner, '');
  assertExactOldRollingIdentities(result);
}

async function testCandidateReceiptReverificationFailsBeforePromotion() {
  const result = await runScenario('candidate-receipt-reverify', 'trivy_receipt_verify');
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /failure=Rolling candidate image or Trivy receipt changed before promotion/u);
  assert.match(result.trivyLog, /^scan api /mu);
  assert.match(result.trivyLog, /^scan gateway /mu);
  assert.match(result.trivyLog, /^scan web /mu);
  assert.match(result.trivyLog, /^verify api /mu);
  assert.match(result.trivyLog, /^verify gateway /mu);
  assert.doesNotMatch(result.trivyLog, /^verify web /mu);
  assert.doesNotMatch(result.dockerLog, /rename d{64} diva_api_a_previous_/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.lockOwner, '');
  assertExactOldRollingIdentities(result);
}

async function testPublishedContainerPlatformFailsClosed() {
  const result = await runScenario('published-container-platform', 'published_platform');
  assert.notEqual(result.result.status, 0);
  assert.match(result.state, /failure=A published API\/gateway\/Web container is not bound to linux\/arm64/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.lockOwner, '');
  assertExactOldRollingIdentities(result);

  const unchangedGateway = await runScenario(
    'unchanged',
    'published_unchanged_gateway_platform',
  );
  assert.notEqual(unchangedGateway.result.status, 0);
  assert.match(
    unchangedGateway.state,
    /gateway\.unchanged_container_id=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/u,
  );
  assert.match(
    unchangedGateway.state,
    /failure=A published API\/gateway\/Web container is not bound to linux\/arm64/u,
  );
  assert.doesNotMatch(
    unchangedGateway.dockerLog,
    /create --name vocadb_api_gateway /u,
  );
  assert.match(
    unchangedGateway.dockerLog,
    /update --restart unless-stopped ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/u,
  );
  assert.doesNotMatch(
    unchangedGateway.dockerLog,
    /rm -f ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/u,
  );
  assert.equal(unchangedGateway.privateBackendEnvironment, '');
  assert.equal(unchangedGateway.lockOwner, '');
  assertExactOldRollingIdentities(unchangedGateway);
}

async function testPrivateBackendEnvironmentIdentitySwapFailsClosed() {
  const result = await runScenario(
    'private-backend-env-swap',
    '',
    'private-runtime-captured',
    'replace-backend-secret-and-fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /backend_env\.private_cleanup=failed-exact-inode-unlink-deploy-lock-retained/u,
  );
  assert.match(result.state, /private-secret-cleanup-unresolved-active-journal-and-lock-retained/u);
  assert.equal(result.privateBackendEnvironment, 'ATTACKER_REPLACEMENT=must-not-be-deleted\n');
  assert.match(result.lockOwner, /^pid=/u);
  assertExactOldRollingIdentities(result);
}

async function testDeployLockCleanupFailureIsNotIgnored() {
  const result = await runScenario(
    'deploy-lock-cleanup-blocked',
    '',
    'private-runtime-captured',
    'block-lock-cleanup-and-fail',
  );
  assert.notEqual(result.result.status, 0);
  assert.match(
    result.state,
    /deployment\.lock_cleanup=failed-exact-identity-release-manual-reconciliation-required/u,
  );
  assert.match(result.result.stderr, /Deployment lock cleanup failed and was not ignored/u);
  assert.equal(result.privateBackendEnvironment, '');
  assert.equal(result.lockBlocker, 'blocker');
  assert.equal(result.activeJournal, '');
  assert.match(result.lockOwner, /^pid=/u);
  assertExactOldRollingIdentities(result);
}

function parseUniqueKeyValueRecords(content, label) {
  const records = new Map();
  for (const line of content.trim().split('\n')) {
    const separator = line.indexOf('=');
    assert.ok(separator > 0, `${label} contains a malformed record: ${line}`);
    const key = line.slice(0, separator);
    assert.equal(records.has(key), false, `${label} contains duplicate key ${key}`);
    records.set(key, line.slice(separator + 1));
  }
  return records;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function testSigkillStartupReconciliation() {
  const scenario = await createScenario('crash-reconcile');
  const stateSentinel = join(scenario.deploymentState, 'unrelated-state-sentinel');
  const runtimeSiblingSentinel = join(scenario.root, 'runtime-private-unrelated');
  const focusedTimeout = Math.min(configuredScenarioTimeout, 60_000);
  try {
    await Promise.all([
      writeFile(stateSentinel, 'preserve-state\n', 'utf8'),
      writeFile(runtimeSiblingSentinel, 'preserve-runtime-sibling\n', 'utf8'),
    ]);

    const crashed = executeScenario(scenario, 'crash-reconcile', {
      hookPhase: 'private-runtime-captured',
      hookAction: 'hard-kill',
      timeout: focusedTimeout,
    });
    assert.equal(crashed.error, undefined, 'SIGKILL fixture did not reach its bounded crash point');
    assert.ok(
      crashed.status !== 0 || crashed.signal !== null,
      'SIGKILL fixture unexpectedly completed successfully',
    );

    const activeJournalPath = join(scenario.deploymentState, 'rolling-deployment-active');
    const lockDirectory = join(scenario.deploymentState, 'deploy.lock');
    const lockOwnerPath = join(lockDirectory, 'owner');
    const privateBackendPath = join(scenario.privateRuntime, 'backend.env.private');
    const [
      staleSecret,
      staleJournalRaw,
      staleOwnerRaw,
      staleState,
      staleRuntimeEntries,
    ] = await Promise.all([
      readFile(privateBackendPath, 'utf8'),
      readFile(activeJournalPath, 'utf8'),
      readFile(lockOwnerPath, 'utf8'),
      readDeploymentState(scenario.deploymentState),
      readdir(scenario.privateRuntime),
    ]);
    assert.equal(
      staleSecret,
      backendEnvironmentFixture,
      'crash fixture did not retain the captured secret',
    );
    assert.deepEqual(staleRuntimeEntries, ['backend.env.private']);

    const staleJournal = staleJournalRaw.trim();
    const staleOwner = parseUniqueKeyValueRecords(staleOwnerRaw, 'stale deploy owner');
    const staleDeploymentId = staleJournal.split('/').at(-1);
    assert.match(staleDeploymentId, /^[0-9]{8}T[0-9]{6}Z-[0-9]+$/u);
    assert.match(
      staleJournal,
      new RegExp(
        `^${escapeRegExp(shellPath(scenario.deploymentState))}/${staleDeploymentId}$`,
        'u',
      ),
    );
    assert.equal(staleOwner.get('deployment_id'), staleDeploymentId);
    assert.equal(staleOwner.get('deployment_dir'), staleJournal);
    assert.equal(staleOwner.get('private_runtime'), shellPath(scenario.privateRuntime));
    assert.match(staleOwner.get('pid') ?? '', /^[0-9]+$/u);
    assert.match(staleState, new RegExp(`^deployment\\.id=${staleDeploymentId}$`, 'mu'));
    assert.match(staleState, /^deployment\.directory_identity=[0-9]+:[0-9]+$/mu);
    assert.match(staleState, /^deployment\.lock_dir_identity=[0-9]+:[0-9]+$/mu);
    assert.match(
      staleState,
      /^deployment\.lock_owner_identity=[0-9]+:[0-9]+:[0-9]+:[0-9a-fA-F]+:1$/mu,
    );
    assert.match(
      staleState,
      /^deployment\.journal_identity=[0-9]+:[0-9]+:[0-9]+:[0-9a-fA-F]+:1$/mu,
    );
    assert.match(staleState, /^private_runtime\.identity=[0-9]+:[0-9]+$/mu);
    assert.match(
      staleState,
      new RegExp(
        `^private_runtime\\.path=${escapeRegExp(shellPath(scenario.privateRuntime))}$`,
        'mu',
      ),
    );

    const restarted = executeScenario(scenario, 'crash-reconcile', {
      environment: { DIVA_DEPLOY_TEST_STOP_AFTER_RECONCILE: '1' },
      timeout: focusedTimeout,
    });
    assert.equal(restarted.error, undefined, 'bounded stale-run restart failed to execute');
    assert.equal(restarted.status, 0, JSON.stringify({
      signal: restarted.signal,
      stdout: restarted.stdout,
      stderr: restarted.stderr,
      staleState,
    }, null, 2));
    assert.match(restarted.stdout, /^startup reconciliation completed$/mu);

    const [
      privateBackendAfter,
      privateRuntimeAfter,
      activeJournalAfter,
      lockDirectoryAfter,
      preservedStateSentinel,
      preservedRuntimeSibling,
      preservedEvidence,
    ] = await Promise.all([
      readFile(privateBackendPath, 'utf8').catch(() => null),
      readdir(scenario.privateRuntime).catch(() => null),
      readFile(activeJournalPath, 'utf8').catch(() => null),
      readdir(lockDirectory).catch(() => null),
      readFile(stateSentinel, 'utf8'),
      readFile(runtimeSiblingSentinel, 'utf8'),
      readDeploymentState(scenario.deploymentState),
    ]);
    assert.equal(privateBackendAfter, null, 'stale exact secret survived reconciliation');
    assert.equal(privateRuntimeAfter, null, 'stale exact private runtime survived reconciliation');
    assert.equal(activeJournalAfter, null, 'stale exact active journal survived reconciliation');
    assert.equal(lockDirectoryAfter, null, 'stale exact deploy lock survived reconciliation');
    assert.equal(preservedStateSentinel, 'preserve-state\n');
    assert.equal(preservedRuntimeSibling, 'preserve-runtime-sibling\n');
    assert.match(
      preservedEvidence,
      new RegExp(`^deployment\\.id=${staleDeploymentId}$`, 'mu'),
      'stale deployment evidence directory was swept during reconciliation',
    );
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
}

async function testUnverifiableDeploymentLockFailsClosed() {
  const lockFailure = await runScenario('lock-held', '', '', '', true);
  assert.equal(lockFailure.result.status, 75, JSON.stringify({
    error: lockFailure.result.error?.message,
    signal: lockFailure.result.signal,
    stdout: lockFailure.result.stdout,
    stderr: lockFailure.result.stderr,
    state: lockFailure.state,
    dockerLog: lockFailure.dockerLog,
  }, null, 2));
  assert.match(
    lockFailure.result.stderr,
    /Stale rolling deployment evidence could not be reconciled exactly; journal and lock were preserved/u,
  );
  assert.equal(lockFailure.state, '');
  assert.equal(lockFailure.lockOwner, 'pid=existing started=2026-08-10T00:00:00Z');
  assert.equal(lockFailure.dockerLog, '');
}

async function testStateRootAndPrivilegeModeContract() {
  const testModeStart = deploymentSource.indexOf('if [ "$TEST_MODE" = "1" ]; then');
  const productionModeStart = deploymentSource.indexOf('\nelse\n', testModeStart);
  const backendSourceStart = deploymentSource.indexOf(
    'if [ "$TEST_MODE" = "1" ]; then',
    productionModeStart,
  );
  assert.ok(
    testModeStart >= 0 && productionModeStart > testModeStart
      && backendSourceStart > productionModeStart,
    'rolling privilege mode branches must remain explicit and ordered',
  );
  const privilegeModeContract = deploymentSource.slice(testModeStart, backendSourceStart);
  assert.match(
    privilegeModeContract,
    /deterministic deployment test mode refuses uid 0/u,
  );
  assert.match(
    privilegeModeContract,
    /\[ "\$\{DIVA_DEPLOY_STATE_DIR\+x\}" = x \][\s\S]*\[ "\$\{DIVA_STATEFUL_STATE_DIR\+x\}" = x \]/u,
  );
  assert.match(
    privilegeModeContract,
    /production deployment state-root overrides are forbidden/u,
  );
  assert.match(
    privilegeModeContract,
    /\[ -z "\$\{DIVA_DEPLOY_TEST_PLATFORM_PROBE\+x\}" \][\s\S]*production platform test probe is forbidden/u,
  );
  assert.match(
    privilegeModeContract,
    /\[ "\$\(\/usr\/bin\/id -u\)" -eq 0 \][\s\S]*production rolling deployment requires uid 0/u,
  );
  assert.match(
    deploymentSource,
    /if \[ "\$TEST_MODE" = "1" \]; then[\s\S]*STATE_ROOT=\$\{DIVA_DEPLOY_STATE_DIR:-\$\{DIVA_STATEFUL_STATE_DIR:-"\$ROOT_DIR\/\.deploy-state"\}\}[\s\S]*else\s+#[\s\S]*STATE_ROOT=\/var\/lib\/diva-player-deploy\s+fi/u,
  );
  assert.match(
    deploymentSource,
    /prepare_deployment_state_root\(\)[\s\S]*\[ "\$STATE_ROOT" = \/var\/lib\/diva-player-deploy \][\s\S]*validate_trusted_system_directory \/var\/lib[\s\S]*0:0[\s\S]*\[ "\$mode" = 700 \]/u,
  );

  const productionEnvironment = { ...process.env };
  for (const key of Object.keys(productionEnvironment)) {
    if (key.startsWith('DIVA_')) delete productionEnvironment[key];
  }
  productionEnvironment.DIVA_DEPLOY_TEST_MODE = '0';
  for (const stateVariable of ['DIVA_DEPLOY_STATE_DIR', 'DIVA_STATEFUL_STATE_DIR']) {
    const overrideRejected = spawnSync('sh', [shellPath(deploymentScript)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...productionEnvironment, [stateVariable]: '' },
    });
    assert.equal(overrideRejected.error, undefined);
    assert.equal(overrideRejected.status, 1);
    assert.match(
      overrideRejected.stderr,
      /ERROR: production deployment state-root overrides are forbidden/u,
    );
  }

  const uidProbe = spawnSync('sh', ['-c', '/usr/bin/id -u'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(uidProbe.error, undefined);
  assert.equal(uidProbe.status, 0, uidProbe.stderr);
  if (uidProbe.stdout.trim() !== '0') {
    const nonRootProduction = spawnSync('sh', [shellPath(deploymentScript)], {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 10_000,
      env: productionEnvironment,
    });
    assert.equal(nonRootProduction.error, undefined);
    assert.equal(nonRootProduction.status, 1);
    assert.match(
      nonRootProduction.stderr,
      /ERROR: production rolling deployment requires uid 0/u,
    );
  }

  const scenario = await createScenario('state-root-mode');
  try {
    const mismatch = executeScenario(scenario, 'state-root-mode', {
      environment: {
        DIVA_STATEFUL_STATE_DIR: `${shellPath(scenario.deploymentState)}-different`,
      },
      timeout: 30_000,
    });
    assert.equal(mismatch.error, undefined);
    assert.equal(mismatch.status, 1);
    assert.match(
      mismatch.stderr,
      /ERROR: deploy and stateful state-root overrides must be identical/u,
    );
    assert.equal(
      await readFile(join(scenario.fakeState, 'docker.log'), 'utf8').catch(() => ''),
      '',
    );

    const lockDirectory = join(scenario.deploymentState, 'deploy.lock');
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner'),
      'pid=unverifiable started=2026-08-10T00:00:00Z\n',
      'utf8',
    );
    const accepted = executeScenario(scenario, 'state-root-mode', {
      environment: { DIVA_STATEFUL_STATE_DIR: shellPath(scenario.deploymentState) },
      timeout: 30_000,
    });
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 75);
    assert.match(accepted.stderr, /rolling deployment/u);
    assert.doesNotMatch(
      accepted.stderr,
      /state-root overrides are forbidden|state-root overrides must be identical/u,
    );
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
}

if (process.env.DIVA_ROLLING_TEST_ONLY === 'crash-reconcile') {
  await testSigkillStartupReconciliation();
  console.log('PASS SIGKILL stale secret/journal/lock exact startup reconciliation');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'gateway-config-validation') {
  await testGatewayConfigValidationSettlementContract();
  console.log('PASS exact gateway configuration validation settlement contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'web-old-rm-timeout') {
  await testWebOldRemovalTimeout();
  console.log('PASS deferred old Web cleanup timeout contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'state-root') {
  await testStateRootAndPrivilegeModeContract();
  console.log('PASS rolling production/test state-root and uid mode contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'bootstrap-gateway-failure') {
  await testBootstrapGatewayPublishedFailure();
  console.log('PASS bootstrap gateway exact-ID recovery scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'unowned-api-replacement') {
  await testUnownedApiReplacementIsPreserved();
  console.log('PASS unowned API replacement preservation scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'legacy-replacement') {
  await testPreflightLegacyReplacementIsPreserved();
  console.log('PASS immutable preflight legacy identity scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'unowned-gateway-replacement') {
  await testUnownedGatewayReplacementIsPreserved();
  console.log('PASS unowned gateway replacement preservation scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'unowned-web-replacement') {
  await testUnownedWebReplacementIsPreserved();
  console.log('PASS unowned Web replacement preservation scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'gateway-route-swap') {
  await testGatewayAndRouteIdentitySwapsFailClosed();
  console.log('PASS gateway and route exact-identity swap scenarios');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'stateful-migrate-retag') {
  await testStatefulMigrateContractRetagFailsClosed();
  console.log('PASS migration-helper stable-ref retag fail-closed scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'stateful-qdrant-provenance') {
  await testStatefulQdrantProvenanceDriftFailsClosed();
  console.log('PASS Qdrant Dockerfile provenance label fail-closed scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'stateful-qdrant-source') {
  await testStatefulQdrantSourceCommitFailsClosed();
  console.log('PASS Qdrant source commit ancestry fail-closed scenario');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-platform') {
  await testNormalCandidatePlatformFailsClosed();
  console.log('PASS normal rolling candidate exact linux/arm64 gate');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'private-runtime') {
  await testPrivateRuntimeSignalCleanup();
  console.log('PASS private tmpfs runtime signal cleanup and exact journal/lock release');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'bridge-contract') {
  testBridgeTrivyAndExactImageContract();
  await testBridgeBackupLifetimeContract();
  await testBridgeLivePublicationEvidenceContract();
  await testBridgeAttesterSourceModeContract();
  await testBridgePublicationWriterBarrierContract();
  await testBridgeRollbackTagsRetainedAfterMutation();
  await testBridgeBackupRevalidationStopsPublication();
  console.log('PASS pre-stateful stateless image and fresh backup receipt publication contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'bridge-lifetime') {
  await testBridgeBackupLifetimeContract();
  await testBridgeLivePublicationEvidenceContract();
  await testBridgePublicationWriterBarrierContract();
  await testBridgeRollbackTagsRetainedAfterMutation();
  await testBridgeBackupRevalidationStopsPublication();
  console.log('PASS bridge monotonic lifetime and live publication gates');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-trivy') {
  await testCandidateScanBatchTimestampContract();
  await testCandidateTrivyScanFailsClosed();
  await testCandidateReceiptReverificationFailsBeforePromotion();
  console.log('PASS rolling candidate Trivy scan and exact receipt gates');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-trivy-batch') {
  await testCandidateScanBatchTimestampContract();
  console.log('PASS rolling candidate Trivy common batch timestamp contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-trivy-scan') {
  await testCandidateTrivyScanFailsClosed();
  console.log('PASS rolling candidate Trivy scan gate');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-trivy-reverify') {
  await testCandidateReceiptReverificationFailsBeforePromotion();
  console.log('PASS rolling candidate Trivy receipt promotion revalidation');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'published-platform') {
  await testPublishedContainerPlatformFailsClosed();
  console.log('PASS published container exact linux/arm64 gate');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'secret-cleanup') {
  await testPrivateBackendEnvironmentIdentitySwapFailsClosed();
  console.log('PASS private backend environment exact-inode cleanup interlock');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'lock-cleanup') {
  await testDeployLockCleanupFailureIsNotIgnored();
  console.log('PASS deploy lock cleanup failure interlock');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'migration') {
  const migrationFailure = await runScenario('migration', 'migration');
  assertMigrationFailureStopsWithUnresolvedDaemonMutation(migrationFailure);
  console.log('PASS migration unresolved daemon mutation fail-stop');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'lock-held') {
  await testUnverifiableDeploymentLockFailsClosed();
  console.log('PASS unverifiable rolling deployment lock evidence fail-stop');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'gateway-inventory') {
  await testGatewayInventoryQueryFailureFailsClosed();
  console.log('PASS gateway inventory unresolved Docker query fail-stop');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'web-inventory') {
  await testWebInventoryQueryFailureFailsClosed();
  console.log('PASS Web inventory unresolved Docker query fail-stop');
  process.exit(0);
}

await testStateRootAndPrivilegeModeContract();
await testGatewayConfigValidationSettlementContract();
const successful = await runScenario('success');
assert.equal(successful.result.status, 0, JSON.stringify({
  error: successful.result.error?.message,
  signal: successful.result.signal,
  stdout: successful.result.stdout,
  stderr: successful.result.stderr,
  dockerLog: successful.dockerLog,
  state: successful.state,
}, null, 2));
assert.ok(successful.state.includes(`api_a.old_image=${oldApiAImageId}`));
assert.ok(successful.state.includes(`api_b.old_image=${oldApiBImageId}`));
assert.ok(successful.state.includes(`gateway.old_image=${oldGatewayImageId}`));
assert.match(successful.state, /migration\.rollback=not-attempted-forward-only/);
assert.match(successful.state, /gateway\.candidate=healthy/);
assert.match(successful.state, /api_a\.candidate=healthy/);
assert.match(successful.state, /api_b\.candidate=healthy/);
assert.match(successful.state, /gateway\.update=completed/);
assert.match(successful.state, /deployment\.status=completed/);
assert.match(successful.state, /deployment\.lock=acquired/);
assert.match(successful.state, /candidate_images\.platform=all-exact-linux-arm64/u);
assert.match(successful.state, /image_scan\.status=all-exact-receipts-verified/u);
assert.match(successful.state, /image_scan\.status=all-exact-receipts-reverified-before-promotion/u);
assert.match(successful.state, /published_containers\.platform=all-exact-linux-arm64/u);
assert.match(successful.state, /backend_env\.private_cleanup=durable-exact-inode-unlink/u);
assert.match(successful.state, /deployment\.lock_cleanup=durable-exact-inode-release/u);
assert.equal(successful.privateBackendEnvironment, '');
assert.equal(successful.lockOwner, '');
for (const service of ['api', 'gateway', 'web']) {
  assert.match(successful.trivyLog, new RegExp(`^scan ${service} `, 'mu'));
  assert.match(successful.trivyLog, new RegExp(`^verify ${service} `, 'mu'));
}
assert.ok(successful.state.includes(`stateful_runtime_contract.postgres_image_id=${postgresImageId}`));
assert.ok(successful.state.includes(
  `stateful_runtime_contract.postgres_migrate_image_id=${postgresMigrateImageId}`,
));
assert.match(successful.state, /web\.old_container_id=a{64}/);
assert.match(successful.state, /web\.previous_container_id=a{64}/);
assert.match(successful.state, /web\.new_container_id=b{64}/);
assert.ok(successful.state.includes(`web.candidate_image=${newWebImageId}`));
assert.match(successful.state, /web\.candidate_config_hash=web-config/);
assert.ok(successful.state.includes(`api_a.candidate_image=${newApiImageId}`));
assert.ok(successful.state.includes(`api_b.candidate_image=${newApiImageId}`));
assert.match(successful.state, /api_a\.candidate_config_hash=api-a-config/);
assert.match(successful.state, /api_b\.candidate_config_hash=api-b-config/);
assert.ok(successful.state.includes(`gateway.candidate_image=${newGatewayImageId}`));
assert.match(successful.state, /web\.previous_cleanup=completed/);
assert.match(successful.state, /api_a\.previous_container_id=d{64}/);
assert.match(successful.state, /api_b\.previous_container_id=e{64}/);
assert.match(successful.state, /gateway\.previous_container_id=f{64}/);
assert.match(successful.state, /api_a\.previous_cleanup=completed/);
assert.match(successful.state, /api_b\.previous_cleanup=completed/);
assert.match(successful.state, /gateway\.previous_cleanup=completed/);
assert.equal(successful.webId, 'b'.repeat(64));
assert.equal(successful.apiAId, '4'.repeat(64));
assert.equal(successful.apiBId, '5'.repeat(64));
assert.equal(successful.gatewayId, '6'.repeat(64));
assert.equal(successful.containerEntries.some(entry => entry.includes('_previous_')), false);
assert.equal(successful.webImage, newWebImageId);
assert.match(successful.dockerLog, /run -d --no-deps --name diva_api_gateway_candidate_/);
assert.match(successful.dockerLog, /compose --env-file [^|]+ --project-name backend -f /);
assert.match(successful.dockerLog, /create --name vocadb_api_a /u);
assert.match(successful.dockerLog, /create --name vocadb_api_b /u);
assert.match(successful.dockerLog, /create --name vocadb_api_gateway /u);
assert.match(successful.dockerLog, /create --name vocadb_web /u);
assert.match(
  successful.dockerLog,
  /image inspect --format \{\{\.Id\}\} diva-player-postgres:16\.15-pgvector-0\.8\.6-hardened-r1/u,
);
assert.match(
  successful.dockerLog,
  /image inspect --format \{\{\.Id\}\} diva-player-postgres-migrate:16\.15-hardened-r1/u,
);
assert.match(
  successful.dockerLog,
  /image inspect --format \{\{index \.Config\.Labels "com\.diva\.qdrant\.dockerfile-sha256"\}\} sha256:[0-9a-f]{64}/u,
);
assert.doesNotMatch(
  successful.dockerLog,
  /compose [^\n]*--project-name backend[^\n]* up [^\n]*(?:api_a|api_b|api_gateway|web)/u,
  'same-project Compose must never discover and delete renamed exact rollback containers',
);

if (process.env.DIVA_ROLLING_TEST_ONLY === 'success') {
  console.log('PASS transactional rolling deployment success scenario');
  process.exit(0);
}
await testWebOldRemovalTimeout();

const candidateTagPresenceError = await runScenario(
  'candidate-tag-presence-error',
  'candidate_tag_presence_error',
);
assert.notEqual(candidateTagPresenceError.result.status, 0);
assert.match(candidateTagPresenceError.state, /daemon_mutation\.terminal_release=forbidden-docker-image-query-exit-2/);
assert.match(candidateTagPresenceError.state, /active-journal-and-deploy-lock-retained/);
assert.doesNotMatch(candidateTagPresenceError.dockerLog, /image tag new-(?:api|gateway|web) /u);
assert.notEqual(candidateTagPresenceError.activeJournal, '');
assert.match(candidateTagPresenceError.lockOwner, /^pid=/u);

const statefulContractRetag = await runScenario(
  'stateful-contract-retag',
  'stateful_contract_retag',
);
assert.notEqual(statefulContractRetag.result.status, 0);
assert.match(statefulContractRetag.state, /failure=Stateful Docker image references drifted from the completed runtime contract/);
assert.doesNotMatch(statefulContractRetag.dockerLog, /compose [^\n]*--project-name backend .* build/u);
assert.equal(statefulContractRetag.activeJournal, '');
assert.equal(statefulContractRetag.lockOwner, '');

await testStatefulQdrantProvenanceDriftFailsClosed();

await testStatefulMigrateContractRetagFailsClosed();

const statefulContractQueryError = await runScenario(
  'stateful-contract-query-error',
  'stateful_contract_image_error',
);
assert.notEqual(statefulContractQueryError.result.status, 0);
assert.match(statefulContractQueryError.state, /daemon_mutation\.terminal_release=forbidden-docker-image-query-exit-2/);
assert.match(statefulContractQueryError.state, /active-journal-and-deploy-lock-retained/);
assert.doesNotMatch(statefulContractQueryError.dockerLog, /compose [^\n]*--project-name backend .* build/u);
assert.notEqual(statefulContractQueryError.activeJournal, '');
assert.match(statefulContractQueryError.lockOwner, /^pid=/u);

const statefulContractInvalidImage = await runScenario(
  'stateful-contract-invalid-image-output',
  'stateful_contract_invalid_image_output',
);
assert.notEqual(statefulContractInvalidImage.result.status, 0);
assert.match(statefulContractInvalidImage.state, /daemon_mutation\.terminal_release=forbidden-docker-image-id-invalid-diva-player-qdrant/);
assert.match(statefulContractInvalidImage.state, /active-journal-and-deploy-lock-retained/);
assert.doesNotMatch(statefulContractInvalidImage.dockerLog, /compose [^\n]*--project-name backend .* build/u);

const statefulProjectionDrift = await runScenario(
  'stateful-projection-drift',
  'stateful_projection_drift',
);
assert.notEqual(statefulProjectionDrift.result.status, 0);
assert.match(statefulProjectionDrift.state, /failure=Stateful Compose projection does not match the completed runtime contract/);
assert.doesNotMatch(statefulProjectionDrift.dockerLog, /compose [^\n]*--project-name backend .* build/u);

const statefulAncestorContract = await runScenario(
  'stateful-contract-ancestor',
  'candidate_tag_presence_error',
);
assert.notEqual(statefulAncestorContract.result.status, 0);
assert.match(statefulAncestorContract.state, /stateful_runtime_contract\.sha256=[0-9a-f]{64}/u);
assert.match(statefulAncestorContract.state, /daemon_mutation\.terminal_release=forbidden-docker-image-query-exit-2/u);

await testStatefulQdrantSourceCommitFailsClosed();

const configOnly = await runScenario('config-only');
assert.equal(configOnly.result.status, 0, configOnly.result.stderr);
assert.ok(configOnly.state.includes(`gateway.old_image=${oldGatewayImageId}`));
assert.ok(configOnly.state.includes(`gateway.new_image=${oldGatewayImageId}`));
assert.match(configOnly.state, /gateway\.old_config_hash=old-config/);
assert.match(configOnly.state, /gateway\.candidate_config_hash=new-config/);
assert.match(configOnly.state, /gateway\.update=completed/);
assert.match(configOnly.dockerLog, /create --name vocadb_api_gateway /u);

const unchanged = await runScenario('unchanged');
assert.equal(unchanged.result.status, 0, unchanged.result.stderr);
assert.match(
  unchanged.state,
  /gateway\.unchanged_container_id=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/u,
);
assert.match(unchanged.state, /gateway\.update=unchanged/);
assert.doesNotMatch(unchanged.dockerLog, /create --name vocadb_api_gateway /u);
assert.match(
  unchanged.dockerLog,
  /update --restart unless-stopped ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/u,
);

const migrationFailure = await runScenario('migration', 'migration');
assertMigrationFailureStopsWithUnresolvedDaemonMutation(migrationFailure);

const credentialFailure = await runScenario('api-credential', 'api_candidate_health');
assert.notEqual(credentialFailure.result.status, 0);
assert.match(credentialFailure.state, /Candidate api_a API could not become ready/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_b/);
assert.doesNotMatch(credentialFailure.dockerLog, /force-recreate api_gateway/);
assertExactOldRollingIdentities(credentialFailure);

const runtimeContractDrift = await runScenario('runtime-contract-drift', 'runtime_contract_drift');
assert.notEqual(runtimeContractDrift.result.status, 0);
assert.match(
  runtimeContractDrift.state,
  /failure=Docker could not create the exact managed replacement for api_a/u,
);
assert.match(runtimeContractDrift.state, /api_a\.rollback=completed/u);
assertExactOldRollingIdentities(runtimeContractDrift);

await testUnverifiableDeploymentLockFailsClosed();

await testWebInventoryQueryFailureFailsClosed();
await testGatewayInventoryQueryFailureFailsClosed();

const drainFailure = await runScenario('drain', 'drain');
assert.notEqual(drainFailure.result.status, 0);
assert.match(drainFailure.state, /failure=Could not establish the public-writer barrier before migration/);
assert.match(drainFailure.state, /migration\.publication_gate=released-after-container-quiescence-and-acl-reconcile/);
assert.doesNotMatch(drainFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(drainFailure.dockerLog, /force-recreate api_b/);
assert.equal(drainFailure.apiARoute, 'UP');
assertExactOldRollingIdentities(drainFailure);

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
assertExactOldRollingIdentities(disableInterruption);

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
assert.match(replaceInterruption.dockerLog, /rm -f 4{64}/);
assert.match(replaceInterruption.dockerLog, /rename d{64} vocadb_api_a/);
assert.match(replaceInterruption.dockerLog, /start d{64}/);
assert.doesNotMatch(replaceInterruption.dockerLog, /force-recreate api_b/);
assertExactOldRollingIdentities(replaceInterruption);

const slotFailure = await runScenario('slot', 'api_b_health');
assert.notEqual(slotFailure.result.status, 0);
assert.match(slotFailure.state, /api_b\.rollback=completed/);
assert.match(slotFailure.state, /api_a\.rollback=completed/);
assert.doesNotMatch(slotFailure.state, /gateway\.update=started/);
assert.match(slotFailure.dockerLog, /rename e{64} vocadb_api_b/);
assert.match(slotFailure.dockerLog, /rename d{64} vocadb_api_a/);
assertExactOldRollingIdentities(slotFailure);

const candidateFailure = await runScenario('candidate', 'candidate_health');
assert.notEqual(candidateFailure.result.status, 0);
assert.match(candidateFailure.state, /failure=Candidate gateway could not reach both API slots/);
assert.match(candidateFailure.state, /api_b\.rollback=completed/);
assert.match(candidateFailure.state, /api_a\.rollback=completed/);
assert.doesNotMatch(candidateFailure.dockerLog, /force-recreate api_gateway\|api=diva-player-api:candidate-[^|]+\|gateway=diva-player-api-gateway:candidate-/);
assertExactOldRollingIdentities(candidateFailure);

const gatewayFailure = await runScenario('gateway', 'gateway_health');
assert.notEqual(gatewayFailure.result.status, 0);
assert.match(gatewayFailure.state, /gateway\.rollback=completed/);
assert.match(gatewayFailure.state, /api_b\.rollback=completed/);
assert.match(gatewayFailure.state, /api_a\.rollback=completed/);
assert.match(gatewayFailure.dockerLog, /rm -f 6{64}/);
assert.match(gatewayFailure.dockerLog, /rename f{64} vocadb_api_gateway/);
assert.match(gatewayFailure.dockerLog, /start f{64}/);
assertExactOldRollingIdentities(gatewayFailure);

const bootstrapWebFailure = await runScenario(
  'bootstrap-web-failure',
  '',
  'web-replaced',
  'fail',
);
assert.notEqual(bootstrapWebFailure.result.status, 0);
assert.match(bootstrapWebFailure.state, /web\.rollback=completed/);
assert.match(bootstrapWebFailure.state, /bootstrap\.recovery=completed/);
assert.match(bootstrapWebFailure.dockerLog, /start 1{64}/);
assert.match(bootstrapWebFailure.dockerLog, /rename a{64} diva_web_previous_/);
assert.match(bootstrapWebFailure.dockerLog, /rm -f b{64}/);
assert.match(bootstrapWebFailure.dockerLog, /rename a{64} vocadb_web/);
assert.doesNotMatch(bootstrapWebFailure.dockerLog, /web=diva-player-web:rollback/);
assert.equal(bootstrapWebFailure.webId, 'a'.repeat(64));
assert.equal(bootstrapWebFailure.webImage, oldWebImageId);
assert.equal(bootstrapWebFailure.webRunning, 'true');

await testBootstrapGatewayPublishedFailure();
await testUnownedApiReplacementIsPreserved();
await testPreflightLegacyReplacementIsPreserved();
await testUnownedGatewayReplacementIsPreserved();
await testUnownedWebReplacementIsPreserved();
await testGatewayAndRouteIdentitySwapsFailClosed();
await testNormalCandidatePlatformFailsClosed();
await testPrivateRuntimeSignalCleanup();
await testDockerPlatformPreflightFailureCleanup();
testBridgeTrivyAndExactImageContract();
await testBridgeBackupLifetimeContract();
await testBridgeLivePublicationEvidenceContract();
await testBridgeAttesterSourceModeContract();
await testBridgePublicationWriterBarrierContract();
await testBridgeRollbackTagsRetainedAfterMutation();
await testBridgeBackupRevalidationStopsPublication();
await testCandidateScanBatchTimestampContract();
await testCandidateTrivyScanFailsClosed();
await testCandidateReceiptReverificationFailsBeforePromotion();
await testPublishedContainerPlatformFailsClosed();
await testPrivateBackendEnvironmentIdentitySwapFailsClosed();
await testDeployLockCleanupFailureIsNotIgnored();

console.log('PASS transactional rolling deployment execution');
