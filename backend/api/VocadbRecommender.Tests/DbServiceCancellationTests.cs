using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class DbServiceCancellationTests
{
    [Theory]
    [InlineData(nameof(DbService.CheckHealthAsync))]
    [InlineData(nameof(DbService.CheckDiscoveryQualityAsync))]
    [InlineData(nameof(DbService.CheckAudioFeatureHealthAsync))]
    [InlineData(nameof(DbService.GetKnowledgeMapCatalogAsync))]
    [InlineData(nameof(DbService.GetKnowledgeMapSongsAsync))]
    [InlineData(nameof(DbService.GetYouTubePlaylistCacheAsync))]
    [InlineData(nameof(DbService.UpsertYouTubePlaylistCacheAsync))]
    [InlineData(nameof(DbService.GetSongsByYouTubeVideoIdsAsync))]
    [InlineData(nameof(DbService.GetNicoPlaylistCacheAsync))]
    [InlineData(nameof(DbService.UpsertNicoPlaylistCacheAsync))]
    [InlineData(nameof(DbService.GetSongsByNicoVideoIdsAsync))]
    [InlineData(nameof(DbService.SearchSongsAsync))]
    [InlineData(nameof(DbService.SearchTagsAsync))]
    [InlineData(nameof(DbService.GetSongsJsonByIdsAsync))]
    [InlineData(nameof(DbService.GetSongsCardJsonByIdsAsync))]
    [InlineData(nameof(DbService.GetExternalViewCountsAsync))]
    [InlineData(nameof(DbService.GetSongInfoAsync))]
    [InlineData(nameof(DbService.GetSongInfoBatchAsync))]
    [InlineData(nameof(DbService.GetMetadataRelationshipCandidateIdsAsync))]
    [InlineData(nameof(DbService.GetDiverseFallbackCandidateIdsAsync))]
    [InlineData(nameof(DbService.GetViewHistoryAsync))]
    [InlineData(nameof(DbService.GetViewHistoryWindowAsync))]
    [InlineData(nameof(DbService.GetTrendingSongsJsonAsync))]
    [InlineData(nameof(DbService.LoadMarkovMatrixAsync))]
    [InlineData(nameof(DbService.GetSongsByProducersAsync))]
    [InlineData(nameof(DbService.GetSongsByProducerAsync))]
    public void RequestAwareMethods_ExposeCancellationToken(string methodName)
    {
        var method = typeof(DbService).GetMethods()
            .Single(candidate => candidate.Name == methodName);

        Assert.Equal(typeof(CancellationToken), method.GetParameters()[^1].ParameterType);
    }

    [Fact]
    public async Task PreCanceledRequest_IsNotConvertedToHealthFailure()
    {
        using var objectCache = CreateObjectCache();
        using var searchCache = CreateSearchCache();
        var service = CreateService(objectCache, searchCache);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Func<Task>[] healthChecks =
        [
            () => service.CheckHealthAsync(cancellation.Token),
            () => service.CheckDiscoveryQualityAsync(cancellation.Token),
            () => service.CheckAudioFeatureHealthAsync(cancellation.Token),
        ];

        foreach (var healthCheck in healthChecks)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(healthCheck);
    }

    [Fact]
    public async Task PreCanceledRequest_StopsCachedWaitsAndDirectSongReads()
    {
        using var objectCache = CreateObjectCache();
        using var searchCache = CreateSearchCache();
        var service = CreateService(objectCache, searchCache);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Func<Task>[] operations =
        [
            () => service.SearchSongsAsync(
                null,
                null,
                null,
                null,
                null,
                null,
                "AdditionDate",
                "desc",
                0,
                24,
                cancellationToken: cancellation.Token),
            () => service.GetTrendingSongsJsonAsync(
                30,
                0,
                24,
                cancellationToken: cancellation.Token),
            () => service.GetSongsJsonByIdsAsync([1], cancellation.Token),
            () => service.GetSongsCardJsonByIdsAsync([1], cancellation.Token),
            () => service.GetSongInfoAsync(1, cancellation.Token),
            () => service.GetSongInfoBatchAsync([1], cancellation.Token),
            () => service.GetMetadataRelationshipCandidateIdsAsync(1, 10, cancellation.Token),
            () => service.GetDiverseFallbackCandidateIdsAsync(1, 10, cancellation.Token),
            () => service.GetViewHistoryAsync(1, cancellation.Token),
            () => service.GetViewHistoryWindowAsync(1, "30d", "day", cancellation.Token),
            () => service.LoadMarkovMatrixAsync(cancellation.Token),
            () => service.GetSongsByProducersAsync([1], 2, 10, cancellation.Token),
            () => service.GetSongsByProducerAsync(1, 10, cancellation.Token),
        ];

        foreach (var operation in operations)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(operation);
    }

    private static DbService CreateService(
        RecommendationObjectCache objectCache,
        SearchResponseCache searchCache)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Postgres"] =
                    "Host=127.0.0.1;Port=1;Username=test;Password=test;Database=test;Timeout=1",
            })
            .Build();
        return new DbService(configuration, objectCache, searchCache);
    }

    private static RecommendationObjectCache CreateObjectCache() =>
        new(
            Options.Create(new RecommenderOptions()),
            NullLogger<RecommendationObjectCache>.Instance);

    private static SearchResponseCache CreateSearchCache() =>
        new(
            Options.Create(new RecommenderOptions()),
            NullLogger<SearchResponseCache>.Instance);
}
