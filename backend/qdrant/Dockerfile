FROM alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 AS audit-source

ARG DIVA_BUSYBOX_BINARY_SHA256
ARG DIVA_AUDIT_CONTRACT_SHA256
ARG DIVA_AUDIT_ARCH
ARG DIVA_AUDIT_CONTRACT_HELPER_SHA256
COPY --chown=0:0 audit-contract.sh /tmp/diva-audit-contract.sh
RUN set -eux; \
    audit=/opt/diva-audit-root; \
    apk_arch=$(apk --print-arch); \
    [ "$apk_arch" = "$DIVA_AUDIT_ARCH" ]; \
    case "$apk_arch" in \
      x86_64) \
        expected_busybox=f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62; \
        expected_contract=ecf630ad651e1e3b53d257b0d19e1aa2e2f28e543442218f4c3992b073425a61 ;; \
      aarch64) \
        expected_busybox=dd10691d81c84f0182f5af5f1583d566ddc0b9d0d9fc46b41b99b83c398306dd; \
        expected_contract=7c9d227469c7c5ffe8e1b407619bc4f132bdd68ca8d254a2be28ee458bfcc3aa ;; \
      *) exit 1 ;; \
    esac; \
    [ "$DIVA_BUSYBOX_BINARY_SHA256" = "$expected_busybox" ]; \
    [ "$DIVA_AUDIT_CONTRACT_SHA256" = "$expected_contract" ]; \
    [ "$DIVA_AUDIT_CONTRACT_HELPER_SHA256" = 05da48154d8001f2f97d707b98f4c5870c66a0909ad204adc3c6a34f7de4b6d8 ]; \
    [ "$(sha256sum /tmp/diva-audit-contract.sh | awk '{print $1}')" \
      = "$DIVA_AUDIT_CONTRACT_HELPER_SHA256" ]; \
    apk --root "$audit" --repositories-file /etc/apk/repositories \
      --keys-dir /etc/apk/keys --initdb --no-cache --no-scripts add \
      busybox=1.37.0-r30 busybox-binsh=1.37.0-r30 musl=1.2.5-r23; \
    ln -snf /bin/busybox "$audit/bin/sh"; \
    install -d -m 0755 "$audit/etc" "$audit/usr/share/diva-qdrant"; \
    apk --root "$audit" info -vv | LC_ALL=C sort \
      > "$audit/usr/share/diva-qdrant/audit-packages.txt"; \
    [ "$(sha256sum "$audit/usr/share/diva-qdrant/audit-packages.txt" | awk '{print $1}')" \
      = 3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53 ]; \
    [ "$($audit/bin/busybox 2>&1 | awk 'NR == 1 { print }')" \
      = 'BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' ]; \
    busybox_sha=$(sha256sum "$audit/bin/busybox" | awk '{print $1}'); \
    [ "$busybox_sha" = "$expected_busybox" ]; \
    for applet in awk chown cp find readlink sh sha256sum sort stat tr wc xargs; do \
      "$audit/bin/busybox" --list | grep -Fx "$applet" >/dev/null; \
      if [ "$applet" = sh ]; then \
        [ -L "$audit/bin/sh" ]; \
        [ "$(readlink "$audit/bin/sh")" = /bin/busybox ]; \
        link_type=symlink; \
      else \
        [ ! -e "$audit/bin/$applet" ]; \
        ln "$audit/bin/busybox" "$audit/bin/$applet"; \
        link_type=hardlink; \
      fi; \
      printf '%s\n' "$applet" >> "$audit/usr/share/diva-qdrant/audit-applets.txt"; \
      printf '%s:%s\n' "$applet" "$link_type" \
        >> "$audit/usr/share/diva-qdrant/audit-links.txt"; \
    done; \
    printf '%s\n' '3.23.3' > "$audit/etc/alpine-release"; \
    printf '%s\n' \
      'NAME="Alpine Linux"' 'ID=alpine' 'VERSION_ID=3.23.3' \
      'PRETTY_NAME="Alpine Linux v3.23"' 'HOME_URL="https://alpinelinux.org/"' \
      'BUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"' \
      > "$audit/etc/os-release"; \
    printf '%s\n' \
      'root:x:0:0:root:/:/bin/sh' \
      'nobody:x:65534:65534:nobody:/:/bin/false' > "$audit/etc/passwd"; \
    printf '%s\n' 'root:x:0:' 'nobody:x:65534:' > "$audit/etc/group"; \
    printf '%s\n' "$busybox_sha" > "$audit/usr/share/diva-qdrant/busybox-binary.sha256"; \
    printf '%s\n' 'BusyBox v1.37.0 (2025-12-16 14:19:28 UTC) multi-call binary.' \
      > "$audit/usr/share/diva-qdrant/busybox-version.txt"; \
    /bin/sh /tmp/diva-audit-contract.sh "$apk_arch" "$busybox_sha" \
      > "$audit/usr/share/diva-qdrant/audit-contract.txt"; \
    audit_contract_sha=$(sha256sum "$audit/usr/share/diva-qdrant/audit-contract.txt" \
      | awk '{print $1}'); \
    [ "$audit_contract_sha" = "$expected_contract" ]; \
    printf '%s\n' "$audit_contract_sha" > "$audit/usr/share/diva-qdrant/audit-contract.sha256"; \
    (cd "$audit" && find . -type f ! -path './usr/share/diva-qdrant/audit-files.sha256' \
      -print | LC_ALL=C sort | xargs sha256sum \
      > usr/share/diva-qdrant/audit-files.sha256); \
    chmod 0444 \
      "$audit/etc/alpine-release" "$audit/etc/os-release" \
      "$audit/etc/passwd" "$audit/etc/group" \
      "$audit/usr/share/diva-qdrant/audit-applets.txt" \
      "$audit/usr/share/diva-qdrant/audit-links.txt" \
      "$audit/usr/share/diva-qdrant/audit-contract.txt" \
      "$audit/usr/share/diva-qdrant/audit-contract.sha256" \
      "$audit/usr/share/diva-qdrant/audit-files.sha256" \
      "$audit/usr/share/diva-qdrant/audit-packages.txt" \
      "$audit/usr/share/diva-qdrant/busybox-binary.sha256" \
      "$audit/usr/share/diva-qdrant/busybox-version.txt"; \
    busybox_identity=$(stat -c '%d:%i' "$audit/bin/busybox"); \
    [ "$(stat -c '%u:%g:%a:%h' "$audit/bin/busybox")" = '0:0:755:12' ]; \
    for applet in awk chown cp find readlink sha256sum sort stat tr wc xargs; do \
      [ -f "$audit/bin/$applet" ] && [ ! -L "$audit/bin/$applet" ]; \
      [ "$(stat -c '%d:%i' "$audit/bin/$applet")" = "$busybox_identity" ]; \
      [ "$(stat -c '%u:%g:%a:%h' "$audit/bin/$applet")" = '0:0:755:12' ]; \
    done; \
    [ -L "$audit/bin/sh" ] && [ "$(readlink "$audit/bin/sh")" = /bin/busybox ]; \
    [ -f "$audit/lib/apk/db/installed" ] && [ ! -L "$audit/lib/apk/db/installed" ]; \
    [ "$(stat -c '%u:%g:%a:%h' "$audit/lib/apk/db/installed")" = '0:0:644:1' ]; \
    for directory in "$audit" "$audit/bin" "$audit/etc" "$audit/lib" \
      "$audit/lib/apk" "$audit/lib/apk/db" "$audit/usr" \
      "$audit/usr/share" "$audit/usr/share/diva-qdrant"; do \
      [ -d "$directory" ] && [ ! -L "$directory" ]; \
      [ "$(stat -c '%u:%g:%a' "$directory")" = '0:0:755' ]; \
    done

FROM qdrant/qdrant:v1.19.0-unprivileged@sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e AS source

USER root
# Upgrade only the pre-existing OpenSSL runtime packages to Debian's fixed
# CVE-2026-14456 build before selecting files for the final scratch image.
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends --only-upgrade \
      libssl3t64=3.5.7-1~deb13u2 \
      openssl-provider-legacy=3.5.7-1~deb13u2; \
    rm -rf /var/lib/apt/lists/*; \
    [ "$(dpkg-query -W -f='${Version}' libssl3t64)" = 3.5.7-1~deb13u2 ]; \
    [ "$(dpkg-query -W -f='${Version}' openssl-provider-legacy)" = 3.5.7-1~deb13u2 ]
RUN set -eux; \
    root=/opt/diva-runtime-root; \
    runtime_packages=/tmp/diva-runtime-packages; \
    : > "$runtime_packages"; \
    install -d -m 0755 "$root/qdrant" "$root/etc/ssl/certs" "$root/usr/share/zoneinfo"; \
    record_named_package() { \
      binary_package="$1"; package_list="$2"; \
      case "$binary_package" in ''|*[!a-z0-9+.-]*) exit 1 ;; esac; \
      [ "$(dpkg-query -W -f='${Status}' "$binary_package")" = 'install ok installed' ]; \
      printf '%s\n' "$binary_package" >> "$package_list"; \
    }; \
    record_package() { \
      requested_path="$1"; package_list="$2"; ownership=''; queried_path="$requested_path"; \
      ownership=$(dpkg-query -S -- "$queried_path" 2>/dev/null) || true; \
      if [ -z "$ownership" ]; then \
        case "$requested_path" in \
          /usr/*) alternate_path=${requested_path#/usr} ;; \
          /lib/*|/lib64/*) alternate_path=/usr$requested_path ;; \
          *) alternate_path= ;; \
        esac; \
        if [ -n "$alternate_path" ]; then \
          queried_path="$alternate_path"; \
          ownership=$(dpkg-query -S -- "$queried_path" 2>/dev/null) || true; \
        fi; \
      fi; \
      [ -n "$ownership" ]; \
      ownership_lines=$(printf '%s\n' "$ownership" | wc -l | tr -d '[:space:]'); \
      if [ "$ownership_lines" = 1 ]; then \
        binary_packages=$(printf '%s\n' "$ownership" \
          | awk -F ': ' -v expected_path="$queried_path" ' \
              NF != 2 || $2 != expected_path { exit 1 } \
              { \
                owner_field = $1; \
                if (owner_field !~ /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9][a-z0-9-]*)?(, [a-z0-9][a-z0-9+.-]*(:[a-z0-9][a-z0-9-]*)?)*$/) exit 1; \
                package_count = split(owner_field, package_names, ", "); \
                if (package_count < 1) exit 1; \
                for (package_index = 1; package_index <= package_count; package_index++) { \
                  sub(/:[a-z0-9][a-z0-9-]*$/, "", package_names[package_index]); \
                  if (package_names[package_index] !~ /^[a-z0-9][a-z0-9+.-]*$/) exit 1; \
                  if (package_names[package_index] in seen_packages) exit 1; \
                  seen_packages[package_names[package_index]] = 1; \
                  print package_names[package_index]; \
                } \
              }'); \
        [ -n "$binary_packages" ]; \
        package_count=$(printf '%s\n' "$binary_packages" | wc -l | tr -d '[:space:]'); \
        unique_package_count=$(printf '%s\n' "$binary_packages" \
          | LC_ALL=C sort -u | wc -l | tr -d '[:space:]'); \
        [ "$package_count" = "$unique_package_count" ]; \
      else \
        # Debian usrmerge represents both a legacy top-level library link and \
        # its direct dynamic-loader link with one exact diversion pair.  The \
        # two layouts use different hidden sibling names, object types, and \
        # package owners; derive and verify every one of those properties. \
        [ "$ownership_lines" = 2 ]; \
        diversion_package=$(printf '%s\n' "$ownership" \
          | awk '/^diversion by [^ ]+ from: / { sub(/^diversion by /, ""); sub(/ from: .*/, ""); print }'); \
        diversion_to_package=$(printf '%s\n' "$ownership" \
          | awk '/^diversion by [^ ]+ to: / { sub(/^diversion by /, ""); sub(/ to: .*/, ""); print }'); \
        [ -n "$diversion_package" ] && [ "$diversion_to_package" = "$diversion_package" ]; \
        diversion_binary_package=${diversion_package%%:*}; \
        case "$diversion_binary_package" in \
          [a-z0-9]*) ;; \
          *) exit 1 ;; \
        esac; \
        case "$diversion_binary_package" in *[!a-z0-9+.-]*) exit 1 ;; esac; \
        case "$diversion_package" in \
          *:*) \
            diversion_architecture=${diversion_package#*:}; \
            case "$diversion_architecture" in \
              [a-z0-9]*) ;; \
              *) exit 1 ;; \
            esac; \
            case "$diversion_architecture" in *[!a-z0-9-]*) exit 1 ;; esac; \
            [ "$diversion_package" = "$diversion_binary_package:$diversion_architecture" ]; \
            ;; \
          *) ;; \
        esac; \
        diversion_directory=${queried_path%/*}; \
        diversion_basename=${queried_path##*/}; \
        [ -n "$diversion_basename" ] \
          && [ "$diversion_directory/$diversion_basename" = "$queried_path" ]; \
        case "$queried_path" in \
          /lib|/lib64) \
            [ -z "$diversion_directory" ]; \
            expected_diversion_path="/.$diversion_basename.usr-is-merged"; \
            expected_diversion_package=base-files; \
            diversion_object_type=directory; \
            ;; \
          /lib/*|/lib64/*) \
            case "$diversion_directory" in /lib|/lib64) ;; *) exit 1 ;; esac; \
            case "$diversion_basename" in \
              [a-zA-Z0-9]*) ;; \
              *) exit 1 ;; \
            esac; \
            case "$diversion_basename" in *[!a-zA-Z0-9+._-]*) exit 1 ;; esac; \
            expected_diversion_path="$queried_path.usr-is-merged"; \
            expected_diversion_package=libc6; \
            diversion_object_type=file; \
            ;; \
          *) exit 1 ;; \
        esac; \
        [ "$diversion_binary_package" = "$expected_diversion_package" ]; \
        [ "$(printf '%s\n' "$ownership" | grep -Fxc \
          "diversion by $diversion_package from: $queried_path")" = 1 ]; \
        [ "$(printf '%s\n' "$ownership" | grep -Fxc \
          "diversion by $diversion_package to: $expected_diversion_path")" = 1 ]; \
        divert_owner=$(dpkg-divert --listpackage "$queried_path"); \
        divert_truename=$(dpkg-divert --truename "$queried_path"); \
        [ "$divert_owner" = "$diversion_package" ]; \
        [ "$divert_truename" = "$expected_diversion_path" ]; \
        resolved_path=$(readlink -f "$queried_path"); \
        case "$diversion_object_type" in \
          directory) \
            [ "$resolved_path" = "/usr$queried_path" ]; \
            [ -d "$resolved_path" ] && [ ! -L "$resolved_path" ]; \
            [ "$(stat -c '%u:%g:%a' "$resolved_path")" = '0:0:755' ]; \
            ;; \
          file) \
            normalized_legacy_path=/usr$queried_path; \
            [ -L "$queried_path" ] && [ -L "$normalized_legacy_path" ]; \
            [ "$(stat -c '%u:%g:%a:%h' "$queried_path")" = '0:0:777:1' ]; \
            [ "$(stat -c '%u:%g:%a:%h' "$normalized_legacy_path")" = '0:0:777:1' ]; \
            [ "$(readlink "$queried_path")" = "$(readlink "$normalized_legacy_path")" ]; \
            [ "$(readlink -f "$normalized_legacy_path")" = "$resolved_path" ]; \
            case "$resolved_path" in /usr/lib/*|/usr/lib64/*) ;; *) exit 1 ;; esac; \
            [ -f "$resolved_path" ] && [ ! -L "$resolved_path" ]; \
            [ "$(stat -c '%u:%g:%a:%h' "$resolved_path")" = '0:0:755:1' ]; \
            ;; \
          *) exit 1 ;; \
        esac; \
        resolved_ownership=$(dpkg-query -S -- "$resolved_path" 2>/dev/null); \
        [ "$(printf '%s\n' "$resolved_ownership" | wc -l | tr -d '[:space:]')" = 1 ]; \
        resolved_package=$(printf '%s\n' "$resolved_ownership" \
          | awk -F ': ' -v expected_path="$resolved_path" ' \
              NF != 2 || $2 != expected_path { exit 1 } \
              $1 !~ /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9][a-z0-9-]*)?$/ { exit 1 } \
              { print $1 }'); \
        [ -n "$resolved_package" ]; \
        binary_packages=$diversion_binary_package; \
        [ "${resolved_package%%:*}" = "$binary_packages" ]; \
      fi; \
      for binary_package in $binary_packages; do \
        record_named_package "$binary_package" "$package_list"; \
      done; \
    }; \
    copy_library() { \
      library="$1"; target_root="$2"; package_list="$3"; \
      [ -n "$library" ] && [ -f "$library" ]; \
      record_package "$library" "$package_list"; \
      case "$library" in \
        /lib/*|/lib64/*) normalized_library=/usr$library ;; \
        /usr/lib/*|/usr/lib64/*) normalized_library=$library ;; \
        *) exit 1 ;; \
      esac; \
      [ -e "$normalized_library" ] || [ -L "$normalized_library" ]; \
      record_package "$normalized_library" "$package_list"; \
      cp -a --parents "$normalized_library" "$target_root"; \
      resolved_library=$(readlink -f "$library"); \
      [ -n "$resolved_library" ] && [ -f "$resolved_library" ]; \
      record_package "$resolved_library" "$package_list"; \
      if [ "$resolved_library" != "$normalized_library" ]; then \
        cp -a --parents "$resolved_library" "$target_root"; \
      fi; \
    }; \
    copy_dependencies() { \
      executable="$1"; target_root="$2"; package_list="$3"; \
      ldd "$executable" \
        | awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }' \
        | LC_ALL=C sort -u \
        | while IFS= read -r library; do \
            copy_library "$library" "$target_root" "$package_list"; \
          done; \
    }; \
    copy_os_metadata() { \
      target_root="$1"; package_list="$2"; \
      for metadata_path in /etc/os-release /etc/debian_version; do \
        resolved_metadata=$(readlink -f "$metadata_path"); \
        [ -n "$resolved_metadata" ] && [ -f "$resolved_metadata" ]; \
        record_package "$resolved_metadata" "$package_list"; \
        install -D -m 0444 "$resolved_metadata" "$target_root$metadata_path"; \
      done; \
    }; \
    install_usrmerge_link() { \
      source_link="$1"; expected_target="$2"; target_root="$3"; package_list="$4"; \
      [ -L "$source_link" ] && [ "$(readlink "$source_link")" = "$expected_target" ]; \
      record_package "$source_link" "$package_list"; \
      source_target=/$expected_target; \
      [ -d "$source_target" ] && [ ! -L "$source_target" ]; \
      [ "$(stat -c '%u:%g:%a' "$source_target")" = '0:0:755' ]; \
      # Only the empty destination directory is materialized below.  Do not \
      # claim every package which happens to co-own Debian's generic /usr/lib \
      # directory as copied runtime content. \
      if [ ! -e "$target_root/$expected_target" ]; then \
        install -d -m 0755 "$target_root/$expected_target"; \
      fi; \
      [ -d "$target_root/$expected_target" ] && [ ! -L "$target_root/$expected_target" ]; \
      [ "$(stat -c '%u:%g:%a' "$target_root/$expected_target")" = '0:0:755' ]; \
      [ ! -e "$target_root$source_link" ] && [ ! -L "$target_root$source_link" ]; \
      ln -s "$expected_target" "$target_root$source_link"; \
    }; \
    write_package_inventory() { \
      package_list="$1"; target_root="$2"; manifest_name="$3"; \
      LC_ALL=C sort -u "$package_list" -o "$package_list"; \
      [ -s "$package_list" ]; \
      install -d -m 0755 "$target_root/var/lib/dpkg" "$target_root/usr/share/diva-qdrant"; \
      : > "$target_root/var/lib/dpkg/status"; \
      : > "$target_root/usr/share/diva-qdrant/$manifest_name"; \
      while IFS= read -r binary_package; do \
        package_name=$(dpkg-query -W -f='${Package}' "$binary_package"); \
        package_status=$(dpkg-query -W -f='${Status}' "$binary_package"); \
        package_version=$(dpkg-query -W -f='${Version}' "$binary_package"); \
        package_arch=$(dpkg-query -W -f='${Architecture}' "$binary_package"); \
        source_package=$(dpkg-query -W -f='${source:Package}' "$binary_package"); \
        source_version=$(dpkg-query -W -f='${source:Version}' "$binary_package"); \
        [ "$package_status" = 'install ok installed' ]; \
        printf 'Package: %s\nStatus: %s\nArchitecture: %s\n' \
          "$package_name" "$package_status" "$package_arch" \
          >> "$target_root/var/lib/dpkg/status"; \
        if [ -n "$source_package" ]; then \
          if [ -n "$source_version" ]; then \
            printf 'Source: %s (%s)\n' "$source_package" "$source_version" \
              >> "$target_root/var/lib/dpkg/status"; \
          else \
            printf 'Source: %s\n' "$source_package" \
              >> "$target_root/var/lib/dpkg/status"; \
          fi; \
        fi; \
        printf 'Version: %s\n\n' "$package_version" >> "$target_root/var/lib/dpkg/status"; \
        printf '%s\t%s\t%s\t%s\t%s\n' \
          "$package_name" "$source_package" "$source_version" "$package_version" "$package_arch" \
          >> "$target_root/usr/share/diva-qdrant/$manifest_name"; \
      done < "$package_list"; \
      chmod 0444 "$target_root/var/lib/dpkg/status" \
        "$target_root/usr/share/diva-qdrant/$manifest_name"; \
    }; \
    install -m 0555 /qdrant/qdrant "$root/qdrant/qdrant"; \
    cp -a /qdrant/config "$root/qdrant/config"; \
    [ -f /etc/ssl/certs/ca-certificates.crt ]; \
    # The bundle is deterministically generated by the installed
    # ca-certificates package and is intentionally not owned as a dpkg path.
    record_named_package ca-certificates "$runtime_packages"; \
    cp -a /etc/ssl/certs/ca-certificates.crt "$root/etc/ssl/certs/ca-certificates.crt"; \
    [ -f /usr/share/zoneinfo/UTC ]; \
    record_package /usr/share/zoneinfo/UTC "$runtime_packages"; \
    cp -a /usr/share/zoneinfo/UTC "$root/usr/share/zoneinfo/UTC"; \
    copy_dependencies /qdrant/qdrant "$root" "$runtime_packages"; \
    find /lib /usr/lib -xdev \
      \( -name 'libnss_dns.so.2' -o -name 'libnss_files.so.2' \) -print \
      | LC_ALL=C sort -u \
      | while IFS= read -r library; do \
          copy_library "$library" "$root" "$runtime_packages"; \
        done; \
    install_usrmerge_link /lib usr/lib "$root" "$runtime_packages"; \
    install_usrmerge_link /lib64 usr/lib64 "$root" "$runtime_packages"; \
    interpreter=$(ldd /qdrant/qdrant \
      | awk '/^[[:space:]]*\/.*ld-linux/ { print $1; exit }'); \
    [ -n "$interpreter" ]; \
    case "$interpreter" in /lib/*|/lib64/*) ;; *) exit 1 ;; esac; \
    resolved_interpreter=$(readlink -f "$root$interpreter"); \
    [ -n "$resolved_interpreter" ] && [ -f "$resolved_interpreter" ]; \
    case "$resolved_interpreter" in "$root"/usr/lib/*|"$root"/usr/lib64/*) ;; *) exit 1 ;; esac; \
    copy_os_metadata "$root" "$runtime_packages"; \
    write_package_inventory "$runtime_packages" "$root" runtime-packages.tsv; \
    find "$root/qdrant/config" -type d -exec chmod 0555 {} +; \
    find "$root/qdrant/config" -type f -exec chmod 0444 {} +; \
    (cd "$root" && sha256sum qdrant/qdrant | awk '{print $1}' \
      > usr/share/diva-qdrant/qdrant-binary.sha256); \
    (cd "$root" && find qdrant/config -type f -print0 | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum -b -z \
      > usr/share/diva-qdrant/qdrant-config-files.sha256); \
    (cd "$root" && sha256sum usr/share/diva-qdrant/qdrant-config-files.sha256 \
      | awk '{print $1}' > usr/share/diva-qdrant/qdrant-config-tree.sha256); \
    (cd "$root" && sha256sum etc/ssl/certs/ca-certificates.crt | awk '{print $1}' \
      > usr/share/diva-qdrant/ca-certificates-bundle.sha256); \
    { \
      printf '%s\n' '/lib=usr/lib' '/lib64=usr/lib64'; \
      printf 'interpreter=%s\n' "$interpreter"; \
      printf 'resolved_interpreter=/%s\n' "${resolved_interpreter#"$root"/}"; \
    } > "$root/usr/share/diva-qdrant/runtime-links.txt"; \
    (cd "$root" && { find qdrant -type f -print0; \
        printf 'etc/ssl/certs/ca-certificates.crt\0'; } | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum -b -z \
      > usr/share/diva-qdrant/application-files.sha256); \
    chmod 0444 "$root/usr/share/diva-qdrant/application-files.sha256" \
      "$root/usr/share/diva-qdrant/qdrant-binary.sha256" \
      "$root/usr/share/diva-qdrant/qdrant-config-files.sha256" \
      "$root/usr/share/diva-qdrant/qdrant-config-tree.sha256" \
      "$root/usr/share/diva-qdrant/ca-certificates-bundle.sha256" \
      "$root/usr/share/diva-qdrant/runtime-links.txt"; \
    test -x "$root/qdrant/qdrant"; \
    test ! -e "$root/qdrant/static"; \
    test ! -e "$root/bin/sh"; \
    test -L "$root/lib" && test "$(readlink "$root/lib")" = usr/lib; \
    test -L "$root/lib64" && test "$(readlink "$root/lib64")" = usr/lib64; \
    test -s "$root/var/lib/dpkg/status"; \
    test -s "$root/usr/share/diva-qdrant/runtime-packages.tsv"

# This target is never published or attached to a network.  It is a pinned,
# exact toolbox used only while the legacy volume is stopped for read-only
# fingerprinting and candidate-only clone/ownership conversion.
FROM scratch AS audit-tools
ARG DIVA_QDRANT_DOCKERFILE_SHA256
ARG DIVA_QDRANT_BUILD_TIMESTAMP
ARG DIVA_BUSYBOX_BINARY_SHA256
ARG DIVA_AUDIT_CONTRACT_SHA256
ARG DIVA_AUDIT_ARCH
ARG DIVA_AUDIT_CONTRACT_HELPER_SHA256
COPY --from=audit-source --chown=0:0 /opt/diva-audit-root/ /
LABEL com.diva.qdrant.base-digest="sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659" \
      com.diva.qdrant.base-reference="alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659" \
      com.diva.qdrant.dockerfile-sha256="${DIVA_QDRANT_DOCKERFILE_SHA256}" \
      com.diva.qdrant.build-timestamp="${DIVA_QDRANT_BUILD_TIMESTAMP}" \
      com.diva.qdrant.audit-contract="offline-storage-audit-v3-alpine" \
      com.diva.qdrant.audit-contract-sha256="${DIVA_AUDIT_CONTRACT_SHA256}" \
      com.diva.qdrant.audit-contract-helper-sha256="${DIVA_AUDIT_CONTRACT_HELPER_SHA256}" \
      com.diva.qdrant.alpine-inventory-sha256="3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53" \
      com.diva.qdrant.audit-architecture="${DIVA_AUDIT_ARCH}" \
      com.diva.qdrant.busybox-version="1.37.0-r30" \
      com.diva.qdrant.busybox-binary-sha256="${DIVA_BUSYBOX_BINARY_SHA256}"
ENV PATH="/bin" LANG="C" LC_ALL="C"
USER 65534:65534
ENTRYPOINT ["/bin/sh"]

FROM scratch AS runtime
ARG DIVA_QDRANT_DOCKERFILE_SHA256
ARG DIVA_QDRANT_BUILD_TIMESTAMP
COPY --from=source --chown=0:0 /opt/diva-runtime-root/ /
LABEL com.diva.qdrant.base-digest="sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e" \
      com.diva.qdrant.base-reference="qdrant/qdrant:v1.19.0-unprivileged@sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e" \
      com.diva.qdrant.dockerfile-sha256="${DIVA_QDRANT_DOCKERFILE_SHA256}" \
      com.diva.qdrant.build-timestamp="${DIVA_QDRANT_BUILD_TIMESTAMP}" \
      com.diva.qdrant.runtime-contract="rootless-readonly-scratch-v3"
ENV QDRANT__STORAGE__SNAPSHOTS_PATH="/qdrant/storage/snapshots" \
    QDRANT__TELEMETRY_DISABLED="true"
WORKDIR /qdrant
USER 1000:1000
EXPOSE 6333 6334 6335
STOPSIGNAL SIGTERM
ENTRYPOINT ["/qdrant/qdrant"]
CMD ["--config-path", "/qdrant/config/production.yaml"]
