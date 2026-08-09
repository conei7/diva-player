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
    ApiWarmupState state,
    ILogger<ApiWarmupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var failures = new List<string>();
        var jobs = new (string Name, Func<Task> Run)[]
        {
            ("home-recommended", async () =>
            {
                await db.SearchSongsAsync(
                    null, null, null, null, null, null,
                    "FavoritedTimes", "desc", 0, 12,
                    onlyWithPVs: true,
                    discoveryOnly: true,
                    cancellationToken: stoppingToken);
            }),
            ("home-popular", () => db.GetTrendingSongsJsonAsync(
                30, 0, 24, "alltime", cancellationToken: stoppingToken)),
            ("home-pace", () => db.GetTrendingSongsJsonAsync(
                30, 0, 24, "pace", cancellationToken: stoppingToken)),
            ("home-surge", () => db.GetTrendingSongsJsonAsync(
                7, 0, 24, "surge", cancellationToken: stoppingToken)),
            ("home-recent", () => db.GetTrendingSongsJsonAsync(
                30, 0, 24, "recent", cancellationToken: stoppingToken)),
        };

        foreach (var job in jobs)
        {
            if (stoppingToken.IsCancellationRequested) break;
            try
            {
                await job.Run();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                failures.Add($"{job.Name}:{exception.GetType().Name}");
                logger.LogWarning(exception, "api_warmup_failed job={Job}", job.Name);
            }
        }

        stopwatch.Stop();
        state.Complete(stopwatch.ElapsedMilliseconds, failures);
        logger.LogInformation(
            "api_warmup_completed durationMs={DurationMs} failures={Failures}",
            stopwatch.ElapsedMilliseconds,
            failures.Count);
    }
}
