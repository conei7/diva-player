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

if [ "$1" = "inspect" ]; then
    shift
    format=""
    if [ "__DOLLAR__{1:-}" = "--format" ]; then format="$2"; shift 2; fi
    container=$(resolve_container_name "$1")
    case "$format" in
        *'{{.Id}}'*)
            value=$(read_value "$containers/$container.id" "")
            [ -n "$value" ] || exit 1
            printf '%s\n' "$value"
            ;;
        *State.Running*) read_value "$containers/$container.running" true ;;
        *State.Health*) container_health "$container" ;;
        *HostConfig.RestartPolicy.Name*) read_value "$containers/$container.restart_policy" unless-stopped ;;
        *HostConfig.ReadonlyRootfs*) read_value "$containers/$container.read_only" true ;;
        *Config.Labels*) read_value "$containers/$container.config_hash" unknown-config ;;
        *Image*) read_value "$containers/$container.image" unknown ;;
        *) exit 1 ;;
    esac
    exit 0
fi

if [ "$1" = "container" ] && [ "__DOLLAR__{2:-}" = "ls" ]; then
    target=""
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "--filter" ]; then
            target=__DOLLAR__{2#name=^/}
            target=__DOLLAR__{target%\$}
            shift 2
        else
            shift
        fi
    done
    if { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "web_inventory" ] && [ "$target" = "vocadb_web" ]; } \
        || { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = "gateway_inventory" ] && [ "$target" = "vocadb_api_gateway" ]; }; then
        exit 1
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
            shift 2
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --format) format="$2"; shift 2 ;;
                    *) image="$1"; shift ;;
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
                *Architecture*/*Os*|*Os*/*Architecture*)
                    if { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = candidate_platform ] \
                        && [ "$image" = __NEW_API_ID__ ]; } \
                        || { [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = published_platform ] \
                            && [ -f "$fake_root/published-platform-active" ] \
                            && [ "$image" = __NEW_WEB_ID__ ]; }; then
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
        restart_policy=no
        read_only=false
        image=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --name) name="$2"; shift 2 ;;
                --label)
                    case "$2" in
                        com.docker.compose.config-hash=*) config_hash=__DOLLAR__{2#*=} ;;
                    esac
                    shift 2
                    ;;
                --restart) restart_policy="$2"; shift 2 ;;
                --read-only) read_only=true; shift ;;
                --user|--network|--network-alias|--env-file|--expose|--publish|--health-cmd|--health-interval|--health-timeout|--health-retries|--health-start-period|--stop-timeout|--cap-drop|--security-opt|--tmpfs|--memory-reservation|--memory|--pids-limit|--log-driver|--log-opt)
                    shift 2
                    ;;
                *) image="$1"; shift ;;
            esac
        done
        [ -n "$name" ] && [ -n "$image" ] && [ -n "$config_hash" ] || exit 64
        case "$name" in
            vocadb_api_a) id=4444444444444444444444444444444444444444444444444444444444444444 ;;
            vocadb_api_b) id=5555555555555555555555555555555555555555555555555555555555555555 ;;
            vocadb_api_gateway) id=6666666666666666666666666666666666666666666666666666666666666666 ;;
            vocadb_web) id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
            *) exit 64 ;;
        esac
        write_value "$containers/$name.id" "$id"
        write_value "$containers/$name.image" "$(image_id "$image")"
        write_value "$containers/$name.config_hash" "$config_hash"
        write_value "$containers/$name.restart_policy" "$restart_policy"
        if [ "__DOLLAR__{FAKE_FAIL_STAGE:-}" = runtime_contract_drift ] \
            && [ "$name" = vocadb_api_a ]; then
            read_only=false
        fi
        write_value "$containers/$name.read_only" "$read_only"
        write_value "$containers/$name.running" false
        write_value "$containers/$name.health" healthy
        [ "$name" != vocadb_web ] || : > "$fake_root/published-platform-active"
        printf '%s\n' "$id"
        exit 0
        ;;
    update)
        [ "__DOLLAR__{2:-}" = --restart ] || exit 64
        target=$(resolve_container_name "$4")
        write_value "$containers/$target.restart_policy" "$3"
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
                        sleep 1
                        rm -f "$containers/$target".*
                        printf '%s\n' "$target" > "$fake_root/late-old-web-rm"
                    ) >/dev/null 2>&1 &
                    exit 124
                    ;;
            esac
        fi
        rm -f "$containers/$target".*
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
        target=$(resolve_container_name "$2")
        write_value "$containers/$target.running" true
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
  await Promise.all([mkdir(bin), mkdir(containers, { recursive: true }), mkdir(deploymentState)]);

  const dockerPath = join(bin, 'docker');
  const curlPath = join(bin, 'curl');
  const sleepPath = join(bin, 'sleep');
  const syncPath = join(bin, 'sync');
  const pythonPath = join(bin, 'python3');
  const trivyPath = join(bin, 'trivy');
  const hookPath = join(bin, 'hook');
  await Promise.all([
    writeFile(dockerPath, fakeDocker, 'utf8'),
    writeFile(curlPath, fakeCurl, 'utf8'),
    writeFile(sleepPath, fakeSleep, 'utf8'),
    writeFile(syncPath, fakeSleep, 'utf8'),
    writeFile(pythonPath, fakeProjectionPython, 'utf8'),
    writeFile(trivyPath, fakeTrivy, 'utf8'),
    writeFile(hookPath, fakeHook, 'utf8'),
  ]);
  await Promise.all([
    chmod(dockerPath, 0o755),
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

  return {
    root, fakeState, deploymentState, privateRuntime, dockerPath, curlPath, sleepPath,
    syncPath, pythonPath, trivyPath, hookPath,
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
      await new Promise(resolve => setTimeout(resolve, 1_500));
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
  assert.match(result.state, /failure=A normal rolling candidate is not a native linux\/arm64 image/u);
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

function testBridgeTrivyAndExactImageContract() {
  assert.match(
    deploymentSource,
    /if \[ "\$BRIDGE_BOOTSTRAP_MODE" = "true" \]; then\s+if ! scan_bridge_api_candidate_image;/u,
  );
  assert.match(
    deploymentSource,
    /if \[ "\$BRIDGE_BOOTSTRAP_MODE" = "true" \]; then\s+if ! verify_bridge_api_candidate_scan_receipt;/u,
  );
  assert.match(
    deploymentSource,
    /create_managed_service_container "\$slot" "\$expected_config_hash" \\\s+"\$CANDIDATE_API_IMAGE_ID" "\$CANDIDATE_API_IMAGE_ID"/u,
  );
  assert.match(
    deploymentSource,
    /create_managed_service_container api_gateway "\$CANDIDATE_CONFIG_HASH" \\\s+"\$CANDIDATE_GATEWAY_IMAGE_ID" "\$CANDIDATE_GATEWAY_IMAGE_ID"/u,
  );
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
    assert.match(
      staleSecret,
      /^PG_PASSWORD=vocadb_secret$/mu,
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

if (process.env.DIVA_ROLLING_TEST_ONLY === 'crash-reconcile') {
  await testSigkillStartupReconciliation();
  console.log('PASS SIGKILL stale secret/journal/lock exact startup reconciliation');
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
  console.log('PASS bridge API Trivy and exact immutable image publication contract');
  process.exit(0);
}
if (process.env.DIVA_ROLLING_TEST_ONLY === 'candidate-trivy') {
  await testCandidateTrivyScanFailsClosed();
  await testCandidateReceiptReverificationFailsBeforePromotion();
  console.log('PASS rolling candidate Trivy scan and exact receipt gates');
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
assert.doesNotMatch(
  successful.dockerLog,
  /compose [^\n]*--project-name backend[^\n]* up [^\n]*(?:api_a|api_b|api_gateway|web)/u,
  'same-project Compose must never discover and delete renamed exact rollback containers',
);

if (process.env.DIVA_ROLLING_TEST_ONLY === 'success') {
  console.log('PASS transactional rolling deployment success scenario');
  process.exit(0);
}
const webOldRemovalTimeout = await runScenario('web-old-rm-timeout', 'web_old_rm_timeout');
assert.notEqual(webOldRemovalTimeout.result.status, 0);
assert.match(webOldRemovalTimeout.state, /deployment\.status=committed-daemon-cleanup-unresolved-manual-reconciliation-required/);
assert.match(webOldRemovalTimeout.state, /web\.previous_cleanup=deferred-safe-retention/);
assert.doesNotMatch(webOldRemovalTimeout.state, /web\.rollback=/);
assert.equal(webOldRemovalTimeout.webId, 'b'.repeat(64));
assert.equal(webOldRemovalTimeout.webImage, newWebImageId);
assert.notEqual(webOldRemovalTimeout.activeJournal, '');
assert.match(webOldRemovalTimeout.lockOwner, /^pid=/u);
assert.match(webOldRemovalTimeout.lateOldWebRemoval, /^diva_web_previous_/u);
assert.equal(webOldRemovalTimeout.apiAId, '4'.repeat(64));
assert.equal(webOldRemovalTimeout.apiBId, '5'.repeat(64));
assert.equal(webOldRemovalTimeout.gatewayId, '6'.repeat(64));

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
assert.match(unchanged.state, /gateway\.update=unchanged/);
assert.doesNotMatch(unchanged.dockerLog, /create --name vocadb_api_gateway /u);

const migrationFailure = await runScenario('migration', 'migration');
assert.notEqual(migrationFailure.result.status, 0);
assert.match(migrationFailure.state, /daemon_mutation\.11\.phase=unresolved-client-exit-1-terminal-release-forbidden/);
assert.match(migrationFailure.state, /migration\.acl_reconciliation=failed/);
assert.match(migrationFailure.state, /deployment\.status=daemon-unresolved-fail-stop-manual-reconciliation-required/);
assert.match(migrationFailure.state, /recovery\.status=forbidden-no-conflicting-daemon-mutation/);
assert.notEqual(migrationFailure.activeJournal, '');
assert.match(migrationFailure.lockOwner, /^pid=/u);
assert.equal(migrationFailure.apiARoute, 'MAINT');
assert.equal(migrationFailure.apiBRoute, 'MAINT');
assert.doesNotMatch(migrationFailure.dockerLog, /force-recreate api_a/);
assert.doesNotMatch(migrationFailure.dockerLog, /force-recreate api_b/);

const credentialFailure = await runScenario('api-credential', 'api_candidate_health');
assert.notEqual(credentialFailure.result.status, 0);
assert.match(credentialFailure.state, /Candidate API could not become ready/);
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

const lockFailure = await runScenario('lock-held', '', '', '', true);
assert.equal(lockFailure.result.status, 75);
assert.match(lockFailure.state, /Another rolling deployment holds/);
assert.equal(lockFailure.dockerLog, '');

const webInventoryFailure = await runScenario('web-inventory', 'web_inventory');
assert.notEqual(webInventoryFailure.result.status, 0);
assert.match(webInventoryFailure.state, /inventory query failed while reading the image for vocadb_web/);
assert.doesNotMatch(webInventoryFailure.dockerLog, /compose .* build /);
assert.doesNotMatch(webInventoryFailure.dockerLog, /force-recreate web/);

const gatewayInventoryFailure = await runScenario('gateway-inventory', 'gateway_inventory');
assert.notEqual(gatewayInventoryFailure.result.status, 0);
assert.match(gatewayInventoryFailure.state, /inventory query failed while reading the image for vocadb_api_gateway/);
assert.doesNotMatch(gatewayInventoryFailure.dockerLog, /compose .* build /);
assert.doesNotMatch(gatewayInventoryFailure.dockerLog, /force-recreate api_gateway/);

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
testBridgeTrivyAndExactImageContract();
await testCandidateTrivyScanFailsClosed();
await testCandidateReceiptReverificationFailsBeforePromotion();
await testPublishedContainerPlatformFailsClosed();
await testPrivateBackendEnvironmentIdentitySwapFailsClosed();
await testDeployLockCleanupFailureIsNotIgnored();

console.log('PASS transactional rolling deployment execution');
