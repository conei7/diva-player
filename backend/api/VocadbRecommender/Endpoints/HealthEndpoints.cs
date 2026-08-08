using VocadbRecommender.Services;

internal static class HealthEndpoints
{
    private static readonly SemaphoreSlim HealthGate = new(1, 1);
    private static HealthSnapshot? healthSnapshot;

    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/ready", GetReadinessAsync).DisableRateLimiting();
        endpoints.MapGet("/api/health", GetHealthAsync);
        return endpoints;
    }

    private static async Task<IResult> GetReadinessAsync(
        DbService db,
        QdrantService qdrant,
        ApiWarmupState warmup,
        CancellationToken cancellationToken)
    {
        var warmupSnapshot = warmup.Snapshot;
        if (!warmupSnapshot.Completed)
        {
            return Results.Json(
                new { status = "warming", warmup = warmupSnapshot },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var postgresTask = db.CheckHealthAsync(cancellationToken);
        var qdrantTask = qdrant.CheckHealthAsync(cancellationToken);
        await Task.WhenAll(postgresTask, qdrantTask);
        var postgres = await postgresTask;
        var qdrantStatus = await qdrantTask;
        var ready = postgres.Ok
            && qdrantStatus.Ok
            && warmupSnapshot.Failures.Count == 0;

        return Results.Json(
            new
            {
                status = ready ? "ready" : "degraded",
                dependencies = new { postgres, qdrant = qdrantStatus },
                warmup = warmupSnapshot,
            },
            statusCode: ready
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable);
    }

    private static async Task<IResult> GetHealthAsync(
        DbService db,
        QdrantService qdrant,
        CancellationToken cancellationToken)
    {
        await HealthGate.WaitAsync(cancellationToken);
        try
        {
            if (healthSnapshot is not null && healthSnapshot.ExpiresAt > DateTimeOffset.UtcNow)
                return Results.Json(healthSnapshot.Payload, statusCode: healthSnapshot.StatusCode);

            var postgresTask = db.CheckHealthAsync(cancellationToken);
            var qdrantTask = qdrant.CheckHealthAsync(cancellationToken);
            var discoveryTask = db.CheckDiscoveryQualityAsync(cancellationToken);
            var audioFeatureTask = db.CheckAudioFeatureHealthAsync(cancellationToken);
            await Task.WhenAll(postgresTask, qdrantTask, discoveryTask, audioFeatureTask);
            var postgres = await postgresTask;
            var qdrantStatus = await qdrantTask;
            var discoveryQuality = await discoveryTask;
            var audioFeatures = await audioFeatureTask;
            var ready = postgres.Ok && qdrantStatus.Ok && discoveryQuality.Ok;
            var payload = new HealthPayload(
                ready ? "ok" : "degraded",
                new { postgres, qdrant = qdrantStatus },
                discoveryQuality,
                audioFeatures);
            healthSnapshot = new HealthSnapshot(
                payload,
                ready ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable,
                DateTimeOffset.UtcNow.AddSeconds(30));

            return Results.Json(payload, statusCode: healthSnapshot.StatusCode);
        }
        finally
        {
            HealthGate.Release();
        }
    }
}

internal record HealthPayload(
    string status,
    object dependencies,
    DiscoveryQualityHealth discoveryQuality,
    AudioFeatureHealth audioFeatures);

internal record HealthSnapshot(
    HealthPayload Payload,
    int StatusCode,
    DateTimeOffset ExpiresAt);
