FROM haproxy:3.0-alpine

USER root
RUN apk add --no-cache curl socat
COPY haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg

EXPOSE 5000
USER haproxy
