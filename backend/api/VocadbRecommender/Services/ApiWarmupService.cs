using System.Diagnostics;

namespace VocadbRecommender.Services;

public sealed record ApiWarmupSnapshot(
    bool Completed,
    long DurationMs,
    IReadOnlyList<string> Failures);

public sealed class ApiWarmupState
{
    private volatile ApiWarmupSnapshot _snapshot = new(false, 0, []);

    public bool Completed => _snapshot.Completed;
    public ApiWarmupSnapshot Snapshot => _snapshot;

    public void Complete(long durationMs, IReadOnlyList<string> failures) =>
        _snapshot = new(true, durationMs, failures);
}

public sealed class ApiWarmupService(
    DbService db,
    ApiDatabaseConnectionBudget connectionBudget,
    ApiMaintenanceExecutionGate maintenanceGate,
    ApiWarmupState state,
    ILogger<ApiWarmupService> logger) : BackgroundService
{
    internal static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(5);

    private (string Name, Func<Task> Run)[] CreateJobs(
        bool forceRefresh,
        CancellationToken cancellationToken) =>
    [
        ("home-recommended", async () =>
        {
            await db.SearchSongsAsync(
                null, null, null, null, null, null,
                "FavoritedTimes", "desc", 0, 12,
                onlyWithPVs: true,
                discoveryOnly: true,
                forceRefresh: forceRefresh,
                cancellationToken: cancellationToken);
        }),
        ("home-weekly", () => db.GetTrendingSongsJsonAsync(
            7, 0, 24, "weekly", forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
        ("home-popular", () => db.GetTrendingSongsJsonAsync(
            30, 0, 24, "alltime", forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
        ("home-pace", () => db.GetTrendingSongsJsonAsync(
            30, 0, 24, "pace", forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
        ("home-surge", () => db.GetTrendingSongsJsonAsync(
            7, 0, 24, "surge", forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
        ("home-recent", () => db.GetTrendingSongsJsonAsync(
            30, 0, 24, "recent", forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
        ("home-deep", () => db.GetTrendingSongsJsonAsync(
            30, 0, 24, "deep", seed: 0, forceRefresh: forceRefresh, cancellationToken: cancellationToken)),
    ];

    private async Task<List<string>> RunJobsAsync(
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var failures = new List<string>();
        foreach (var job in CreateJobs(forceRefresh, cancellationToken))
        {
            if (cancellationToken.IsCancellationRequested) break;
            try
            {
                await job.Run();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                failures.Add($"{job.Name}:{exception.GetType().Name}");
                logger.LogWarning(
                    exception,
                    forceRefresh ? "api_warmup_refresh_failed job={Job}" : "api_warmup_failed job={Job}",
                    job.Name);
            }
        }
        return failures;
    }

    private async Task<List<string>> RunMaintenanceJobsAsync(
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        using var maintenanceLease = await maintenanceGate.EnterAsync(cancellationToken);
        using var connectionScope = connectionBudget.EnterMaintenanceScope();
        return await RunJobsAsync(forceRefresh, cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var failures = await RunMaintenanceJobsAsync(
            forceRefresh: false,
            cancellationToken: stoppingToken);

        stopwatch.Stop();
        state.Complete(stopwatch.ElapsedMilliseconds, failures);
        logger.LogInformation(
            "api_warmup_completed durationMs={DurationMs} failures={Failures}",
            stopwatch.ElapsedMilliseconds,
            failures.Count);

        using var timer = new PeriodicTimer(RefreshInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var refreshStopwatch = Stopwatch.StartNew();
                var refreshFailures = await RunMaintenanceJobsAsync(
                    forceRefresh: true,
                    cancellationToken: stoppingToken);
                refreshStopwatch.Stop();
                logger.LogInformation(
                    "api_warmup_refresh_completed durationMs={DurationMs} failures={Failures}",
                    refreshStopwatch.ElapsedMilliseconds,
                    refreshFailures.Count);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal host shutdown interrupts the periodic wait.
        }
    }
}
