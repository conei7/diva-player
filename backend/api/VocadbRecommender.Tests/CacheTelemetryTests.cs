using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class CacheTelemetryTests
{
    [Fact]
    public async Task SearchCache_CountsHitsMissesEntriesAndEstimatedCharge()
    {
        using var cache = CreateSearchCache();

        await cache.GetOrCreateAsync("songs", () => Task.FromResult(Execution("[]")));
        await WaitUntilAsync(() => cache.TelemetrySnapshot.InFlight == 0);
        await cache.GetOrCreateAsync("songs", () => throw new InvalidOperationException());

        var telemetry = cache.TelemetrySnapshot;
        Assert.Equal(1, telemetry.Hits);
        Assert.Equal(1, telemetry.Misses);
        Assert.Equal(1, telemetry.CurrentEntries);
        Assert.Equal(SearchResponseCache.MinimumEntryChargeBytes, telemetry.EstimatedChargeBytes);
        Assert.Equal(64 * 1024, telemetry.SizeLimitBytes);
    }

    [Fact]
    public async Task SearchCache_CountsStaleRefreshAndCurrentInFlightWork()
    {
        var time = new MutableTimeProvider(DateTimeOffset.UtcNow);
        using var cache = CreateSearchCache(timeProvider: time);
        await cache.GetOrCreateAsync("stale", () => Task.FromResult(Execution("[]")));
        await WaitUntilAsync(() => cache.TelemetrySnapshot.InFlight == 0);
        time.Advance(SearchResponseCache.FreshLifetime + TimeSpan.FromSeconds(1));
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refreshResult = new TaskCompletionSource<SongSearchExecution>(TaskCreationOptions.RunContinuationsAsynchronously);

        var stale = await cache.GetOrCreateAsync("stale", () =>
        {
            refreshStarted.TrySetResult();
            return refreshResult.Task;
        });
        await refreshStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var active = cache.TelemetrySnapshot;
        Assert.True(stale.CacheHit);
        Assert.Equal(1, active.StaleHits);
        Assert.Equal(1, active.Refreshes);
        Assert.Equal(1, active.InFlight);

        refreshResult.SetResult(Execution("[{\"id\":1}]"));
        await WaitUntilAsync(() => cache.TelemetrySnapshot.InFlight == 0);
    }

    [Fact]
    public async Task SearchCache_CountsSingleFlightFollowersWithoutRecordingKeys()
    {
        using var cache = CreateSearchCache();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var result = new TaskCompletionSource<SongSearchExecution>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<SongSearchExecution> Loader()
        {
            started.TrySetResult();
            return result.Task;
        }

        var leader = cache.GetOrCreateAsync("private-query", Loader);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var follower = cache.GetOrCreateAsync("private-query", Loader);

        var active = cache.TelemetrySnapshot;
        Assert.Equal(2, active.Misses);
        Assert.Equal(1, active.Followers);
        Assert.Equal(1, active.InFlight);

        result.SetResult(Execution("[]"));
        await Task.WhenAll(leader, follower);
    }

    [Fact]
    public async Task SearchCache_CountsOversizeSkipsAndReplacementEvictions()
    {
        using var cache = CreateSearchCache(
            sizeLimitBytes: 8 * 1024,
            maxEntryBytes: SearchResponseCache.MinimumEntryChargeBytes);

        await cache.GetOrCreateAsync("replace", () => Task.FromResult(Execution("[]")));
        await cache.GetOrCreateAsync(
            "replace",
            () => Task.FromResult(Execution("[1]")),
            forceRefresh: true);
        await WaitUntilAsync(() => cache.TelemetrySnapshot.Evictions >= 1);
        await cache.GetOrCreateAsync(
            "oversize",
            () => Task.FromResult(Execution(new string('x', 5_000))));

        var telemetry = cache.TelemetrySnapshot;
        Assert.True(telemetry.Evictions >= 1);
        Assert.Equal(1, telemetry.OversizeSkips);
        Assert.Equal(1, telemetry.CurrentEntries);
        Assert.Equal(SearchResponseCache.MinimumEntryChargeBytes, telemetry.EstimatedChargeBytes);
    }

    [Fact]
    public void ObjectCache_CountsHitsMissesOversizeAndCharge()
    {
        using var cache = CreateObjectCache();

        Assert.False(cache.TryGetValue("object", out object? _));
        Assert.True(cache.Set("object", new object(), TimeSpan.FromMinutes(1), 10));
        Assert.True(cache.TryGetValue("object", out object? _));
        Assert.False(cache.Set("too-large", new object(), TimeSpan.FromMinutes(1), 32 * 1024));

        var telemetry = cache.TelemetrySnapshot;
        Assert.Equal(1, telemetry.Hits);
        Assert.Equal(1, telemetry.Misses);
        Assert.Equal(1, telemetry.OversizeSkips);
        Assert.Equal(1, telemetry.CurrentEntries);
        Assert.Equal(RecommendationObjectCache.MinimumEntryChargeBytes, telemetry.EstimatedChargeBytes);
        Assert.Equal(0, telemetry.InFlight);
    }

    [Fact]
    public async Task ObjectCache_ReplacementKeepsCurrentChargeAndCountsEviction()
    {
        using var cache = CreateObjectCache();
        cache.Set("same", new object(), TimeSpan.FromMinutes(1), 10);
        cache.Set("same", new object(), TimeSpan.FromMinutes(1), 20);

        await WaitUntilAsync(() => cache.TelemetrySnapshot.Evictions >= 1);
        var telemetry = cache.TelemetrySnapshot;
        Assert.Equal(1, telemetry.CurrentEntries);
        Assert.Equal(RecommendationObjectCache.MinimumEntryChargeBytes, telemetry.EstimatedChargeBytes);
    }

    [Fact]
    public async Task RuntimeTelemetry_ContainsStructuredCountersButNoCacheKeys()
    {
        using var search = CreateSearchCache();
        using var objects = CreateObjectCache();
        await search.GetOrCreateAsync("secret-search-key", () => Task.FromResult(Execution("[]")));
        objects.Set("secret-object-key", new object(), TimeSpan.FromMinutes(1), 10);
        var logger = new CapturingLogger<ApiRuntimeTelemetryService>();
        var service = new ApiRuntimeTelemetryService(
            search,
            objects,
            logger,
            TimeProvider.System,
            TimeSpan.FromMinutes(1));

        var snapshot = service.CaptureSnapshot();
        service.LogSnapshot(snapshot);

        Assert.True(snapshot.RssBytes > 0);
        Assert.True(snapshot.GcHeapBytes >= 0);
        Assert.Contains(logger.Properties, item => item.Key == "SearchMisses" && Equals(item.Value, 1L));
        Assert.Contains(logger.Properties, item => item.Key == "ObjectEntries" && Equals(item.Value, 1));
        Assert.DoesNotContain("secret-search-key", logger.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-object-key", logger.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(logger.Properties, item => item.Key.Contains("CacheKey", StringComparison.Ordinal));
    }

    private static SearchResponseCache CreateSearchCache(
        long sizeLimitBytes = 64 * 1024,
        long maxEntryBytes = 8 * 1024,
        TimeProvider? timeProvider = null) =>
        new(
            sizeLimitBytes,
            maxEntryBytes,
            timeProvider ?? TimeProvider.System,
            NullLogger<SearchResponseCache>.Instance);

    private static RecommendationObjectCache CreateObjectCache() =>
        new(
            64 * 1024,
            8 * 1024,
            NullLogger<RecommendationObjectCache>.Instance);

    private static SongSearchExecution Execution(string json) =>
        new(json, 1, 1, 1, 1, 3, false);

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 200 && !condition(); attempt++)
            await Task.Delay(10);
        Assert.True(condition());
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public string Message { get; private set; } = string.Empty;
        public IReadOnlyList<KeyValuePair<string, object?>> Properties { get; private set; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Message = formatter(state, exception);
            Properties = state is IEnumerable<KeyValuePair<string, object?>> properties
                ? properties.ToArray()
                : [];
        }
    }
}
