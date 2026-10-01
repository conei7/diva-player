FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine-extra@sha256:bfb8d74a4b0130c7e4abf88a4dede4f51929b91e26d76ae8ccf3f571a21db3b9 AS base
USER root
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

FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine@sha256:8a80a27ddac789b4cb6d09d244f9c8d840da599c5ad22f7233c04be470e55261 AS build
WORKDIR /src
RUN test "$(dotnet --version)" = "8.0.424"
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
USER $APP_UID
ENTRYPOINT ["dotnet", "VocadbRecommender.dll"]
