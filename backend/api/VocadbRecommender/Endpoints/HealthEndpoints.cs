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

    private static IResult GetReadinessAsync(
        ApiWarmupState warmup,
        ApiReadinessProbeState readiness)
    {
        var response = CreateReadinessResponse(
            warmup.Snapshot,
            readiness.Snapshot,
            TimeProvider.System.GetUtcNow(),
            ApiReadinessProbeService.MaximumSnapshotAge);
        return Results.Json(response.Payload, statusCode: response.StatusCode);
    }

    internal static ReadinessEndpointResponse CreateReadinessResponse(
        ApiWarmupSnapshot warmupSnapshot,
        ApiReadinessProbeSnapshot readinessSnapshot,
        DateTimeOffset now,
        TimeSpan maximumSnapshotAge)
    {
        if (maximumSnapshotAge <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(maximumSnapshotAge));

        if (!warmupSnapshot.Completed)
        {
            return new ReadinessEndpointResponse(
                new WarmingReadinessPayload("warming", warmupSnapshot),
                StatusCodes.Status503ServiceUnavailable);
        }

        var snapshotAge = readinessSnapshot.CheckedAt is { } checkedAt && checkedAt <= now
            ? now - checkedAt
            : TimeSpan.MaxValue;
        var snapshotFresh = readinessSnapshot.Known
            && snapshotAge <= maximumSnapshotAge;
        var ready = snapshotFresh
            && readinessSnapshot.Postgres.Ok
            && readinessSnapshot.Qdrant.Ok
            && warmupSnapshot.Failures.Count == 0;
        return new ReadinessEndpointResponse(
            new ReadinessPayload(
                ready ? "ready" : "degraded",
                new ReadinessDependencies(
                    readinessSnapshot.Postgres,
                    readinessSnapshot.Qdrant),
                warmupSnapshot),
            ready
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

internal sealed record ReadinessEndpointResponse(object Payload, int StatusCode);

internal sealed record WarmingReadinessPayload(
    string Status,
    ApiWarmupSnapshot Warmup);

internal sealed record ReadinessDependencies(
    DependencyHealth Postgres,
    DependencyHealth Qdrant);

internal sealed record ReadinessPayload(
    string Status,
    ReadinessDependencies Dependencies,
    ApiWarmupSnapshot Warmup);
