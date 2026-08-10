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
    public async Task CanceledSearchWaiter_DoesNotCancelOrRemoveSharedColdLoad()
    {
        using var cache = CreateCache();
        using var canceledCaller = new CancellationTokenSource();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loadCancellationToken = CancellationToken.None;
        async Task<SongSearchExecution> Load(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            loadCancellationToken = cancellationToken;
            started.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return Execution("[{\"id\":10}]", 1);
        }

        var canceledWaiter = cache.GetOrCreateAsync(
            "search-caller-canceled",
            Load,
            cancellationToken: canceledCaller.Token);
        await started.Task;
        var survivingWaiter = cache.GetOrCreateAsync("search-caller-canceled", Load);

        canceledCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await canceledWaiter);
        Assert.True(cache.HasInFlightLoad("search-caller-canceled"));
        Assert.False(loadCancellationToken.IsCancellationRequested);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.SetResult();
        var survivingResult = await survivingWaiter;
        Assert.Equal("[{\"id\":10}]", survivingResult.ItemsJson);
        await WaitForNoInFlightLoadAsync(cache, "search-caller-canceled");

        var cachedResult = await cache.GetOrCreateAsync("search-caller-canceled", Load);
        Assert.True(cachedResult.CacheHit);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task AllSearchWaitersCanceled_CancelsLoaderAndDoesNotCache()
    {
        using var cache = CreateCache();
        using var firstCaller = new CancellationTokenSource();
        using var secondCaller = new CancellationTokenSource();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loaderCanceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<SongSearchExecution> Load(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                loaderCanceled.TrySetResult();
                throw;
            }

            throw new InvalidOperationException("Infinite delay completed unexpectedly.");
        }

        var first = cache.GetOrCreateAsync(
            "search-all-canceled",
            Load,
            cancellationToken: firstCaller.Token);
        await started.Task;
        var second = cache.GetOrCreateAsync(
            "search-all-canceled",
            Load,
            cancellationToken: secondCaller.Token);

        firstCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await first);
        Assert.True(cache.HasInFlightLoad("search-all-canceled"));

        secondCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await second);
        await loaderCanceled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await WaitForNoInFlightLoadAsync(cache, "search-all-canceled");

        var retryCalls = 0;
        var retry = await cache.GetOrCreateAsync("search-all-canceled", () =>
        {
            retryCalls++;
            return Task.FromResult(Execution("[{\"id\":20}]", 1));
        });

        Assert.False(retry.CacheHit);
        Assert.Equal("[{\"id\":20}]", retry.ItemsJson);
        Assert.Equal(1, calls);
        Assert.Equal(1, retryCalls);
    }

    [Fact]
    public async Task LastWaiterLeaving_RacingLateJoinNeverJoinsDoomedSearchFlight()
    {
        using var releaseCancellationCallback = new ManualResetEventSlim();
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationCallbackEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var flight = new SearchResponseCache.LoadFlight<SongSearchExecution>(
            (_, cancellationToken) => RunFirstLoadAsync(cancellationToken),
            cancelWhenOrphaned: true,
            _ => { });

        async Task<SongSearchExecution> RunFirstLoadAsync(CancellationToken cancellationToken)
        {
            using var registration = cancellationToken.Register(() =>
            {
                cancellationCallbackEntered.TrySetResult();
                releaseCancellationCallback.Wait();
            });
            firstStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("Infinite delay completed unexpectedly.");
        }

        Assert.True(flight.TryAcquire(out var firstLease));
        Assert.NotNull(firstLease);
        var first = flight.Start();
        await firstStarted.Task;

        // Dispose the final lease on a dedicated thread. The loader's
        // cancellation callback deliberately blocks after the flight has
        // closed its gate, giving the test a deterministic late-join window
        // without depending on an async continuation under CI load.
        var releaseFirstLease = Task.Factory.StartNew(
            firstLease!.Dispose,
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default);
        try
        {
            await cancellationCallbackEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

            // The flight is already closed to new leases while its cancellation
            // callback is deliberately held open.
            Assert.False(flight.TryAcquire(out var lateLease));
            Assert.Null(lateLease);
        }
        finally
        {
            releaseCancellationCallback.Set();
            await releaseFirstLease.WaitAsync(TimeSpan.FromSeconds(5));
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await first);
    }

    [Fact]
    public async Task WarmupOwnedSearchLoad_CompletesWhenJoinedRequestCancels()
    {
        using var cache = CreateCache();
        using var requestCaller = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loadCancellationToken = CancellationToken.None;
        var calls = 0;

        async Task<SongSearchExecution> WarmupLoad(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            loadCancellationToken = cancellationToken;
            started.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return Execution("[{\"id\":30}]", 1);
        }

        // A non-request warmup remains an active lease until its await ends.
        var warmup = cache.GetOrCreateAsync("search-warmup", WarmupLoad);
        await started.Task;
        var request = cache.GetOrCreateAsync(
            "search-warmup",
            WarmupLoad,
            cancellationToken: requestCaller.Token);

        requestCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);
        Assert.False(loadCancellationToken.IsCancellationRequested);

        release.SetResult();
        Assert.Equal("[{\"id\":30}]", (await warmup).ItemsJson);
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
    public async Task StaleBackgroundRefresh_CompletesAfterItsOnlyRequestWaiterCancels()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 9, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateAsync(
            "stale-completion-owned",
            () => Task.FromResult(Execution("[{\"id\":1}]", 1)));
        time.Advance(SearchResponseCache.FreshLifetime + TimeSpan.FromSeconds(1));

        using var joinedCaller = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loadCancellationToken = CancellationToken.None;
        var calls = 0;
        async Task<SongSearchExecution> Refresh(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            loadCancellationToken = cancellationToken;
            started.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return Execution("[{\"id\":2}]", 1);
        }

        var stale = await cache.GetOrCreateAsync("stale-completion-owned", Refresh);
        Assert.True(stale.CacheHit);
        await started.Task;

        var joined = cache.GetOrCreateAsync(
            "stale-completion-owned",
            Refresh,
            forceRefresh: true,
            cancellationToken: joinedCaller.Token);
        joinedCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await joined);

        Assert.False(loadCancellationToken.IsCancellationRequested);
        Assert.True(cache.HasInFlightLoad("stale-completion-owned"));
        release.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "stale-completion-owned");

        var refreshed = await cache.GetOrCreateAsync(
            "stale-completion-owned",
            _ => throw new InvalidOperationException("Background refresh did not publish."));
        Assert.True(refreshed.CacheHit);
        Assert.Equal("[{\"id\":2}]", refreshed.ItemsJson);
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
    public async Task RankingEntry_UsesFiveMinuteFreshnessAndSixHourStaleLifetime()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 10, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        var calls = 0;
        var first = await cache.GetOrCreateRankingAsync("ranking:ttl", () =>
        {
            calls++;
            return Task.FromResult("[{\"id\":1}]");
        });

        time.Advance(SearchResponseCache.RankingFreshLifetime - TimeSpan.FromSeconds(1));
        var fresh = await cache.GetOrCreateRankingAsync("ranking:ttl", () =>
        {
            calls++;
            return Task.FromResult("[{\"id\":2}]");
        });
        Assert.Equal(first, fresh);
        Assert.Equal(1, calls);

        time.Advance(TimeSpan.FromSeconds(2));
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<string> Refresh()
        {
            Interlocked.Increment(ref calls);
            refreshStarted.TrySetResult();
            await releaseRefresh.Task;
            return "[{\"id\":2}]";
        }

        var stale = await cache.GetOrCreateRankingAsync("ranking:ttl", Refresh);
        Assert.Equal(first, stale);
        await refreshStarted.Task;
        releaseRefresh.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "ranking:ttl");
        Assert.Equal("[{\"id\":2}]", await cache.GetOrCreateRankingAsync("ranking:ttl", Refresh));
        Assert.Equal(2, calls);

        time.Advance(SearchResponseCache.StaleLifetime + TimeSpan.FromSeconds(1));
        var cold = await cache.GetOrCreateRankingAsync(
            "ranking:ttl",
            () => Task.FromResult("[{\"id\":3}]"));
        Assert.Equal("[{\"id\":3}]", cold);
    }

    [Fact]
    public async Task RankingColdMisses_AreSingleFlightPerKey()
    {
        using var cache = CreateCache();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<string> Load()
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task;
            return "[]";
        }

        var requests = Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateRankingAsync("ranking:cold", Load))
            .ToArray();
        await started.Task;
        Assert.Equal(1, Volatile.Read(ref calls));
        release.SetResult();

        Assert.All(await Task.WhenAll(requests), value => Assert.Equal("[]", value));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task CanceledRankingWaiter_DoesNotCancelOrRemoveSharedColdLoad()
    {
        using var cache = CreateCache();
        using var canceledCaller = new CancellationTokenSource();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loadCancellationToken = CancellationToken.None;
        async Task<string> Load(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            loadCancellationToken = cancellationToken;
            started.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return "[{\"id\":10}]";
        }

        var canceledWaiter = cache.GetOrCreateRankingAsync(
            "ranking-caller-canceled",
            Load,
            cancellationToken: canceledCaller.Token);
        await started.Task;
        var survivingWaiter = cache.GetOrCreateRankingAsync("ranking-caller-canceled", Load);

        canceledCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await canceledWaiter);
        Assert.True(cache.HasInFlightLoad("ranking-caller-canceled"));
        Assert.False(loadCancellationToken.IsCancellationRequested);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.SetResult();
        Assert.Equal("[{\"id\":10}]", await survivingWaiter);
        await WaitForNoInFlightLoadAsync(cache, "ranking-caller-canceled");

        Assert.Equal(
            "[{\"id\":10}]",
            await cache.GetOrCreateRankingAsync("ranking-caller-canceled", Load));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task AllRankingWaitersCanceled_CancelsLoaderAndDoesNotCache()
    {
        using var cache = CreateCache();
        using var firstCaller = new CancellationTokenSource();
        using var secondCaller = new CancellationTokenSource();
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loaderCanceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<string> Load(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                loaderCanceled.TrySetResult();
                throw;
            }

            throw new InvalidOperationException("Infinite delay completed unexpectedly.");
        }

        var first = cache.GetOrCreateRankingAsync(
            "ranking-all-canceled",
            Load,
            cancellationToken: firstCaller.Token);
        await started.Task;
        var second = cache.GetOrCreateRankingAsync(
            "ranking-all-canceled",
            Load,
            cancellationToken: secondCaller.Token);

        firstCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await first);
        Assert.True(cache.HasInFlightLoad("ranking-all-canceled"));

        secondCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await second);
        await loaderCanceled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await WaitForNoInFlightLoadAsync(cache, "ranking-all-canceled");

        var retryCalls = 0;
        var retry = await cache.GetOrCreateRankingAsync("ranking-all-canceled", () =>
        {
            retryCalls++;
            return Task.FromResult("[{\"id\":20}]");
        });

        Assert.Equal("[{\"id\":20}]", retry);
        Assert.Equal(1, calls);
        Assert.Equal(1, retryCalls);
    }

    [Fact]
    public async Task CanceledForceWaiter_DoesNotRemoveFailingStaleRefreshOrBypassBackoff()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 10, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateRankingAsync("ranking-force-join", () => Task.FromResult("old"));
        time.Advance(SearchResponseCache.RankingFreshLifetime + TimeSpan.FromSeconds(1));

        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFailure = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<string> FailingRefresh()
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await releaseFailure.Task;
            throw new InvalidOperationException("expected refresh failure");
        }

        Assert.Equal(
            "old",
            await cache.GetOrCreateRankingAsync("ranking-force-join", FailingRefresh));
        await started.Task;

        using var forceCaller = new CancellationTokenSource();
        var forceWaiter = cache.GetOrCreateRankingAsync(
            "ranking-force-join",
            FailingRefresh,
            forceRefresh: true,
            cancellationToken: forceCaller.Token);
        forceCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await forceWaiter);

        Assert.True(cache.HasInFlightLoad("ranking-force-join"));
        Assert.Equal(
            "old",
            await cache.GetOrCreateRankingAsync("ranking-force-join", FailingRefresh));
        Assert.Equal(1, calls);

        releaseFailure.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "ranking-force-join");

        var retryCalls = 0;
        Assert.Equal("old", await cache.GetOrCreateRankingAsync("ranking-force-join", () =>
        {
            retryCalls++;
            return Task.FromResult("new");
        }));
        Assert.Equal(0, retryCalls);
    }

    [Fact]
    public async Task RankingColdMissRegistrationRace_RechecksCacheBeforeLoading()
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
        var delayedCalls = 0;
        var delayed = cache.GetOrCreateRankingAsync("ranking:race", () =>
        {
            delayedCalls++;
            return Task.FromResult("delayed");
        });
        await hookEntered.Task;

        var leaderCalls = 0;
        var leader = await cache.GetOrCreateRankingAsync("ranking:race", () =>
        {
            leaderCalls++;
            return Task.FromResult("leader");
        });
        releaseFirstHook.SetResult();

        Assert.Equal("leader", leader);
        Assert.Equal("leader", await delayed);
        Assert.Equal(0, delayedCalls);
        Assert.Equal(1, leaderCalls);
    }

    [Fact]
    public async Task RankingDifferentKeys_DoNotBlockEachOther()
    {
        using var cache = CreateCache();
        var slowStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSlow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var slow = cache.GetOrCreateRankingAsync("ranking:slow", async () =>
        {
            slowStarted.SetResult();
            await releaseSlow.Task;
            return "slow";
        });
        await slowStarted.Task;

        Assert.Equal(
            "fast",
            await cache.GetOrCreateRankingAsync("ranking:fast", () => Task.FromResult("fast")));
        Assert.False(slow.IsCompleted);
        releaseSlow.SetResult();
        Assert.Equal("slow", await slow);
    }

    [Fact]
    public async Task FailedRankingColdLoad_IsRemovedSoNextRequestCanRetry()
    {
        using var cache = CreateCache();
        var calls = 0;

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            cache.GetOrCreateRankingAsync("ranking:retry", () =>
            {
                calls++;
                throw new InvalidOperationException("expected ranking failure");
            }));
        var recovered = await cache.GetOrCreateRankingAsync("ranking:retry", () =>
        {
            calls++;
            return Task.FromResult("recovered");
        });

        Assert.Equal("recovered", recovered);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task RankingStaleRefreshFailure_BacksOffForThirtySeconds()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 10, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(timeProvider: time);
        await cache.GetOrCreateRankingAsync("ranking:failure", () => Task.FromResult("old"));
        time.Advance(SearchResponseCache.RankingFreshLifetime + TimeSpan.FromSeconds(1));

        var failedCalls = 0;
        var staleResults = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => cache.GetOrCreateRankingAsync("ranking:failure", () =>
            {
                Interlocked.Increment(ref failedCalls);
                throw new InvalidOperationException("expected ranking refresh failure");
            })));
        Assert.All(staleResults, value => Assert.Equal("old", value));
        await WaitForNoInFlightLoadAsync(cache, "ranking:failure");
        Assert.Equal(1, failedCalls);

        var retryCalls = 0;
        await cache.GetOrCreateRankingAsync("ranking:failure", () =>
        {
            retryCalls++;
            return Task.FromResult("new");
        });
        Assert.Equal(0, retryCalls);

        time.Advance(SearchResponseCache.RefreshFailureBackoff + TimeSpan.FromSeconds(1));
        Assert.Equal("old", await cache.GetOrCreateRankingAsync("ranking:failure", () =>
        {
            retryCalls++;
            return Task.FromResult("new");
        }));
        await WaitForNoInFlightLoadAsync(cache, "ranking:failure");
        Assert.Equal(1, retryCalls);
        Assert.Equal("new", await cache.GetOrCreateRankingAsync(
            "ranking:failure",
            () => Task.FromResult("unexpected")));
    }

    [Fact]
    public async Task OversizedRankingRefresh_RemovesOldEntrySoNextRequestIsCold()
    {
        var time = new MutableTimeProvider(new DateTimeOffset(2026, 8, 10, 0, 0, 0, TimeSpan.Zero));
        using var cache = CreateCache(
            sizeLimitBytes: 16 * 1024,
            maxEntryBytes: 4 * 1024,
            timeProvider: time);
        await cache.GetOrCreateRankingAsync("ranking:oversized", () => Task.FromResult("old"));
        time.Advance(SearchResponseCache.RankingFreshLifetime + TimeSpan.FromSeconds(1));

        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<string> Refresh()
        {
            refreshStarted.TrySetResult();
            await releaseRefresh.Task;
            return new string('x', 3_000);
        }

        Assert.Equal("old", await cache.GetOrCreateRankingAsync("ranking:oversized", Refresh));
        await refreshStarted.Task;
        releaseRefresh.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "ranking:oversized");

        var coldCalls = 0;
        var cold = await cache.GetOrCreateRankingAsync("ranking:oversized", () =>
        {
            coldCalls++;
            return Task.FromResult("new");
        });
        Assert.Equal("new", cold);
        Assert.Equal(1, coldCalls);
    }

    [Fact]
    public async Task SearchAndRankingResponses_ShareOneBoundedPartition()
    {
        using var cache = CreateCache(
            sizeLimitBytes: SearchResponseCache.MinimumEntryChargeBytes,
            maxEntryBytes: SearchResponseCache.MinimumEntryChargeBytes);

        await cache.GetOrCreateRankingAsync("ranking:shared", () => Task.FromResult("[]"));
        await cache.GetOrCreateAsync("search:shared", () => Task.FromResult(Execution("[]", 0)));

        Assert.True(cache.EntryCount <= 1);
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

    [Fact]
    public async Task AbandonedFailingLoad_IsObservedAndRemovedForRetry()
    {
        using var cache = CreateCache();
        using var caller = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFailure = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<SongSearchExecution> FailAfterCancellation(CancellationToken cancellationToken)
        {
            started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                cancellationObserved.TrySetResult();
                await releaseFailure.Task;
                throw new InvalidOperationException("expected post-cancellation loader failure");
            }

            throw new InvalidOperationException("Infinite delay completed unexpectedly.");
        }

        var abandoned = cache.GetOrCreateAsync(
            "abandoned-failure",
            FailAfterCancellation,
            cancellationToken: caller.Token);
        await started.Task;
        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await abandoned);
        await cancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(5));

        releaseFailure.SetResult();
        await WaitForNoInFlightLoadAsync(cache, "abandoned-failure");

        var recovered = await cache.GetOrCreateAsync(
            "abandoned-failure",
            () => Task.FromResult(Execution("[{\"id\":99}]", 1)));
        Assert.False(recovered.CacheHit);
        Assert.Equal("[{\"id\":99}]", recovered.ItemsJson);
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
