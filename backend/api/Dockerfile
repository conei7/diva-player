FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine-extra@sha256:bfb8d74a4b0130c7e4abf88a4dede4f51929b91e26d76ae8ccf3f571a21db3b9 AS base
USER root
# The immutable base predates the Alpine fix for CVE-2026-14456.
RUN apk add --no-cache \
      libcrypto3=3.5.8-r0 \
      libssl3=3.5.8-r0
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
