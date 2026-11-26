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
    // Each forced refresh of the seven rankings takes three to four minutes on the SBC. At a
    // five-minute interval on both slots PostgreSQL was busy with them most of the time, which
    // slowed every other request and kept a new candidate's warmup past the 180-second rolling
    // deadline. Rankings are served stale-while-revalidate between refreshes anyway.
    internal static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(30);

    // Readiness waits only for what Home shows and prefetches first; the other rankings warm
    // up right after, and a request that arrives earlier joins the same computation.
    internal static readonly string[] ReadinessJobs = ["home-recommended", "home-popular"];

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
        CancellationToken cancellationToken,
        Func<string, bool>? include = null)
    {
        var failures = new List<string>();
        foreach (var job in CreateJobs(forceRefresh, cancellationToken).Where(job => include?.Invoke(job.Name) ?? true))
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
        CancellationToken cancellationToken,
        Func<string, bool>? include = null)
    {
        using var maintenanceLease = await maintenanceGate.EnterAsync(cancellationToken);
        using var connectionScope = connectionBudget.EnterMaintenanceScope();
        return await RunJobsAsync(forceRefresh, cancellationToken, include);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var failures = await RunMaintenanceJobsAsync(
            forceRefresh: false,
            cancellationToken: stoppingToken,
            include: ReadinessJobs.Contains);

        stopwatch.Stop();
        state.Complete(stopwatch.ElapsedMilliseconds, failures);
        logger.LogInformation(
            "api_warmup_completed durationMs={DurationMs} failures={Failures}",
            stopwatch.ElapsedMilliseconds,
            failures.Count);

        var deferredStopwatch = Stopwatch.StartNew();
        var deferredFailures = await RunMaintenanceJobsAsync(
            forceRefresh: false,
            cancellationToken: stoppingToken,
            include: name => !ReadinessJobs.Contains(name));
        logger.LogInformation(
            "api_warmup_deferred_completed durationMs={DurationMs} failures={Failures}",
            deferredStopwatch.ElapsedMilliseconds,
            deferredFailures.Count);

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
