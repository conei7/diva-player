namespace VocadbRecommender.Services;

/// <summary>
/// Recomputes the recently requested seeds after the pipeline publishes a new
/// generation. Stored rankings are keyed by generation, so after each daily
/// publication every listener's first Home would otherwise pay the full
/// recommendation cost (about two seconds per seed on the SBC). Work runs one
/// seed at a time inside the maintenance lane and inside a publication lease,
/// so listeners keep priority and a publication in progress is never read.
/// </summary>
public sealed class RecommendationSeedWarmer(
    IServiceScopeFactory scopes,
    DbService db,
    QdrantService qdrant,
    RecommendationResultCache results,
    RecommendationPublicationGuard guard,
    ApiDatabaseConnectionBudget connectionBudget,
    ApiMaintenanceExecutionGate maintenanceGate,
    ApiWarmupState warmup,
    ILogger<RecommendationSeedWarmer> logger) : BackgroundService
{
    internal static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(2);
    internal static readonly TimeSpan PauseBetweenSeeds = TimeSpan.FromMilliseconds(200);
    internal const int MaxSeedsPerGeneration = 120;
    internal const int CardWindow = 96;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        string? warmedGeneration = null;
        using var timer = new PeriodicTimer(CheckInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (!warmup.Completed) continue;
                string generation;
                try
                {
                    generation = await db.GetRecommendationPublicationGenerationAsync(stoppingToken);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    logger.LogWarning(exception, "recommendation_seed_warm_generation_failed");
                    continue;
                }

                // The first generation seen is the one listeners are already filling.
                if (warmedGeneration is null)
                {
                    warmedGeneration = generation;
                    continue;
                }
                if (generation == warmedGeneration) continue;

                if (await WarmAsync(generation, stoppingToken))
                    warmedGeneration = generation;
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal host shutdown interrupts the periodic wait.
        }
    }

    /// <returns>True when every seed was handled; false to retry on the next tick.</returns>
    private async Task<bool> WarmAsync(string generation, CancellationToken cancellationToken)
    {
        var seeds = results.RecentSeeds(MaxSeedsPerGeneration);
        var warmed = 0;
        var failed = 0;
        foreach (var seed in seeds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await using var lease = await guard.TryEnterAsync(cancellationToken);
            if (lease is null)
            {
                logger.LogInformation(
                    "recommendation_seed_warm_deferred generation={Generation} warmed={Warmed}",
                    generation, warmed);
                return false;
            }

            // A newer publication makes the rest of this pass useless.
            if (await db.GetRecommendationPublicationGenerationAsync(cancellationToken) != generation)
                return false;

            try
            {
                using var maintenanceLease = await maintenanceGate.EnterAsync(cancellationToken);
                using var connectionScope = connectionBudget.EnterMaintenanceScope();
                await using var scope = scopes.CreateAsyncScope();
                var recommender = scope.ServiceProvider.GetRequiredService<RecommendService>();
                var (ranking, _) = await RecommendationWindow.GetAsync(
                    recommender, db, results, seed, 0.0, cancellationToken, noteSeed: false);
                var (audio, _) = await AudioSimilarity.GetAsync(qdrant, db, results, seed, cancellationToken);
                var cardIds = ranking.Items.Take(CardWindow).Select(item => item.SongId)
                    .Concat(audio.Take(CardWindow).Select(item => item.songId))
                    .Distinct()
                    .ToArray();
                await results.GetSongCardJsonAsync(db, cardIds, cancellationToken);
                warmed++;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning(exception, "recommendation_seed_warm_failed seed={Seed}", seed);
            }

            await Task.Delay(PauseBetweenSeeds, cancellationToken);
        }

        logger.LogInformation(
            "recommendation_seed_warm_completed generation={Generation} warmed={Warmed} failed={Failed}",
            generation, warmed, failed);
        return true;
    }
}
