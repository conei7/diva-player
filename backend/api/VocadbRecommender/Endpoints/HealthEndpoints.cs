using VocadbRecommender.Services;

internal static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/ready", GetReadinessAsync).DisableRateLimiting();
        endpoints.MapGet("/api/health", GetHealth);
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

    private static IResult GetHealth(ApiOperationalHealthProbeState health)
    {
        var response = CreateOperationalHealthResponse(
            health.Snapshot,
            TimeProvider.System.GetUtcNow(),
            ApiOperationalHealthProbeService.MaximumSnapshotAge);
        return Results.Json(response.Payload, statusCode: response.StatusCode);
    }

    internal static OperationalHealthEndpointResponse CreateOperationalHealthResponse(
        ApiOperationalHealthProbeSnapshot snapshot,
        DateTimeOffset now,
        TimeSpan maximumSnapshotAge)
    {
        if (maximumSnapshotAge <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(maximumSnapshotAge));

        var snapshotAge = snapshot.CheckedAt is { } checkedAt && checkedAt <= now
            ? now - checkedAt
            : TimeSpan.MaxValue;
        var fresh = snapshot.Known && snapshotAge <= maximumSnapshotAge;
        var postgres = ApplyComponentFreshness(
            snapshot.Postgres,
            snapshot.PostgresLastSuccessfulAt,
            now,
            maximumSnapshotAge);
        var qdrant = ApplyComponentFreshness(
            snapshot.Qdrant,
            snapshot.QdrantLastSuccessfulAt,
            now,
            maximumSnapshotAge);
        var discoveryQuality = ApplyComponentFreshness(
            snapshot.DiscoveryQuality,
            snapshot.DiscoveryQualityLastSuccessfulAt,
            now,
            maximumSnapshotAge);
        var audioFeatures = ApplyComponentFreshness(
            snapshot.AudioFeatures,
            snapshot.AudioFeaturesLastSuccessfulAt,
            now,
            maximumSnapshotAge);
        var healthy = fresh
            && postgres.Ok
            && qdrant.Ok
            && discoveryQuality.Ok;
        var payload = new HealthPayload(
            healthy ? "ok" : "degraded",
            new HealthDependencies(postgres, qdrant),
            discoveryQuality,
            audioFeatures);
        return new OperationalHealthEndpointResponse(
            payload,
            healthy
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable);
    }

    private static DependencyHealth ApplyComponentFreshness(
        DependencyHealth health,
        DateTimeOffset? lastSuccessfulAt,
        DateTimeOffset now,
        TimeSpan maximumAge)
    {
        if (IsFresh(lastSuccessfulAt, now, maximumAge) || !health.Ok)
            return health;
        return health with { Ok = false, Error = "Stale" };
    }

    private static DiscoveryQualityHealth ApplyComponentFreshness(
        DiscoveryQualityHealth health,
        DateTimeOffset? lastSuccessfulAt,
        DateTimeOffset now,
        TimeSpan maximumAge)
    {
        if (IsFresh(lastSuccessfulAt, now, maximumAge) || !health.Ok)
            return health;
        return health with { Ok = false, Error = "Stale" };
    }

    private static AudioFeatureHealth ApplyComponentFreshness(
        AudioFeatureHealth health,
        DateTimeOffset? lastSuccessfulAt,
        DateTimeOffset now,
        TimeSpan maximumAge)
    {
        if (IsFresh(lastSuccessfulAt, now, maximumAge) || !health.Ok)
            return health;
        return health with { Ok = false, Error = "Stale" };
    }

    private static bool IsFresh(
        DateTimeOffset? lastSuccessfulAt,
        DateTimeOffset now,
        TimeSpan maximumAge) =>
        lastSuccessfulAt is { } checkedAt
        && checkedAt <= now
        && now - checkedAt <= maximumAge;
}

internal record HealthPayload(
    string status,
    HealthDependencies dependencies,
    DiscoveryQualityHealth discoveryQuality,
    AudioFeatureHealth audioFeatures);

internal sealed record HealthDependencies(
    DependencyHealth Postgres,
    DependencyHealth Qdrant);

internal sealed record OperationalHealthEndpointResponse(
    HealthPayload Payload,
    int StatusCode);

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
