using Microsoft.AspNetCore.ResponseCompression;
using VocadbRecommender.Services;

internal static class ApiServiceRegistration
{
    public static IServiceCollection AddDivaApiServices(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.Configure<RecommenderOptions>(configuration.GetSection("Recommender"));
        services.AddMemoryCache();
        services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["application/json"]);
        });
        services.AddSingleton<DbService>();
        services.AddSingleton<QdrantService>();
        services.AddSingleton<ApiWarmupState>();
        services.AddHostedService<ApiWarmupService>();
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
