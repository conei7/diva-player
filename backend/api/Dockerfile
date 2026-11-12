FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine-extra@sha256:7f6b42fa9184cd957682c0be4cb4f27ad40286db3cd4d7a66c317e49ca92ad5b AS base
USER root
RUN dotnet --list-runtimes | grep -F 'Microsoft.AspNetCore.App 8.0.34 ' && \
    dotnet --list-runtimes | grep -F 'Microsoft.NETCore.App 8.0.34 '
# CVE-2026-107891: upgrade the pinned Alpine runtime with signed, checksummed APKs.
RUN set -eux; \
    case "$(cat /etc/alpine-release)" in 3.24.*) ;; *) exit 1 ;; esac; \
    arch="$(apk --print-arch)"; \
    case "$arch" in \
      x86_64) musl_sha=e142255d0fa397f14318996bc10378093dcc069dc3dd1b6818c8f28a789c21da; musl_utils_sha=47263d05842c5e12d01e0369e5b5bea51733323501c00ca21968a5102de137ca ;; \
      aarch64) musl_sha=2e17864102278d9049c3a56f1bceed9e8cf287065617e579325123443daed8a5; musl_utils_sha=bb460bdc009e88989bd5adca8a7c8298c339cba99da11c6196c818e042fbaf49 ;; \
      *) exit 1 ;; \
    esac; \
    wget -O /tmp/musl.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$arch/musl-1.2.6-r3.apk"; \
    echo "$musl_sha  /tmp/musl.apk" | sha256sum -c -; \
    wget -O /tmp/musl-utils.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$arch/musl-utils-1.2.6-r3.apk"; \
    echo "$musl_utils_sha  /tmp/musl-utils.apk" | sha256sum -c -; \
    apk add --no-network /tmp/musl.apk /tmp/musl-utils.apk; \
    for package in musl musl-utils; do \
      test "$(awk -F: -v package="$package" '$1=="P"{p=($2==package);next} p && $1=="V"{print $2;exit}' /lib/apk/db/installed)" = 1.2.6-r3; \
    done; \
    rm /tmp/musl.apk /tmp/musl-utils.apk
# Use checksummed APKs directly: a stale mirror index must not downgrade OpenSSL.
RUN set -eux; \
    case "$(cat /etc/alpine-release)" in 3.24.*) ;; *) exit 1 ;; esac; \
    arch="$(apk --print-arch)"; \
    case "$arch" in \
      x86_64) crypto_sha=6632d758d8f5e9ea3b650fe966f23bbf9a202f8b8dceecac93da135dec5e3689; ssl_sha=05e3393fb95aa5751ca2f9d242f659f6cff82c1cc7767cc2df4a086f7ad01877 ;; \
      aarch64) crypto_sha=2676a2b0b6e23ea2edccf3ee982b9842a665d52603d047de3d0a185dc316d983; ssl_sha=20ac252b276d73f2c69c1d25f84537c7fba81caefc026c6be1094b394af2082e ;; \
      *) exit 1 ;; \
    esac; \
    wget -O /tmp/libcrypto3-3.5.9-r0.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$arch/libcrypto3-3.5.9-r0.apk"; \
    echo "$crypto_sha  /tmp/libcrypto3-3.5.9-r0.apk" | sha256sum -c -; \
    wget -O /tmp/libssl3-3.5.9-r0.apk "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$arch/libssl3-3.5.9-r0.apk"; \
    echo "$ssl_sha  /tmp/libssl3-3.5.9-r0.apk" | sha256sum -c -; \
    apk add --no-network /tmp/libcrypto3-3.5.9-r0.apk /tmp/libssl3-3.5.9-r0.apk; \
    rm /tmp/libcrypto3-3.5.9-r0.apk /tmp/libssl3-3.5.9-r0.apk
# The immutable base predates the Alpine fix for CVE-2026-14456.
RUN apk add --no-cache \
      libcrypto3=3.5.9-r0 \
      libssl3=3.5.9-r0
WORKDIR /app
EXPOSE 5000

FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine@sha256:4f4992f8f302150e4adb5e78c324731e968493a30c0638985ba29cb42a858cd6 AS build
WORKDIR /src
RUN test "$(dotnet --version)" = "8.0.428"
COPY ["VocadbRecommender/VocadbRecommender.csproj", "VocadbRecommender/packages.lock.json", "VocadbRecommender/"]
RUN dotnet restore "VocadbRecommender/VocadbRecommender.csproj" --locked-mode
COPY . .
WORKDIR "/src/VocadbRecommender"
RUN dotnet build "VocadbRecommender.csproj" -c Release -o /app/build --no-restore

FROM build AS publish
RUN dotnet publish "VocadbRecommender.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
RUN mkdir -p /var/cache/diva-player/group-map && chown "$APP_UID:$APP_UID" /var/cache/diva-player/group-map
USER $APP_UID
ENTRYPOINT ["dotnet", "VocadbRecommender.dll"]
