FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 5000
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["VocadbRecommender/VocadbRecommender.csproj", "VocadbRecommender/"]
RUN dotnet restore "VocadbRecommender/VocadbRecommender.csproj"
COPY . .
WORKDIR "/src/VocadbRecommender"
RUN dotnet build "VocadbRecommender.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "VocadbRecommender.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "VocadbRecommender.dll"]
