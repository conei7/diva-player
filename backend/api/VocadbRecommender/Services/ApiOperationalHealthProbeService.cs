using System.Diagnostics;

namespace VocadbRecommender.Services;

public sealed record ApiOperationalHealthProbeSnapshot(
    bool Known,
    DependencyHealth Postgres,
    DependencyHealth Qdrant,
    DiscoveryQualityHealth DiscoveryQuality,
    AudioFeatureHealth AudioFeatures,
    DateTimeOffset? CheckedAt);

public sealed class ApiOperationalHealthProbeState
{
    private static readonly DependencyHealth UnknownDependency = new(false, 0, "Unknown");
    private static readonly DiscoveryQualityHealth UnknownDiscoveryQuality = new(
        false, 0, 0, 0, 0, 0, 0, null, new Dictionary<string, long>(), 0, null, "Unknown");
    private static readonly AudioFeatureHealth UnknownAudioFeatures = new(
        false, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, "Unknown");
    private volatile ApiOperationalHealthProbeSnapshot _snapshot = new(
        false,
        UnknownDependency,
        UnknownDependency,
        UnknownDiscoveryQuality,
        UnknownAudioFeatures,
        null);

    public ApiOperationalHealthProbeSnapshot Snapshot => _snapshot;

    public void Publish(
        DependencyHealth postgres,
        DependencyHealth qdrant,
        DiscoveryQualityHealth discoveryQuality,
        AudioFeatureHealth audioFeatures,
        DateTimeOffset checkedAt) =>
        _snapshot = new(true, postgres, qdrant, discoveryQuality, audioFeatures, checkedAt);
}

/// <summary>
/// Refreshes the complete operational health report outside request handling.
/// The endpoint only reads the last immutable snapshot, so the expensive audio
/// and discovery aggregates never add seconds of latency to a caller or fan out
/// when several monitors arrive together.
/// </summary>
public sealed class ApiOperationalHealthProbeService : BackgroundService
{
    internal static readonly TimeSpan ProbeInterval = TimeSpan.FromMinutes(5);
    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(25);
    internal static readonly TimeSpan MaximumSnapshotAge = TimeSpan.FromMinutes(15);

    private readonly Func<CancellationToken, Task<DependencyHealth>> _postgresProbe;
    private readonly Func<CancellationToken, Task<DependencyHealth>> _qdrantProbe;
    private readonly Func<CancellationToken, Task<DiscoveryQualityHealth>> _discoveryProbe;
    private readonly Func<CancellationToken, Task<AudioFeatureHealth>> _audioProbe;
    private readonly ApiDatabaseConnectionBudget _connectionBudget;
    private readonly ApiMaintenanceExecutionGate _maintenanceGate;
    private readonly ApiOperationalHealthProbeState _state;
    private readonly ILogger<ApiOperationalHealthProbeService> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _probeInterval;
    private readonly TimeSpan _probeTimeout;
    private readonly CancellationToken _applicationStopping;
    private readonly SemaphoreSlim _probeGate = new(1, 1);

    public ApiOperationalHealthProbeService(
        DbService db,
        QdrantService qdrant,
        ApiDatabaseConnectionBudget connectionBudget,
        ApiMaintenanceExecutionGate maintenanceGate,
        ApiOperationalHealthProbeState state,
        IHostApplicationLifetime applicationLifetime,
        ILogger<ApiOperationalHealthProbeService> logger)
        : this(
            db.CheckHealthAsync,
            qdrant.CheckHealthAsync,
            db.CheckDiscoveryQualityAsync,
            db.CheckAudioFeatureHealthAsync,
            connectionBudget,
            maintenanceGate,
            state,
            logger,
            TimeProvider.System,
            ProbeInterval,
            ProbeTimeout,
            applicationLifetime.ApplicationStopping)
    {
    }

    internal ApiOperationalHealthProbeService(
        Func<CancellationToken, Task<DependencyHealth>> postgresProbe,
        Func<CancellationToken, Task<DependencyHealth>> qdrantProbe,
        Func<CancellationToken, Task<DiscoveryQualityHealth>> discoveryProbe,
        Func<CancellationToken, Task<AudioFeatureHealth>> audioProbe,
        ApiDatabaseConnectionBudget connectionBudget,
        ApiMaintenanceExecutionGate maintenanceGate,
        ApiOperationalHealthProbeState state,
        ILogger<ApiOperationalHealthProbeService> logger,
        TimeProvider timeProvider,
        TimeSpan probeInterval,
        TimeSpan probeTimeout,
        CancellationToken applicationStopping = default)
    {
        ArgumentNullException.ThrowIfNull(postgresProbe);
        ArgumentNullException.ThrowIfNull(qdrantProbe);
        ArgumentNullException.ThrowIfNull(discoveryProbe);
        ArgumentNullException.ThrowIfNull(audioProbe);
        ArgumentNullException.ThrowIfNull(connectionBudget);
        ArgumentNullException.ThrowIfNull(maintenanceGate);
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (probeInterval <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(probeInterval));
        if (probeTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(probeTimeout));

        _postgresProbe = postgresProbe;
        _qdrantProbe = qdrantProbe;
        _discoveryProbe = discoveryProbe;
        _audioProbe = audioProbe;
        _connectionBudget = connectionBudget;
        _maintenanceGate = maintenanceGate;
        _state = state;
        _logger = logger;
        _timeProvider = timeProvider;
        _probeInterval = probeInterval;
        _probeTimeout = probeTimeout;
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
            await ProbeOnceAsync(shutdownToken);
            using var timer = new PeriodicTimer(_probeInterval, _timeProvider);
            while (await timer.WaitForNextTickAsync(shutdownToken))
                await ProbeOnceAsync(shutdownToken);
        }
        catch (OperationCanceledException) when (shutdownToken.IsCancellationRequested)
        {
            // Normal host shutdown. A canceled probe is never published.
        }
    }

    internal async Task<bool> ProbeOnceAsync(CancellationToken stoppingToken = default)
    {
        if (!await _probeGate.WaitAsync(0, stoppingToken))
            return false;

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            timeout.CancelAfter(_probeTimeout);
            var stopwatch = Stopwatch.StartNew();
            IDisposable maintenanceLease;
            try
            {
                maintenanceLease = await _maintenanceGate.EnterAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (
                !stoppingToken.IsCancellationRequested
                && timeout.IsCancellationRequested)
            {
                PublishTimeoutSnapshot(stopwatch.ElapsedMilliseconds);
                return true;
            }

            using (maintenanceLease)
            using (_connectionBudget.EnterMaintenanceScope())
            {
                // Run the four PostgreSQL-using checks serially under one
                // deadline. Readiness runs outside this gate and retains its
                // two dedicated pool permits.
                var postgres = await ProbeAsync(
                    _postgresProbe,
                    (elapsed, error) => new DependencyHealth(false, elapsed, error),
                    timeout.Token,
                    stoppingToken,
                    stopwatch);
                var qdrant = await ProbeAsync(
                    _qdrantProbe,
                    (elapsed, error) => new DependencyHealth(false, elapsed, error),
                    timeout.Token,
                    stoppingToken,
                    stopwatch);
                var discovery = await ProbeAsync(
                    _discoveryProbe,
                    (elapsed, error) => new DiscoveryQualityHealth(
                        false, elapsed, 0, 0, 0, 0, 0, null,
                        new Dictionary<string, long>(), 0, null, error),
                    timeout.Token,
                    stoppingToken,
                    stopwatch);
                var audio = await ProbeAsync(
                    _audioProbe,
                    (elapsed, error) => new AudioFeatureHealth(
                        false, elapsed, 0, 0, 0, 0, 0, 0, 0, 0, null, null, error),
                    timeout.Token,
                    stoppingToken,
                    stopwatch);
                stoppingToken.ThrowIfCancellationRequested();

                _state.Publish(postgres, qdrant, discovery, audio, _timeProvider.GetUtcNow());
                if (!postgres.Ok || !qdrant.Ok || !discovery.Ok)
                {
                    _logger.LogWarning(
                        "api_operational_health_probe_degraded postgres={PostgresError} qdrant={QdrantError} discovery={DiscoveryError} audio={AudioError}",
                        postgres.Error,
                        qdrant.Error,
                        discovery.Error,
                        audio.Error);
                }
            }
            return true;
        }
        finally
        {
            _probeGate.Release();
        }
    }

    private void PublishTimeoutSnapshot(long elapsedMilliseconds)
    {
        const string error = "Timeout";
        _state.Publish(
            new DependencyHealth(false, elapsedMilliseconds, error),
            new DependencyHealth(false, elapsedMilliseconds, error),
            new DiscoveryQualityHealth(
                false, elapsedMilliseconds, 0, 0, 0, 0, 0, null,
                new Dictionary<string, long>(), 0, null, error),
            new AudioFeatureHealth(
                false, elapsedMilliseconds, 0, 0, 0, 0, 0, 0, 0, 0,
                null, null, error),
            _timeProvider.GetUtcNow());
        _logger.LogWarning(
            "api_operational_health_probe_degraded postgres={PostgresError} qdrant={QdrantError} discovery={DiscoveryError} audio={AudioError}",
            error,
            error,
            error,
            error);
    }

    private static async Task<T> ProbeAsync<T>(
        Func<CancellationToken, Task<T>> probe,
        Func<long, string, T> failureResult,
        CancellationToken probeToken,
        CancellationToken stoppingToken,
        Stopwatch stopwatch)
    {
        try
        {
            return await probe(probeToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (probeToken.IsCancellationRequested)
        {
            return failureResult(stopwatch.ElapsedMilliseconds, "Timeout");
        }
        catch (Exception exception)
        {
            return failureResult(stopwatch.ElapsedMilliseconds, exception.GetType().Name);
        }
    }
}
