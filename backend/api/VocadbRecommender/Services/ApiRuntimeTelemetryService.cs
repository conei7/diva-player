namespace VocadbRecommender.Services;

internal sealed record ApiRuntimeTelemetrySnapshot(
    long RssBytes,
    long GcHeapBytes,
    long GcFragmentedBytes,
    long GcTotalAllocatedBytes,
    int Gen0Collections,
    int Gen1Collections,
    int Gen2Collections,
    int ThreadPoolThreads,
    long PendingWorkItems,
    CacheTelemetrySnapshot SearchCache,
    CacheTelemetrySnapshot ObjectCache);

/// <summary>
/// Emits bounded, process-level telemetry without request or cache-key labels.
/// Logs remain useful on the SBC without requiring a metrics sidecar.
/// </summary>
public sealed class ApiRuntimeTelemetryService : BackgroundService
{
    internal static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(60);

    private readonly SearchResponseCache _searchCache;
    private readonly RecommendationObjectCache _objectCache;
    private readonly ILogger<ApiRuntimeTelemetryService> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _interval;
    private readonly CancellationToken _applicationStopping;

    public ApiRuntimeTelemetryService(
        SearchResponseCache searchCache,
        RecommendationObjectCache objectCache,
        IHostApplicationLifetime applicationLifetime,
        ILogger<ApiRuntimeTelemetryService> logger)
        : this(
            searchCache,
            objectCache,
            logger,
            TimeProvider.System,
            DefaultInterval,
            applicationLifetime.ApplicationStopping)
    {
    }

    internal ApiRuntimeTelemetryService(
        SearchResponseCache searchCache,
        RecommendationObjectCache objectCache,
        ILogger<ApiRuntimeTelemetryService> logger,
        TimeProvider timeProvider,
        TimeSpan interval,
        CancellationToken applicationStopping = default)
    {
        ArgumentNullException.ThrowIfNull(searchCache);
        ArgumentNullException.ThrowIfNull(objectCache);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (interval <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(interval));

        _searchCache = searchCache;
        _objectCache = objectCache;
        _logger = logger;
        _timeProvider = timeProvider;
        _interval = interval;
        _applicationStopping = applicationStopping;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var shutdown = CancellationTokenSource.CreateLinkedTokenSource(
            stoppingToken,
            _applicationStopping);
        var shutdownToken = shutdown.Token;

        try
        {
            LogSnapshot(CaptureSnapshot());
            using var timer = new PeriodicTimer(_interval, _timeProvider);
            while (await timer.WaitForNextTickAsync(shutdownToken))
                LogSnapshot(CaptureSnapshot());
        }
        catch (OperationCanceledException) when (shutdownToken.IsCancellationRequested)
        {
            // Normal host shutdown.
        }
    }

    internal ApiRuntimeTelemetrySnapshot CaptureSnapshot()
    {
        var gc = GC.GetGCMemoryInfo();
        return new ApiRuntimeTelemetrySnapshot(
            Environment.WorkingSet,
            gc.HeapSizeBytes,
            gc.FragmentedBytes,
            GC.GetTotalAllocatedBytes(precise: false),
            GC.CollectionCount(0),
            GC.CollectionCount(1),
            GC.CollectionCount(2),
            ThreadPool.ThreadCount,
            ThreadPool.PendingWorkItemCount,
            _searchCache.TelemetrySnapshot,
            _objectCache.TelemetrySnapshot);
    }

    internal void LogSnapshot(ApiRuntimeTelemetrySnapshot snapshot)
    {
        var search = snapshot.SearchCache;
        var objects = snapshot.ObjectCache;
        _logger.LogInformation(
            "api_runtime_metrics rssBytes={RssBytes} gcHeapBytes={GcHeapBytes} gcFragmentedBytes={GcFragmentedBytes} gcTotalAllocatedBytes={GcTotalAllocatedBytes} gen0Collections={Gen0Collections} gen1Collections={Gen1Collections} gen2Collections={Gen2Collections} threadPoolThreads={ThreadPoolThreads} pendingWorkItems={PendingWorkItems} searchHits={SearchHits} searchMisses={SearchMisses} searchStaleHits={SearchStaleHits} searchRefreshes={SearchRefreshes} searchFollowers={SearchFollowers} searchEvictions={SearchEvictions} searchOversizeSkips={SearchOversizeSkips} searchInFlight={SearchInFlight} searchEntries={SearchEntries} searchEstimatedChargeBytes={SearchEstimatedChargeBytes} searchSizeLimitBytes={SearchSizeLimitBytes} objectHits={ObjectHits} objectMisses={ObjectMisses} objectStaleHits={ObjectStaleHits} objectRefreshes={ObjectRefreshes} objectFollowers={ObjectFollowers} objectEvictions={ObjectEvictions} objectOversizeSkips={ObjectOversizeSkips} objectInFlight={ObjectInFlight} objectEntries={ObjectEntries} objectEstimatedChargeBytes={ObjectEstimatedChargeBytes} objectSizeLimitBytes={ObjectSizeLimitBytes}",
            snapshot.RssBytes,
            snapshot.GcHeapBytes,
            snapshot.GcFragmentedBytes,
            snapshot.GcTotalAllocatedBytes,
            snapshot.Gen0Collections,
            snapshot.Gen1Collections,
            snapshot.Gen2Collections,
            snapshot.ThreadPoolThreads,
            snapshot.PendingWorkItems,
            search.Hits,
            search.Misses,
            search.StaleHits,
            search.Refreshes,
            search.Followers,
            search.Evictions,
            search.OversizeSkips,
            search.InFlight,
            search.CurrentEntries,
            search.EstimatedChargeBytes,
            search.SizeLimitBytes,
            objects.Hits,
            objects.Misses,
            objects.StaleHits,
            objects.Refreshes,
            objects.Followers,
            objects.Evictions,
            objects.OversizeSkips,
            objects.InFlight,
            objects.CurrentEntries,
            objects.EstimatedChargeBytes,
            objects.SizeLimitBytes);
    }
}
