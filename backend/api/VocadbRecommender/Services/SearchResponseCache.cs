using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace VocadbRecommender.Services;

/// <summary>
/// A bounded partition for search and ranking response JSON. It intentionally
/// does not share capacity with SongInfo and recommendation object caches.
/// </summary>
public sealed class SearchResponseCache : IDisposable
{
    internal const long MinimumEntryChargeBytes = 4 * 1024;
    internal const long EstimatedEntryOverheadBytes = 512;
    internal static readonly TimeSpan FreshLifetime = TimeSpan.FromMinutes(1);
    internal static readonly TimeSpan RankingFreshLifetime = TimeSpan.FromMinutes(5);
    internal static readonly TimeSpan StaleLifetime = TimeSpan.FromHours(6);
    internal static readonly TimeSpan RankingStaleLifetime = TimeSpan.FromDays(30);
    internal static readonly TimeSpan RefreshFailureBackoff = TimeSpan.FromSeconds(30);

    private readonly MemoryCache _cache;
    private readonly long _maxEntryBytes;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<SearchResponseCache> _logger;
    private readonly Func<Task>? _beforeColdLoadRegistration;
    private readonly ConcurrentDictionary<string, LoadFlight<SongSearchExecution>> _loads = new();
    private readonly ConcurrentDictionary<string, LoadFlight<string>> _rankingLoads = new();
    private readonly object _trackingGate = new();
    private readonly ConcurrentDictionary<string, TrackedEntry> _trackedEntries = new();
    private long _lastOversizeWarningUtcTicks;
    private long _lastRankingOversizeWarningUtcTicks;
    private long _nextEntryId;
    private long _estimatedChargeBytes;
    private long _hits;
    private long _misses;
    private long _staleHits;
    private long _refreshes;
    private long _followers;
    private long _evictions;
    private long _oversizeSkips;

    private sealed record TrackedEntry(long Id, long ChargeBytes);
    private sealed record EvictionCallbackState(
        SearchResponseCache Owner,
        string Key,
        TrackedEntry Entry);

    /// <summary>
    /// Owns one shared loader and arbitrates request waiter lifetime. Closing a
    /// request-owned flight and accepting a new waiter are serialized by the
    /// same gate, so a late request can never join a loader that is already
    /// committed to cancellation.
    /// </summary>
    internal sealed class LoadFlight<T> : IDisposable
    {
        private readonly object _gate = new();
        private readonly CancellationTokenSource _loaderCancellation = new();
        private readonly Lazy<Task<T>> _task;
        private readonly bool _cancelWhenOrphaned;
        private readonly Action<Exception> _onCancellationFailure;
        private Task<T>? _startedTask;
        private int _waiterCount;
        private bool _acceptingWaiters = true;
        private bool _abandoned;
        private bool _completed;
        private int _disposed;

        public LoadFlight(
            Func<LoadFlight<T>, CancellationToken, Task<T>> loader,
            bool cancelWhenOrphaned,
            Action<Exception> onCancellationFailure)
        {
            _cancelWhenOrphaned = cancelWhenOrphaned;
            _onCancellationFailure = onCancellationFailure;
            _task = new Lazy<Task<T>>(
                () => InvokeLoaderAsync(loader),
                LazyThreadSafetyMode.ExecutionAndPublication);
        }

        public bool TryAcquire(out Lease? lease)
        {
            lock (_gate)
            {
                if (!_acceptingWaiters)
                {
                    lease = null;
                    return false;
                }

                checked { _waiterCount++; }
                lease = new Lease(this);
                return true;
            }
        }

        public Task<T> Start()
        {
            var task = _task.Value;
            lock (_gate)
                _startedTask ??= task;
            return task;
        }

        /// <summary>
        /// Linearizes cache publication against the last waiter leaving. If
        /// abandonment won the gate, even a loader that ignored cancellation
        /// cannot publish an orphaned result.
        /// </summary>
        public bool TryPublish(Action publish)
        {
            lock (_gate)
            {
                if (_abandoned)
                    return false;

                publish();
                return true;
            }
        }

        public void MarkCompleted()
        {
            lock (_gate)
            {
                _completed = true;
                _acceptingWaiters = false;
            }
        }

        private async Task<T> InvokeLoaderAsync(
            Func<LoadFlight<T>, CancellationToken, Task<T>> loader) =>
            await loader(this, _loaderCancellation.Token).ConfigureAwait(false);

        private void ReleaseWaiter()
        {
            var cancelLoader = false;
            lock (_gate)
            {
                if (_waiterCount <= 0)
                    throw new InvalidOperationException("Shared load waiter count underflow.");

                _waiterCount--;
                if (_waiterCount == 0
                    && _cancelWhenOrphaned
                    && !_completed
                    && _startedTask is { IsCompleted: false })
                {
                    // This transition must happen before signaling the token.
                    // A late request either acquired the gate first and keeps
                    // the load alive, or observes a closed flight and replaces it.
                    _abandoned = true;
                    _acceptingWaiters = false;
                    cancelLoader = true;
                }
            }

            if (!cancelLoader)
                return;

            try
            {
                _loaderCancellation.Cancel();
            }
            catch (Exception exception)
            {
                // Cancellation callbacks are third-party code. Their failures
                // must not escape a request finally block or go unobserved.
                try
                {
                    _onCancellationFailure(exception);
                }
                catch
                {
                    // Logging must not replace the caller's cancellation.
                }
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                _loaderCancellation.Dispose();
        }

        public sealed class Lease : IDisposable
        {
            private LoadFlight<T>? _owner;

            public Lease(LoadFlight<T> owner) => _owner = owner;

            public void Dispose() =>
                Interlocked.Exchange(ref _owner, null)?.ReleaseWaiter();
        }
    }

    private sealed record CachedSearchResponse(
        string ItemsJson,
        int TotalCount,
        DateTimeOffset FreshUntil,
        DateTimeOffset StaleUntil)
    {
        public long RefreshRetryAfterUtcTicks;
    }

    private sealed record CachedRankingResponse(
        string ItemsJson,
        DateTimeOffset FreshUntil,
        DateTimeOffset StaleUntil)
    {
        public long RefreshRetryAfterUtcTicks;
    }

    public SearchResponseCache(
        IOptions<RecommenderOptions> options,
        ILogger<SearchResponseCache> logger)
        : this(
            checked(options.Value.SearchCacheSizeMiB * 1024L * 1024L),
            checked(options.Value.SearchCacheEntrySizeMiB * 1024L * 1024L),
            TimeProvider.System,
            logger,
            null)
    {
    }

    internal SearchResponseCache(
        long sizeLimitBytes,
        long maxEntryBytes,
        TimeProvider timeProvider,
        ILogger<SearchResponseCache> logger,
        Func<Task>? beforeColdLoadRegistration = null)
    {
        if (sizeLimitBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(sizeLimitBytes));
        if (maxEntryBytes <= 0 || maxEntryBytes > sizeLimitBytes)
            throw new ArgumentOutOfRangeException(nameof(maxEntryBytes));

        SizeLimitBytes = sizeLimitBytes;
        _maxEntryBytes = maxEntryBytes;
        _timeProvider = timeProvider;
        _logger = logger;
        _beforeColdLoadRegistration = beforeColdLoadRegistration;
        _cache = new MemoryCache(new MemoryCacheOptions
        {
            SizeLimit = sizeLimitBytes,
            CompactionPercentage = 0.25,
        });
    }

    internal long SizeLimitBytes { get; }
    internal long MaxEntryBytes => _maxEntryBytes;
    internal int EntryCount => _cache.Count;

    public CacheTelemetrySnapshot TelemetrySnapshot
    {
        get
        {
            int currentEntries;
            long estimatedChargeBytes;
            lock (_trackingGate)
            {
                currentEntries = _trackedEntries.Count;
                estimatedChargeBytes = _estimatedChargeBytes;
            }

            return new CacheTelemetrySnapshot(
                Interlocked.Read(ref _hits),
                Interlocked.Read(ref _misses),
                Interlocked.Read(ref _staleHits),
                Interlocked.Read(ref _refreshes),
                Interlocked.Read(ref _followers),
                Interlocked.Read(ref _evictions),
                Interlocked.Read(ref _oversizeSkips),
                _loads.Count + _rankingLoads.Count,
                currentEntries,
                estimatedChargeBytes,
                SizeLimitBytes);
        }
    }

    public Task<SongSearchExecution> GetOrCreateAsync(
        string key,
        Func<Task<SongSearchExecution>> loader,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(loader);
        return GetOrCreateAsync(
            key,
            _ => loader(),
            forceRefresh,
            cancellationToken);
    }

    public async Task<SongSearchExecution> GetOrCreateAsync(
        string key,
        Func<CancellationToken, Task<SongSearchExecution>> loader,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(loader);
        cancellationToken.ThrowIfCancellationRequested();

        var stopwatch = Stopwatch.StartNew();
        if (!forceRefresh && TryGetCached(key, out var cached))
        {
            Interlocked.Increment(ref _hits);
            if (cached.FreshUntil <= _timeProvider.GetUtcNow())
            {
                Interlocked.Increment(ref _staleHits);
                StartBackgroundRefresh(key, cached, loader);
            }

            stopwatch.Stop();
            return new SongSearchExecution(
                cached.ItemsJson,
                cached.TotalCount,
                0,
                0,
                0,
                stopwatch.ElapsedMilliseconds,
                true);
        }

        Interlocked.Increment(ref _misses);

        if (!forceRefresh && _beforeColdLoadRegistration is not null)
            await _beforeColdLoadRegistration().WaitAsync(cancellationToken);
        return await LoadSingleFlightAsync(key, loader, forceRefresh, cancellationToken);
    }

    public Task<string> GetOrCreateRankingAsync(
        string key,
        Func<Task<string>> loader,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(loader);
        return GetOrCreateRankingAsync(
            key,
            _ => loader(),
            forceRefresh,
            cancellationToken);
    }

    public async Task<string> GetOrCreateRankingAsync(
        string key,
        Func<CancellationToken, Task<string>> loader,
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(loader);
        cancellationToken.ThrowIfCancellationRequested();

        if (!forceRefresh && TryGetCachedRanking(key, out var cached))
        {
            Interlocked.Increment(ref _hits);
            if (cached.FreshUntil <= _timeProvider.GetUtcNow())
            {
                Interlocked.Increment(ref _staleHits);
                StartRankingBackgroundRefresh(key, cached, loader);
            }
            return cached.ItemsJson;
        }

        Interlocked.Increment(ref _misses);

        if (!forceRefresh && _beforeColdLoadRegistration is not null)
            await _beforeColdLoadRegistration().WaitAsync(cancellationToken);
        return await LoadRankingSingleFlightAsync(key, loader, forceRefresh, cancellationToken);
    }

    internal static long EstimateEntryChargeBytes(string key, string itemsJson)
    {
        var estimated = (long)key.Length * sizeof(char)
            + (long)itemsJson.Length * sizeof(char)
            + EstimatedEntryOverheadBytes;
        return Math.Max(MinimumEntryChargeBytes, estimated);
    }

    internal bool HasInFlightLoad(string key) =>
        _loads.ContainsKey(key) || _rankingLoads.ContainsKey(key);

    private async Task<SongSearchExecution> LoadSingleFlightAsync(
        string key,
        Func<CancellationToken, Task<SongSearchExecution>> loader,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var (flight, lease, ownsFlight) = AcquireFlight(
            _loads,
            key,
            () => new LoadFlight<SongSearchExecution>(
                (owner, loadCancellationToken) => LoadAfterCacheRecheckAsync(
                    key,
                    loader,
                    forceRefresh,
                    owner,
                    loadCancellationToken),
                cancelWhenOrphaned: true,
                LogLoaderCancellationFailure));
        Task<SongSearchExecution> sharedTask;
        try
        {
            sharedTask = flight.Start();
        }
        catch
        {
            lease.Dispose();
            CompleteFlight(_loads, key, flight);
            throw;
        }

        if (!ownsFlight)
            Interlocked.Increment(ref _followers);
        else if (forceRefresh)
            Interlocked.Increment(ref _refreshes);
        if (ownsFlight)
            _ = ObserveColdLoadCompletionAsync(key, flight, sharedTask);

        try
        {
            return await sharedTask.WaitAsync(cancellationToken);
        }
        finally
        {
            lease.Dispose();
        }
    }

    private async Task ObserveColdLoadCompletionAsync(
        string key,
        LoadFlight<SongSearchExecution> flight,
        Task<SongSearchExecution> sharedTask)
    {
        try
        {
            await sharedTask;
        }
        catch
        {
            // Attached waiters observe the same failure. This completion owner
            // remains so an orphaned failure is observed and always cleaned up.
        }
        finally
        {
            CompleteFlight(_loads, key, flight);
        }
    }

    private void StartBackgroundRefresh(
        string key,
        CachedSearchResponse stale,
        Func<CancellationToken, Task<SongSearchExecution>> loader)
    {
        if (Volatile.Read(ref stale.RefreshRetryAfterUtcTicks) > _timeProvider.GetUtcNow().UtcTicks)
            return;

        var flight = new LoadFlight<SongSearchExecution>(
            (owner, loadCancellationToken) => Task.Run(
                () => LoadAfterCacheRecheckAsync(
                    key,
                    loader,
                    forceRefresh: false,
                    owner,
                    loadCancellationToken)),
            cancelWhenOrphaned: false,
            LogLoaderCancellationFailure);
        if (!_loads.TryAdd(key, flight))
        {
            flight.Dispose();
            return;
        }

        Interlocked.Increment(ref _refreshes);
        Task<SongSearchExecution> sharedTask;
        try
        {
            sharedTask = flight.Start();
        }
        catch (Exception exception)
        {
            CompleteFlight(_loads, key, flight);
            RecordSearchRefreshFailure(stale, exception);
            return;
        }

        _ = ObserveBackgroundRefreshAsync(key, stale, flight, sharedTask);
    }

    private async Task ObserveBackgroundRefreshAsync(
        string key,
        CachedSearchResponse stale,
        LoadFlight<SongSearchExecution> flight,
        Task<SongSearchExecution> sharedTask)
    {
        try
        {
            await sharedTask;
        }
        catch (Exception exception)
        {
            RecordSearchRefreshFailure(stale, exception);
        }
        finally
        {
            CompleteFlight(_loads, key, flight);
        }
    }

    private void RecordSearchRefreshFailure(
        CachedSearchResponse stale,
        Exception exception)
    {
        Volatile.Write(
            ref stale.RefreshRetryAfterUtcTicks,
            _timeProvider.GetUtcNow().Add(RefreshFailureBackoff).UtcTicks);
        _logger.LogWarning(exception, "song_search_cache_refresh_failed");
    }

    private async Task<SongSearchExecution> LoadAndStoreAsync(
        string key,
        Func<CancellationToken, Task<SongSearchExecution>> loader,
        LoadFlight<SongSearchExecution> flight,
        CancellationToken loadCancellationToken)
    {
        var execution = await loader(loadCancellationToken);
        loadCancellationToken.ThrowIfCancellationRequested();
        var chargeBytes = EstimateEntryChargeBytes(key, execution.ItemsJson);
        if (chargeBytes > _maxEntryBytes)
        {
            flight.TryPublish(() =>
            {
                _cache.Remove(key);
                Interlocked.Increment(ref _oversizeSkips);
                LogOversizeSkip(chargeBytes);
            });
            return execution;
        }

        var now = _timeProvider.GetUtcNow();
        flight.TryPublish(() =>
            StoreTracked(
                key,
                new CachedSearchResponse(
                    execution.ItemsJson,
                    execution.TotalCount,
                    now.Add(FreshLifetime),
                    now.Add(StaleLifetime)),
                chargeBytes));
        return execution;
    }

    private Task<SongSearchExecution> LoadAfterCacheRecheckAsync(
        string key,
        Func<CancellationToken, Task<SongSearchExecution>> loader,
        bool forceRefresh,
        LoadFlight<SongSearchExecution> flight,
        CancellationToken loadCancellationToken)
    {
        // A leader may have populated and removed its in-flight entry after
        // this caller's initial miss but before GetOrAdd. Recheck inside the
        // new leader factory so that race cannot start a duplicate DB query.
        if (!forceRefresh
            && TryGetCached(key, out var cached)
            && cached.FreshUntil > _timeProvider.GetUtcNow())
        {
            return Task.FromResult(new SongSearchExecution(
                cached.ItemsJson,
                cached.TotalCount,
                0,
                0,
                0,
                0,
                true));
        }

        return LoadAndStoreAsync(key, loader, flight, loadCancellationToken);
    }

    private async Task<string> LoadRankingSingleFlightAsync(
        string key,
        Func<CancellationToken, Task<string>> loader,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var (flight, lease, ownsFlight) = AcquireFlight(
            _rankingLoads,
            key,
            () => new LoadFlight<string>(
                (owner, loadCancellationToken) => LoadRankingAfterCacheRecheckAsync(
                    key,
                    loader,
                    forceRefresh,
                    owner,
                    loadCancellationToken),
                cancelWhenOrphaned: true,
                LogLoaderCancellationFailure));
        Task<string> sharedTask;
        try
        {
            sharedTask = flight.Start();
        }
        catch
        {
            lease.Dispose();
            CompleteFlight(_rankingLoads, key, flight);
            throw;
        }

        if (!ownsFlight)
            Interlocked.Increment(ref _followers);
        else if (forceRefresh)
            Interlocked.Increment(ref _refreshes);
        if (ownsFlight)
            _ = ObserveRankingColdLoadCompletionAsync(key, flight, sharedTask);

        try
        {
            return await sharedTask.WaitAsync(cancellationToken);
        }
        finally
        {
            lease.Dispose();
        }
    }

    private async Task ObserveRankingColdLoadCompletionAsync(
        string key,
        LoadFlight<string> flight,
        Task<string> sharedTask)
    {
        try
        {
            await sharedTask;
        }
        catch
        {
            // See ObserveColdLoadCompletionAsync. A request cancellation never
            // owns cleanup of work that remains useful to another lease.
        }
        finally
        {
            CompleteFlight(_rankingLoads, key, flight);
        }
    }

    private void StartRankingBackgroundRefresh(
        string key,
        CachedRankingResponse stale,
        Func<CancellationToken, Task<string>> loader)
    {
        if (Volatile.Read(ref stale.RefreshRetryAfterUtcTicks) > _timeProvider.GetUtcNow().UtcTicks)
            return;

        var flight = new LoadFlight<string>(
            (owner, loadCancellationToken) => Task.Run(
                () => LoadRankingAfterCacheRecheckAsync(
                    key,
                    loader,
                    forceRefresh: false,
                    owner,
                    loadCancellationToken)),
            cancelWhenOrphaned: false,
            LogLoaderCancellationFailure);
        if (!_rankingLoads.TryAdd(key, flight))
        {
            flight.Dispose();
            return;
        }

        Interlocked.Increment(ref _refreshes);
        Task<string> sharedTask;
        try
        {
            sharedTask = flight.Start();
        }
        catch (Exception exception)
        {
            CompleteFlight(_rankingLoads, key, flight);
            RecordRankingRefreshFailure(stale, exception);
            return;
        }

        _ = ObserveRankingBackgroundRefreshAsync(key, stale, flight, sharedTask);
    }

    private async Task ObserveRankingBackgroundRefreshAsync(
        string key,
        CachedRankingResponse stale,
        LoadFlight<string> flight,
        Task<string> sharedTask)
    {
        try
        {
            await sharedTask;
        }
        catch (Exception exception)
        {
            RecordRankingRefreshFailure(stale, exception);
        }
        finally
        {
            CompleteFlight(_rankingLoads, key, flight);
        }
    }

    private void RecordRankingRefreshFailure(
        CachedRankingResponse stale,
        Exception exception)
    {
        Volatile.Write(
            ref stale.RefreshRetryAfterUtcTicks,
            _timeProvider.GetUtcNow().Add(RefreshFailureBackoff).UtcTicks);
        _logger.LogWarning(exception, "trending_cache_refresh_failed");
    }

    private async Task<string> LoadAndStoreRankingAsync(
        string key,
        Func<CancellationToken, Task<string>> loader,
        LoadFlight<string> flight,
        CancellationToken loadCancellationToken)
    {
        var itemsJson = await loader(loadCancellationToken);
        loadCancellationToken.ThrowIfCancellationRequested();
        var chargeBytes = EstimateEntryChargeBytes(key, itemsJson);
        if (chargeBytes > _maxEntryBytes)
        {
            flight.TryPublish(() =>
            {
                _cache.Remove(key);
                Interlocked.Increment(ref _oversizeSkips);
                LogRankingOversizeSkip(chargeBytes);
            });
            return itemsJson;
        }

        var now = _timeProvider.GetUtcNow();
        flight.TryPublish(() =>
            StoreTracked(
                key,
                new CachedRankingResponse(
                    itemsJson,
                    now.Add(RankingFreshLifetime),
                    now.Add(RankingStaleLifetime)),
                chargeBytes,
                RankingStaleLifetime));
        return itemsJson;
    }

    private Task<string> LoadRankingAfterCacheRecheckAsync(
        string key,
        Func<CancellationToken, Task<string>> loader,
        bool forceRefresh,
        LoadFlight<string> flight,
        CancellationToken loadCancellationToken)
    {
        if (!forceRefresh
            && TryGetCachedRanking(key, out var cached)
            && cached.FreshUntil > _timeProvider.GetUtcNow())
            return Task.FromResult(cached.ItemsJson);

        return LoadAndStoreRankingAsync(key, loader, flight, loadCancellationToken);
    }

    private bool TryGetCachedRanking(string key, out CachedRankingResponse cached)
    {
        if (!_cache.TryGetValue(key, out CachedRankingResponse? candidate) || candidate is null)
        {
            cached = null!;
            return false;
        }

        if (candidate.StaleUntil <= _timeProvider.GetUtcNow())
        {
            _cache.Remove(key);
            cached = null!;
            return false;
        }

        cached = candidate;
        return true;
    }

    private bool TryGetCached(string key, out CachedSearchResponse cached)
    {
        if (!_cache.TryGetValue(key, out CachedSearchResponse? candidate) || candidate is null)
        {
            cached = null!;
            return false;
        }

        if (candidate.StaleUntil <= _timeProvider.GetUtcNow())
        {
            _cache.Remove(key);
            cached = null!;
            return false;
        }

        cached = candidate;
        return true;
    }

    private void LogOversizeSkip(long chargeBytes)
    {
        var nowTicks = _timeProvider.GetUtcNow().UtcTicks;
        var lastTicks = Volatile.Read(ref _lastOversizeWarningUtcTicks);
        if (lastTicks != 0 && nowTicks - lastTicks < TimeSpan.FromMinutes(1).Ticks)
            return;
        if (Interlocked.CompareExchange(ref _lastOversizeWarningUtcTicks, nowTicks, lastTicks) != lastTicks)
            return;

        _logger.LogWarning(
            "song_search_cache_entry_skipped estimatedBytes={EstimatedBytes} maxBytes={MaxBytes}",
            chargeBytes,
            _maxEntryBytes);
    }

    private void LogRankingOversizeSkip(long chargeBytes)
    {
        var nowTicks = _timeProvider.GetUtcNow().UtcTicks;
        var lastTicks = Volatile.Read(ref _lastRankingOversizeWarningUtcTicks);
        if (lastTicks != 0 && nowTicks - lastTicks < TimeSpan.FromMinutes(1).Ticks)
            return;
        if (Interlocked.CompareExchange(ref _lastRankingOversizeWarningUtcTicks, nowTicks, lastTicks) != lastTicks)
            return;

        _logger.LogWarning(
            "trending_cache_entry_skipped estimatedBytes={EstimatedBytes} maxBytes={MaxBytes}",
            chargeBytes,
            _maxEntryBytes);
    }

    private void StoreTracked<T>(
        string key,
        T value,
        long chargeBytes,
        TimeSpan? absoluteLifetime = null)
        where T : class
    {
        var tracked = new TrackedEntry(Interlocked.Increment(ref _nextEntryId), chargeBytes);
        var callbackState = new EvictionCallbackState(this, key, tracked);
        lock (_trackingGate)
        {
            if (_trackedEntries.TryGetValue(key, out var previous))
                Interlocked.Add(ref _estimatedChargeBytes, -previous.ChargeBytes);
            _trackedEntries[key] = tracked;
            Interlocked.Add(ref _estimatedChargeBytes, chargeBytes);

            try
            {
                _cache.Set(
                    key,
                    value,
                    new MemoryCacheEntryOptions
                    {
                        AbsoluteExpirationRelativeToNow = absoluteLifetime ?? StaleLifetime,
                        Size = chargeBytes,
                    }.RegisterPostEvictionCallback(
                        static (_, _, _, state) =>
                        {
                            var callback = (EvictionCallbackState)state!;
                            callback.Owner.OnEntryEvicted(callback.Key, callback.Entry);
                        },
                        callbackState));
            }
            catch
            {
                UntrackEntry(key, tracked);
                throw;
            }
        }
    }

    private void OnEntryEvicted(string key, TrackedEntry entry)
    {
        Interlocked.Increment(ref _evictions);
        lock (_trackingGate)
            UntrackEntry(key, entry);
    }

    private void UntrackEntry(string key, TrackedEntry expected)
    {
        if (_trackedEntries.TryGetValue(key, out var current)
            && current.Id == expected.Id
            && _trackedEntries.TryRemove(key, out _))
        {
            Interlocked.Add(ref _estimatedChargeBytes, -expected.ChargeBytes);
        }
    }

    private static (
        LoadFlight<T> Flight,
        LoadFlight<T>.Lease Lease,
        bool OwnsFlight) AcquireFlight<T>(
        ConcurrentDictionary<string, LoadFlight<T>> flights,
        string key,
        Func<LoadFlight<T>> createFlight)
    {
        while (true)
        {
            if (flights.TryGetValue(key, out var current))
            {
                if (current.TryAcquire(out var existingLease))
                    return (current, existingLease!, false);

                // The previous last waiter closed this flight before
                // cancellation. Replace it only by identity; its completion
                // observer still owns disposal and cannot remove this replacement.
                var replacement = createFlight();
                if (flights.TryUpdate(key, replacement, current))
                {
                    if (!replacement.TryAcquire(out var replacementLease))
                    {
                        CompleteFlight(flights, key, replacement);
                        throw new InvalidOperationException("A new shared load rejected its first waiter.");
                    }

                    return (replacement, replacementLease!, true);
                }

                replacement.Dispose();
                continue;
            }

            var candidate = createFlight();
            if (flights.TryAdd(key, candidate))
            {
                if (!candidate.TryAcquire(out var candidateLease))
                {
                    CompleteFlight(flights, key, candidate);
                    throw new InvalidOperationException("A new shared load rejected its first waiter.");
                }

                return (candidate, candidateLease!, true);
            }

            candidate.Dispose();
        }
    }

    private static void CompleteFlight<T>(
        ConcurrentDictionary<string, LoadFlight<T>> flights,
        string key,
        LoadFlight<T> flight)
    {
        flight.MarkCompleted();
        ((ICollection<KeyValuePair<string, LoadFlight<T>>>)flights).Remove(
            new KeyValuePair<string, LoadFlight<T>>(key, flight));
        flight.Dispose();
    }

    private void LogLoaderCancellationFailure(Exception exception) =>
        _logger.LogWarning(exception, "cache_shared_load_cancellation_callback_failed");

    public void Dispose() => _cache.Dispose();
}
