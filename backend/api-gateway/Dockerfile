FROM haproxy:3.0-alpine@sha256:34cc7d1f6142464d7d2b73e2a1eef7392556dbf304160aef543e513cfd9e5162

ARG HAPROXY_CONFIG=haproxy.cfg
USER root
# Bind the ARM and x86 packages independently; the pinned base has old PCRE2 (ARM) and zlib.
RUN set -eux; \
    case "$(cat /etc/alpine-release)" in 3.24.*) ;; *) exit 1 ;; esac; \
    case "$(apk --print-arch)" in \
      x86_64) package_sha=2919897914820f42a17a8d7d37df310d2dfad1c82ebe5f539cc5c765f916752a; zlib_sha=63aeea03c15a2f9018f81805cfc8aa926bdf5cd68921f22149c2fbb5d0ee9f47 ;; \
      aarch64) package_sha=03efd0b29f7f38deb10a9ccb54f56e19683eb7ac27eb1f347e6dbd2e59ea000d; zlib_sha=1f77a542ac6634761b9fe38d8bdca19b154071dcfa25432e73f2bc8a0740a33f ;; \
      *) exit 1 ;; \
    esac; \
    wget -O /tmp/pcre2.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$(apk --print-arch)/pcre2-10.49-r0.apk"; \
    echo "$package_sha  /tmp/pcre2.apk" | sha256sum -c -; \
    wget -O /tmp/zlib.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$(apk --print-arch)/zlib-1.3.2-r1.apk"; \
    echo "$zlib_sha  /tmp/zlib.apk" | sha256sum -c -; \
    apk add --no-network /tmp/pcre2.apk /tmp/zlib.apk; \
    test "$(awk '$0=="P:pcre2"{p=1;next} p && /^V:/{print substr($0,3);exit}' /lib/apk/db/installed)" = 10.49-r0; \
    test "$(awk '$0=="P:zlib"{p=1;next} p && /^V:/{print substr($0,3);exit}' /lib/apk/db/installed)" = 1.3.2-r1; \
    rm /tmp/pcre2.apk /tmp/zlib.apk
RUN apk add --no-cache socat=1.8.1.3-r0
COPY --chown=haproxy:haproxy ${HAPROXY_CONFIG} /usr/local/etc/haproxy/haproxy.cfg
RUN chmod 0644 /usr/local/etc/haproxy/haproxy.cfg

EXPOSE 5000
USER haproxy
RUN GATEWAY_PROXY_KEY=build-time-config-validation-only \
    haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
