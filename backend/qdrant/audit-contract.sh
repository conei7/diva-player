#!/bin/sh
set -eu

[ "$#" -eq 2 ]
architecture=$1
busybox_sha256=$2

case "$architecture" in
    x86_64)
        expected_busybox=f3547b3d78d08a028a4833ddb83b77cf012838c078bfd2b76355f53d1d8bba62
        ;;
    aarch64)
        expected_busybox=dd10691d81c84f0182f5af5f1583d566ddc0b9d0d9fc46b41b99b83c398306dd
        ;;
    *) exit 64 ;;
esac
[ "$busybox_sha256" = "$expected_busybox" ]

# This is the sole byte builder for the audit contract.  The Docker build,
# privileged hardener and deterministic tests all execute this exact tracked
# file instead of independently assembling equivalent-looking text.
printf '%s\n' \
    'schema=4' \
    'alpine_index_digest=sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659' \
    'alpine_release=3.23.3' \
    'alpine_inventory_sha256=3f18c4f5c16154eeba3ffd4970bf886c1699a3b901a3ddcf7948f99a8d2b8c53' \
    "architecture=$architecture" \
    "busybox_binary_sha256=$busybox_sha256" \
    'busybox_package_version=1.37.0-r30' \
    'user=65534:65534' \
    'busybox_link_count=12' \
    'hardlink_owner=0:0' \
    'hardlink_mode=755' \
    'sh_symlink=/bin/busybox' \
    'apk_database=/lib/apk/db/installed' \
    'directory_ancestry=/,/bin,/etc,/lib,/lib/apk,/lib/apk/db,/usr,/usr/share,/usr/share/diva-qdrant' \
    'directory_owner=0:0' \
    'directory_mode=755' \
    'applets=awk,chown,cp,find,readlink,sh,sha256sum,sort,stat,tr,wc,xargs' \
    'links=awk:hardlink,chown:hardlink,cp:hardlink,find:hardlink,readlink:hardlink,sh:symlink,sha256sum:hardlink,sort:hardlink,stat:hardlink,tr:hardlink,wc:hardlink,xargs:hardlink'
