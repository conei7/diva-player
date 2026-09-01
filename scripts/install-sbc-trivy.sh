#!/bin/sh
set -eu
umask 077

TRIVY_VERSION=0.74.0
TRIVY_ARCHIVE=trivy_0.74.0_Linux-ARM64.tar.gz
TRIVY_ARCHIVE_SHA256=b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5
TRIVY_BINARY_SHA256=fed2c9ca7d27191ada34524b5eaf5216a845c6d6f3246143c3b475552ffe5358
TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ARCHIVE}"
INSTALL_PARENT=/usr/local/libexec
INSTALL_DIR=/usr/local/libexec/diva-player
INSTALL_PATH=/usr/local/libexec/diva-player/trivy-0.74.0
TEST_MODE=${DIVA_TRIVY_INSTALL_TEST_MODE:-0}

verify_aarch64_elf() {
    path="$1"
    expected_sha="$2"
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    actual_sha=$(/usr/bin/sha256sum "$path" | /usr/bin/awk '{print $1}') || return 1
    [ "$actual_sha" = "$expected_sha" ] || return 1
    # ELF64, little-endian, current ELF version, ET_EXEC, EM_AARCH64 (183).
    # Checking the header before execution makes an x86_64 asset fail closed
    # instead of reaching an Exec format error on the SBC.
    set -- $(/usr/bin/od -An -tx1 -N20 "$path")
    [ "$#" -eq 20 ] \
        && [ "$1:$2:$3:$4" = "7f:45:4c:46" ] \
        && [ "$5:$6:$7" = "02:01:01" ] || return 1
    shift 16
    [ "$1:$2:$3:$4" = "02:00:b7:00" ]
}

verify_binary_file_contract() {
    path="$1"
    expected_sha="$2"
    expected_metadata="$3"
    verify_aarch64_elf "$path" "$expected_sha" || return 1
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$path")" = "$expected_metadata" ]
}

publish_staged_binary() {
    staged_path="$1"
    target_path="$2"
    target_directory="$3"
    [ -f "$staged_path" ] && [ ! -L "$staged_path" ] || return 1
    [ ! -e "$target_path" ] && [ ! -L "$target_path" ] || return 1
    # Same-filesystem hard-link publication is atomic and refuses a target
    # created by a concurrent installer instead of overwriting it.
    /usr/bin/ln -- "$staged_path" "$target_path" || return 1
    /usr/bin/sync -f "$target_path" || return 1
    /usr/bin/rm -f -- "$staged_path" || return 1
    /usr/bin/sync -f "$target_directory"
}

if [ "$TEST_MODE" = 1 ]; then
    case "${1:-}" in
        --test-verify-elf)
            [ "$#" -eq 3 ] || exit 64
            verify_aarch64_elf "$2" "$3"
            ;;
        --test-verify-file-contract)
            [ "$#" -eq 4 ] || exit 64
            verify_binary_file_contract "$2" "$3" "$4"
            ;;
        --test-publish)
            [ "$#" -eq 4 ] || exit 64
            publish_staged_binary "$2" "$3" "$4"
            ;;
        *) exit 64 ;;
    esac
    exit $?
fi
[ "$TEST_MODE" = 0 ] || {
    printf '%s\n' 'ERROR: invalid Trivy installer test mode' >&2
    exit 64
}
[ "$#" -eq 0 ] || {
    printf '%s\n' 'ERROR: the SBC Trivy installer takes no arguments' >&2
    exit 64
}
[ "$(/usr/bin/id -u)" -eq 0 ] || {
    printf '%s\n' 'ERROR: the SBC Trivy installer requires uid 0' >&2
    exit 1
}
case "$(/usr/bin/uname -m)" in
    aarch64|arm64) ;;
    *) printf '%s\n' 'ERROR: the SBC Trivy installer requires an AArch64 host' >&2; exit 1 ;;
esac

validate_root_directory() {
    directory="$1"
    [ -d "$directory" ] && [ ! -L "$directory" ] \
        && [ "$(/usr/bin/stat -c '%u:%g' "$directory")" = 0:0 ] || return 1
    mode=$(/usr/bin/stat -c '%a' "$directory") || return 1
    [ $((0$mode & 022)) -eq 0 ]
}

ensure_install_directory() {
    directory="$1"
    parent=${directory%/*}
    if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
        validate_root_directory "$parent" || return 1
        /usr/bin/mkdir --mode=0755 -- "$directory" || return 1
        /usr/bin/chown 0:0 "$directory" || return 1
        /usr/bin/chmod 0755 "$directory" || return 1
        /usr/bin/sync -f "$parent" || return 1
    fi
    validate_root_directory "$directory"
}

verify_installed_binary() {
    verify_binary_file_contract "$INSTALL_PATH" "$TRIVY_BINARY_SHA256" \
        0:0:555:1 || return 1
    version_output=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin \
        "$INSTALL_PATH" --version) || return 1
    printf '%s\n' "$version_output" | /usr/bin/grep -Fx \
        "Version: $TRIVY_VERSION" >/dev/null
}

validate_root_directory /usr || {
    printf '%s\n' 'ERROR: /usr trust contract failed' >&2
    exit 1
}
validate_root_directory /usr/local || {
    printf '%s\n' 'ERROR: /usr/local trust contract failed' >&2
    exit 1
}
ensure_install_directory "$INSTALL_PARENT" || {
    printf '%s\n' 'ERROR: /usr/local/libexec trust contract failed' >&2
    exit 1
}
ensure_install_directory "$INSTALL_DIR" || {
    printf '%s\n' 'ERROR: Trivy install directory trust contract failed' >&2
    exit 1
}

if [ -e "$INSTALL_PATH" ] || [ -L "$INSTALL_PATH" ]; then
    verify_installed_binary || {
        printf '%s\n' 'ERROR: existing Trivy target is not the reviewed ARM64 binary' >&2
        exit 1
    }
    printf '%s\n' "Verified existing $INSTALL_PATH"
    exit 0
fi

temporary=$(/usr/bin/mktemp -d /var/tmp/diva-trivy-0.74.0.XXXXXXXX) || exit 1
case "$temporary" in /var/tmp/diva-trivy-0.74.0.*) ;;
    *) printf '%s\n' 'ERROR: unsafe temporary directory' >&2; exit 1 ;;
esac
staged="$INSTALL_DIR/.trivy-0.74.0.$$.staged"
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -n "${staged:-}" ]; then
        /usr/bin/rm -f -- "$staged" 2>/dev/null || true
    fi
    if [ -n "${temporary:-}" ]; then
        case "$temporary" in
            /var/tmp/diva-trivy-0.74.0.*) /usr/bin/rm -rf -- "$temporary" ;;
        esac
    fi
    exit "$status"
}
trap cleanup EXIT HUP INT TERM
[ ! -e "$staged" ] && [ ! -L "$staged" ] || {
    printf '%s\n' 'ERROR: staged Trivy target already exists' >&2
    exit 1
}

archive="$temporary/$TRIVY_ARCHIVE"
extract="$temporary/extract"
/usr/bin/mkdir --mode=0700 -- "$extract"
/usr/bin/curl --fail --show-error --silent --location \
    --connect-timeout 10 --max-time 600 --retry 2 \
    "$TRIVY_URL" --output "$archive"
[ "$(/usr/bin/sha256sum "$archive" | /usr/bin/awk '{print $1}')" \
    = "$TRIVY_ARCHIVE_SHA256" ] || {
    printf '%s\n' 'ERROR: Trivy ARM64 release archive digest is invalid' >&2
    exit 1
}
/usr/bin/tar --extract --gzip --file "$archive" --directory "$extract" \
    --no-same-owner --no-same-permissions trivy
verify_aarch64_elf "$extract/trivy" "$TRIVY_BINARY_SHA256" || {
    printf '%s\n' 'ERROR: extracted Trivy binary SHA or AArch64 ELF contract is invalid' >&2
    exit 1
}
version_output=$(/usr/bin/env -i HOME="$temporary" PATH=/usr/bin:/bin \
    "$extract/trivy" --version) || exit 1
printf '%s\n' "$version_output" | /usr/bin/grep -Fx \
    "Version: $TRIVY_VERSION" >/dev/null || {
    printf '%s\n' 'ERROR: extracted Trivy version is invalid' >&2
    exit 1
}

/usr/bin/install --owner=0 --group=0 --mode=0555 -- "$extract/trivy" "$staged"
/usr/bin/sync -f "$staged"
verify_binary_file_contract "$staged" "$TRIVY_BINARY_SHA256" 0:0:555:1
publish_staged_binary "$staged" "$INSTALL_PATH" "$INSTALL_DIR"
staged=
verify_installed_binary || {
    printf '%s\n' 'ERROR: published Trivy ARM64 binary failed final verification' >&2
    exit 1
}
printf '%s\n' "Installed and verified $INSTALL_PATH"
