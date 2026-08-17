using Microsoft.AspNetCore.ResponseCompression;
using VocadbRecommender.Services;

internal static class ApiServiceRegistration
{
    public static IServiceCollection AddDivaApiServices(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<RecommenderOptions>()
            .Bind(configuration.GetSection("Recommender"))
            .Validate(
                options => new[]
                    {
                        options.CollectionNamed,
                        options.CollectionHybrid,
                        options.CollectionMetadata,
                        options.CollectionAudio,
                    }
                    .All(name => !string.IsNullOrWhiteSpace(name))
                    && new[]
                    {
                        options.CollectionNamed,
                        options.CollectionHybrid,
                        options.CollectionMetadata,
                        options.CollectionAudio,
                    }.Distinct(StringComparer.Ordinal).Count() == 4,
                "Recommender collection names must be non-empty and distinct")
            .Validate(
                options => options.SearchCacheSizeMiB > 0,
                "Recommender:SearchCacheSizeMiB must be positive")
            .Validate(
                options => options.SearchCacheEntrySizeMiB > 0
                    && options.SearchCacheEntrySizeMiB <= options.SearchCacheSizeMiB,
                "Recommender:SearchCacheEntrySizeMiB must be positive and no larger than SearchCacheSizeMiB")
            .Validate(
                options => options.ObjectCacheSizeMiB > 0,
                "Recommender:ObjectCacheSizeMiB must be positive")
            .Validate(
                options => options.ObjectCacheEntrySizeMiB > 0
                    && options.ObjectCacheEntrySizeMiB <= options.ObjectCacheSizeMiB,
                "Recommender:ObjectCacheEntrySizeMiB must be positive and no larger than ObjectCacheSizeMiB")
            .ValidateOnStart();
        services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["application/json"]);
        });
        services.AddSingleton<SearchResponseCache>();
        services.AddSingleton<RecommendationObjectCache>();
        services.AddSingleton<DbService>();
        services.AddSingleton<RecommendationPublicationGuard>();
        services.AddSingleton<QdrantService>();
        services.AddSingleton<ApiWarmupState>();
        services.AddHostedService<ApiWarmupService>();
        services.AddSingleton<ApiReadinessProbeState>();
        services.AddHostedService<ApiReadinessProbeService>();
        services.AddHostedService<ApiRuntimeTelemetryService>();
        services.AddSingleton<MarkovService>();
        services.AddScoped<RecommendService>();
        services.AddScoped<DigDiscoveryService>();
        services.AddHttpClient<YouTubePlaylistService>(client =>
        {
            client.BaseAddress = new Uri("https://www.googleapis.com/youtube/v3/");
            client.Timeout = TimeSpan.FromSeconds(30);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("DIVA-Player/1.0");
        });
        services.AddHttpClient<NicoPlaylistService>(client =>
        {
            client.BaseAddress = new Uri("https://nvapi.nicovideo.jp/");
            client.Timeout = TimeSpan.FromSeconds(30);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("DIVA-Player/1.0");
            client.DefaultRequestHeaders.Add("X-Frontend-Id", "6");
            client.DefaultRequestHeaders.Add("X-Frontend-Version", "0");
        });
        return services;
    }
}
