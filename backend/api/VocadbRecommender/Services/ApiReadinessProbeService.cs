using System.Diagnostics;

namespace VocadbRecommender.Services;

public sealed record ApiReadinessProbeSnapshot(
    bool Known,
    DependencyHealth Postgres,
    DependencyHealth Qdrant,
    DateTimeOffset? CheckedAt);

public sealed class ApiReadinessProbeState
{
    private static readonly DependencyHealth UnknownDependency = new(false, 0, "Unknown");
    private volatile ApiReadinessProbeSnapshot _snapshot = new(
        false,
        UnknownDependency,
        UnknownDependency,
        null);

    public ApiReadinessProbeSnapshot Snapshot => _snapshot;

    public void Publish(
        DependencyHealth postgres,
        DependencyHealth qdrant,
        DateTimeOffset checkedAt) =>
        _snapshot = new(true, postgres, qdrant, checkedAt);
}

/// <summary>
/// Periodically probes request-serving dependencies. Readiness requests only
/// read the last immutable snapshot, so Docker and HAProxy checks cannot fan
/// out into overlapping PostgreSQL/Qdrant work.
/// </summary>
public sealed class ApiReadinessProbeService : BackgroundService
{
    internal static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(5);
    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(4);
    internal static readonly TimeSpan MaximumSnapshotAge = TimeSpan.FromSeconds(15);

    private readonly Func<CancellationToken, Task<DependencyHealth>> _postgresProbe;
    private readonly Func<CancellationToken, Task<DependencyHealth>> _qdrantProbe;
    private readonly ApiDatabaseConnectionBudget _connectionBudget;
    private readonly ApiReadinessProbeState _state;
    private readonly ILogger<ApiReadinessProbeService> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _probeInterval;
    private readonly TimeSpan _probeTimeout;
    private readonly CancellationToken _applicationStopping;
    private readonly SemaphoreSlim _probeGate = new(1, 1);

    public ApiReadinessProbeService(
        DbService db,
        QdrantService qdrant,
        ApiDatabaseConnectionBudget connectionBudget,
        ApiReadinessProbeState state,
        IHostApplicationLifetime applicationLifetime,
        ILogger<ApiReadinessProbeService> logger)
        : this(
            db.CheckHealthAsync,
            qdrant.CheckHealthAsync,
            connectionBudget,
            state,
            logger,
            TimeProvider.System,
            ProbeInterval,
            ProbeTimeout,
            applicationLifetime.ApplicationStopping)
    {
    }

    internal ApiReadinessProbeService(
        Func<CancellationToken, Task<DependencyHealth>> postgresProbe,
        Func<CancellationToken, Task<DependencyHealth>> qdrantProbe,
        ApiDatabaseConnectionBudget connectionBudget,
        ApiReadinessProbeState state,
        ILogger<ApiReadinessProbeService> logger,
        TimeProvider timeProvider,
        TimeSpan probeInterval,
        TimeSpan probeTimeout,
        CancellationToken applicationStopping = default)
    {
        ArgumentNullException.ThrowIfNull(postgresProbe);
        ArgumentNullException.ThrowIfNull(qdrantProbe);
        ArgumentNullException.ThrowIfNull(connectionBudget);
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (probeInterval <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(probeInterval));
        if (probeTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(probeTimeout));

        _postgresProbe = postgresProbe;
        _qdrantProbe = qdrantProbe;
        _connectionBudget = connectionBudget;
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
            using var connectionScope = _connectionBudget.EnterReadinessScope();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            timeout.CancelAfter(_probeTimeout);
            var stopwatch = Stopwatch.StartNew();
            var postgresTask = ProbeDependencyAsync(_postgresProbe, timeout.Token, stoppingToken, stopwatch);
            var qdrantTask = ProbeDependencyAsync(_qdrantProbe, timeout.Token, stoppingToken, stopwatch);
            await Task.WhenAll(postgresTask, qdrantTask);
            stoppingToken.ThrowIfCancellationRequested();

            var postgres = await postgresTask;
            var qdrant = await qdrantTask;
            _state.Publish(postgres, qdrant, _timeProvider.GetUtcNow());
            if (!postgres.Ok || !qdrant.Ok)
            {
                _logger.LogWarning(
                    "api_readiness_probe_degraded postgresOk={PostgresOk} postgresError={PostgresError} qdrantOk={QdrantOk} qdrantError={QdrantError}",
                    postgres.Ok,
                    postgres.Error,
                    qdrant.Ok,
                    qdrant.Error);
            }
            return true;
        }
        finally
        {
            _probeGate.Release();
        }
    }

    private async Task<DependencyHealth> ProbeDependencyAsync(
        Func<CancellationToken, Task<DependencyHealth>> probe,
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
            return new DependencyHealth(false, stopwatch.ElapsedMilliseconds, "Timeout");
        }
        catch (Exception exception)
        {
            return new DependencyHealth(false, stopwatch.ElapsedMilliseconds, exception.GetType().Name);
        }
    }
}
