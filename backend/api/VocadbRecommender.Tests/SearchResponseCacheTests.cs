using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class SearchResponseCacheTests
{
    [Fact]
    public void DefaultOptions_ConfigureSixtyFourMiBWithEightMiBEntries()
    {
        using var cache = new SearchResponseCache(
            Options.Create(new RecommenderOptions()),
            NullLogger<SearchResponseCache>.Instance);

        Assert.Equal(64L * 1024 * 1024, cache.SizeLimitBytes);
        Assert.Equal(8L * 1024 * 1024, cache.MaxEntryBytes);
    }

    [Fact]
    public async Task FreshEntry_IsReturnedWithoutReloading()
    {
        using var cache = CreateCache();
        var calls = 0;

        var first = await cache.GetOrCreateAsync("key", () =>
        {
            calls++;
            return Task.FromResult(Execution("[{\"id\":1}]", 1));
        });
        var second = await cache.GetOrCreateAsync("key", () =>
        {
            calls++;
            return Task.FromResult(Execution("[{\"id\":2}]", 1));
        });

        Assert.False(first.CacheHit);
        Assert.True(second.CacheHit);
        Assert.Equal(first.ItemsJson, second.ItemsJson);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task ColdMisses_AreSingleFlight()
    {
        using var cache = CreateCache();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<SongSearchExecution> Load()
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task;
            return Execution("[{\"id\":10}]", 1);
        }

        var requests = Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateAsync("cold", Load))
            .ToArray();
        await started.Task;
        Assert.Equal(1, Volatile.Read(ref calls));
        release.SetResult();

        var results = await Task.WhenAll(requests);
        Assert.All(results, result => Assert.False(result.CacheHit));
        Assert.All(results, result => Assert.Equal("[{\"id\":10}]", result.ItemsJson));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task ColdMissRegistrationRace_RechecksCacheBeforeStartingAnotherLoad()
    {
        var hookEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstHook = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hookCalls = 0;
        async Task BeforeRegistration()
        {
            if (Interlocked.Increment(ref hookCalls) != 1) return;
            hookEntered.SetResult();
            await releaseFirstHook.Task;
        }

        using var cache = CreateCache(beforeColdLoadRegistration: BeforeRegistration);
        var delayedLoaderCalls = 0;
        var leaderLoaderCalls = 0;
        var delayed = cache.GetOrCreateAsync("race", () =>
        {
            delayedLoaderCalls++;
            return Task.FromResult(Execution("[{\"id\":1}]", 1));
        });
        await hookEntered.Task;

        var leader = await cache.GetOrCreateAsync("race", () =>
        {
            leaderLoaderCalls++;
            return Task.FromResult(Execution("[{\"id\":2}]", 1));
        });
        releaseFirstHook.SetResult();
        var delayedResult = await delayed;

        Assert.False(leader.CacheHit);
        Assert.True(delayedResult.CacheHit);
        Assert.Equal(0, delayedLoaderCalls);
        Assert.Equal(1, leaderLoaderCalls);
        Assert.Equal(leader.ItemsJson, delayedResult.ItemsJson);
    }

    [Fact]
    public async Task DifferentKeys_DoNotBlockEachOther()
    {
        using var cache = CreateCache();
        var slowStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSlow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var slow = cache.GetOrCreateAsync("slow", async () =>
        {
            slowStarted.SetResult();
            await releaseSlow.Task;
            return Execution("[{\"id\":1}]", 1);
        });
        await slowStarted.Task;

        var fast = await cache.GetOrCreateAsync(
            "fast",
            () => Task.FromResult(Execution("[{\"id\":2}]", 1)));

        Assert.Equal("[{\"id\":2}]", fast.ItemsJson);
        Assert.False(slow.IsCompleted);
        releaseSlow.SetResult();
        await slow;
    }

    [Fact]
    public async Task StaleEntry_ReturnsImmediatelyAndRefreshesSingleFlight()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 9, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateAsync("stale", () => Task.FromResult(Execution("[{\"id\":1}]", 1)));
        time.Advance(TimeSpan.FromMinutes(2));

        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<SongSearchExecution> Refresh()
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task;
            return Execution("[{\"id\":2}]", 1);
        }

        var staleResults = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateAsync("stale", Refresh)));
        Assert.All(staleResults, result =>
        {
            Assert.True(result.CacheHit);
            Assert.Equal("[{\"id\":1}]", result.ItemsJson);
        });
        await started.Task;
        Assert.Equal(1, Volatile.Read(ref calls));

        release.SetResult();
        SongSearchExecution? refreshed = null;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            refreshed = await cache.GetOrCreateAsync("stale", Refresh);
            if (refreshed.ItemsJson == "[{\"id\":2}]") break;
            await Task.Delay(10);
        }

        Assert.NotNull(refreshed);
        Assert.Equal("[{\"id\":2}]", refreshed.ItemsJson);
        Assert.True(refreshed.CacheHit);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task FailedStaleRefresh_BacksOffPerKeyThenRetriesSingleFlight()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 9, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateAsync("stale-failure", () => Task.FromResult(Execution("[{\"id\":1}]", 1)));
        await cache.GetOrCreateAsync("other-stale", () => Task.FromResult(Execution("[{\"id\":10}]", 1)));
        time.Advance(TimeSpan.FromMinutes(2));

        var failedCalls = 0;
        Task<SongSearchExecution> FailRefresh()
        {
            Interlocked.Increment(ref failedCalls);
            throw new InvalidOperationException("expected refresh failure");
        }

        var staleResults = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateAsync("stale-failure", FailRefresh)));
        Assert.All(staleResults, stale =>
        {
            Assert.True(stale.CacheHit);
            Assert.Equal("[{\"id\":1}]", stale.ItemsJson);
        });
        await WaitForNoInFlightLoadAsync(cache, "stale-failure");
        Assert.Equal(1, Volatile.Read(ref failedCalls));

        var suppressedRetryCalls = 0;
        var suppressedResults = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateAsync("stale-failure", () =>
            {
                Interlocked.Increment(ref suppressedRetryCalls);
                return Task.FromResult(Execution("[{\"id\":2}]", 1));
            })));
        Assert.All(suppressedResults, result => Assert.Equal("[{\"id\":1}]", result.ItemsJson));
        Assert.Equal(0, Volatile.Read(ref suppressedRetryCalls));

        var otherRefreshCalls = 0;
        var otherStale = await cache.GetOrCreateAsync("other-stale", () =>
        {
            Interlocked.Increment(ref otherRefreshCalls);
            return Task.FromResult(Execution("[{\"id\":11}]", 1));
        });
        Assert.Equal("[{\"id\":10}]", otherStale.ItemsJson);
        await WaitForNoInFlightLoadAsync(cache, "other-stale");
        Assert.Equal(1, Volatile.Read(ref otherRefreshCalls));

        time.Advance(SearchResponseCache.RefreshFailureBackoff - TimeSpan.FromSeconds(1));
        await cache.GetOrCreateAsync("stale-failure", () =>
        {
            Interlocked.Increment(ref suppressedRetryCalls);
            return Task.FromResult(Execution("[{\"id\":2}]", 1));
        });
        Assert.Equal(0, Volatile.Read(ref suppressedRetryCalls));

        time.Advance(TimeSpan.FromSeconds(2));
        var retryCalls = 0;
        var retryStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRetry = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<SongSearchExecution> RetryRefresh()
        {
            Interlocked.Increment(ref retryCalls);
            retryStarted.TrySetResult();
            await releaseRetry.Task;
            return Execution("[{\"id\":2}]", 1);
        }

        var retryResults = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateAsync("stale-failure", RetryRefresh)));
        Assert.All(retryResults, result => Assert.Equal("[{\"id\":1}]", result.ItemsJson));
        await retryStarted.Task;
        Assert.Equal(1, Volatile.Read(ref retryCalls));
        releaseRetry.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "stale-failure");

        var refreshed = await cache.GetOrCreateAsync(
            "stale-failure",
            () => Task.FromResult(Execution("[{\"id\":3}]", 1)));

        Assert.Equal(1, failedCalls);
        Assert.Equal(1, retryCalls);
        Assert.Equal("[{\"id\":2}]", refreshed.ItemsJson);
        Assert.True(refreshed.CacheHit);
    }

    [Fact]
    public async Task EntryOlderThanSixHours_IsNotServedStale()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 9, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateAsync("expired", () => Task.FromResult(Execution("[{\"id\":1}]", 1)));
        time.Advance(SearchResponseCache.StaleLifetime + TimeSpan.FromSeconds(1));

        var calls = 0;
        var result = await cache.GetOrCreateAsync("expired", () =>
        {
            calls++;
            return Task.FromResult(Execution("[{\"id\":2}]", 1));
        });

        Assert.False(result.CacheHit);
        Assert.Equal("[{\"id\":2}]", result.ItemsJson);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task OversizedEntry_IsReturnedButNotStored()
    {
        using var cache = CreateCache(sizeLimitBytes: 16 * 1024, maxEntryBytes: 4 * 1024);
        var calls = 0;
        var oversized = new string('x', 3_000);

        Task<SongSearchExecution> Load()
        {
            calls++;
            return Task.FromResult(Execution(oversized, 1));
        }

        var first = await cache.GetOrCreateAsync("oversized", Load);
        var second = await cache.GetOrCreateAsync("oversized", Load);

        Assert.False(first.CacheHit);
        Assert.False(second.CacheHit);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task OversizedStaleRefresh_RemovesOldEntrySoNextRequestIsCold()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 9, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(
            sizeLimitBytes: 16 * 1024,
            maxEntryBytes: 4 * 1024,
            timeProvider: time);
        await cache.GetOrCreateAsync("oversized-refresh", () => Task.FromResult(Execution("[{\"id\":1}]", 1)));
        time.Advance(TimeSpan.FromMinutes(2));

        var oversized = new string('x', 3_000);
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<SongSearchExecution> Refresh()
        {
            refreshStarted.TrySetResult();
            await releaseRefresh.Task;
            return Execution(oversized, 1);
        }

        var stale = await cache.GetOrCreateAsync("oversized-refresh", Refresh);
        Assert.True(stale.CacheHit);
        Assert.Equal("[{\"id\":1}]", stale.ItemsJson);
        await refreshStarted.Task;
        releaseRefresh.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "oversized-refresh");

        var coldCalls = 0;
        var cold = await cache.GetOrCreateAsync("oversized-refresh", () =>
        {
            coldCalls++;
            return Task.FromResult(Execution("[{\"id\":2}]", 1));
        });

        Assert.False(cold.CacheHit);
        Assert.Equal("[{\"id\":2}]", cold.ItemsJson);
        Assert.Equal(1, coldCalls);
    }

    [Fact]
    public async Task MinimumCharge_PreventsEmptyEntriesFromExceedingCapacity()
    {
        using var cache = CreateCache(
            sizeLimitBytes: SearchResponseCache.MinimumEntryChargeBytes,
            maxEntryBytes: SearchResponseCache.MinimumEntryChargeBytes);
        await cache.GetOrCreateAsync("first", () => Task.FromResult(Execution("[]", 0)));
        var secondCalls = 0;
        Task<SongSearchExecution> LoadSecond()
        {
            secondCalls++;
            return Task.FromResult(Execution("[]", 0));
        }

        await cache.GetOrCreateAsync("second", LoadSecond);
        await cache.GetOrCreateAsync("second", LoadSecond);

        Assert.Equal(2, secondCalls);
    }

    [Fact]
    public void EntryCharge_AccountsForUtf16KeyAndJsonWithFourKiBMinimum()
    {
        Assert.Equal(
            SearchResponseCache.MinimumEntryChargeBytes,
            SearchResponseCache.EstimateEntryChargeBytes("key", "[]"));
        Assert.Equal(
            (long)100 * sizeof(char) + (long)3_000 * sizeof(char)
                + SearchResponseCache.EstimatedEntryOverheadBytes,
            SearchResponseCache.EstimateEntryChargeBytes(new string('k', 100), new string('x', 3_000)));
    }

    [Fact]
    public async Task FailedColdLoad_IsRemovedSoTheNextRequestCanRetry()
    {
        using var cache = CreateCache();
        var calls = 0;

        await Assert.ThrowsAsync<InvalidOperationException>(() => cache.GetOrCreateAsync("retry", () =>
        {
            calls++;
            throw new InvalidOperationException("expected");
        }));
        var result = await cache.GetOrCreateAsync("retry", () =>
        {
            calls++;
            return Task.FromResult(Execution("[]", 0));
        });

        Assert.False(result.CacheHit);
        Assert.Equal(2, calls);
    }

    private static SearchResponseCache CreateCache(
        long sizeLimitBytes = 64 * 1024,
        long maxEntryBytes = 8 * 1024,
        TimeProvider? timeProvider = null,
        Func<Task>? beforeColdLoadRegistration = null)
        => new(
            sizeLimitBytes,
            maxEntryBytes,
            timeProvider ?? TimeProvider.System,
            NullLogger<SearchResponseCache>.Instance,
            beforeColdLoadRegistration);

    private static SongSearchExecution Execution(string itemsJson, int totalCount)
        => new(itemsJson, totalCount, 1, 2, 3, 6, false);

    private static async Task WaitForNoInFlightLoadAsync(SearchResponseCache cache, string key)
    {
        for (var attempt = 0; attempt < 100 && cache.HasInFlightLoad(key); attempt++)
            await Task.Delay(10);
        Assert.False(cache.HasInFlightLoad(key));
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan duration) => _utcNow = _utcNow.Add(duration);
    }
}
