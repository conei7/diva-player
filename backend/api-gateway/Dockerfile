FROM haproxy:3.0-alpine@sha256:34cc7d1f6142464d7d2b73e2a1eef7392556dbf304160aef543e513cfd9e5162

ARG HAPROXY_CONFIG=haproxy.cfg
USER root
RUN apk add --no-cache socat=1.8.1.3-r0
COPY --chown=haproxy:haproxy ${HAPROXY_CONFIG} /usr/local/etc/haproxy/haproxy.cfg
RUN chmod 0644 /usr/local/etc/haproxy/haproxy.cfg

EXPOSE 5000
USER haproxy
