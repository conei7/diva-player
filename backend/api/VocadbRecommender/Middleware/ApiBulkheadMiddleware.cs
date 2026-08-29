using System.Globalization;
using System.Text.Json;

namespace VocadbRecommender;

internal sealed record ApiBulkheadOptions(
    int HeavyPermitLimit,
    int HeavyQueueLimit,
    int StandardPermitLimit,
    int StandardQueueLimit,
    int ProviderPermitLimit,
    int ProviderQueueLimit,
    int QueueTimeoutMilliseconds)
{
    internal const int DefaultHeavyPermitLimit = 12;
    internal const int DefaultHeavyQueueLimit = 12;
    internal const int DefaultStandardPermitLimit = 24;
    internal const int DefaultStandardQueueLimit = 24;
    internal const int DefaultProviderPermitLimit = 4;
    internal const int DefaultProviderQueueLimit = 4;
    internal const int DefaultQueueTimeoutMilliseconds = 2_000;

    internal static ApiBulkheadOptions FromConfiguration(IConfiguration configuration)
    {
        var section = configuration.GetSection("Recommender:Bulkhead");
        return new ApiBulkheadOptions(
            ReadBoundedInt(section, "HeavyPermitLimit", DefaultHeavyPermitLimit, 1, 64),
            ReadBoundedInt(section, "HeavyQueueLimit", DefaultHeavyQueueLimit, 0, 128),
            ReadBoundedInt(section, "StandardPermitLimit", DefaultStandardPermitLimit, 1, 128),
            ReadBoundedInt(section, "StandardQueueLimit", DefaultStandardQueueLimit, 0, 256),
            ReadBoundedInt(section, "ProviderPermitLimit", DefaultProviderPermitLimit, 1, 32),
            ReadBoundedInt(section, "ProviderQueueLimit", DefaultProviderQueueLimit, 0, 64),
            ReadBoundedInt(section, "QueueTimeoutMilliseconds", DefaultQueueTimeoutMilliseconds, 100, 5_000));
    }

    private static int ReadBoundedInt(
        IConfiguration section,
        string key,
        int defaultValue,
        int minimum,
        int maximum)
    {
        var raw = section[key];
        if (string.IsNullOrWhiteSpace(raw)) return defaultValue;
        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            || value < minimum
            || value > maximum)
        {
            throw new InvalidOperationException(
                $"Recommender:Bulkhead:{key} must be an integer between {minimum} and {maximum}.");
        }
        return value;
    }
}

internal sealed class ApiBulkheadMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ApiBulkheadMiddleware> _logger;
    private readonly TimeSpan _queueTimeout;
    private readonly IReadOnlyDictionary<ApiBulkheadLane, BulkheadLane> _lanes;

    internal enum ApiBulkheadLane
    {
        Bypass,
        Heavy,
        Standard,
        Provider,
    }

    public ApiBulkheadMiddleware(
        RequestDelegate next,
        ApiBulkheadOptions options,
        ILogger<ApiBulkheadMiddleware> logger)
    {
        _next = next;
        _logger = logger;
        _queueTimeout = TimeSpan.FromMilliseconds(options.QueueTimeoutMilliseconds);
        _lanes = new Dictionary<ApiBulkheadLane, BulkheadLane>
        {
            [ApiBulkheadLane.Heavy] = new(
                "heavy",
                options.HeavyPermitLimit,
                options.HeavyQueueLimit),
            [ApiBulkheadLane.Standard] = new(
                "standard",
                options.StandardPermitLimit,
                options.StandardQueueLimit),
            [ApiBulkheadLane.Provider] = new(
                "provider",
                options.ProviderPermitLimit,
                options.ProviderQueueLimit),
        };
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var laneKind = Classify(context.Request.Path);
        if (laneKind == ApiBulkheadLane.Bypass)
        {
            await _next(context);
            return;
        }

        var lane = _lanes[laneKind];
        if (!lane.TryAdmit())
        {
            await RejectAsync(context, lane, "capacity");
            return;
        }

        var executing = false;
        try
        {
            try
            {
                executing = await lane.WaitForExecutionAsync(
                    _queueTimeout,
                    context.RequestAborted);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                return;
            }

            if (!executing)
            {
                await RejectAsync(context, lane, "queue-timeout");
                return;
            }

            context.Response.Headers["X-Diva-Bulkhead"] = lane.Name;
            await _next(context);
        }
        finally
        {
            if (executing) lane.ReleaseExecution();
            lane.ReleaseAdmission();
        }
    }

    internal static ApiBulkheadLane Classify(PathString path)
    {
        if (path.Equals("/api/ready", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/api/health", StringComparison.OrdinalIgnoreCase))
        {
            return ApiBulkheadLane.Bypass;
        }

        if (path.StartsWithSegments("/api/youtube/playlists")
            || path.StartsWithSegments("/api/nico/playlists"))
        {
            return ApiBulkheadLane.Provider;
        }

        if (path.StartsWithSegments("/api/recommend")
            || path.StartsWithSegments("/api/songs/search")
            || path.StartsWithSegments("/api/songs/trending")
            || path.StartsWithSegments("/api/search/tags")
            || path.StartsWithSegments("/api/discovery/knowledge-map"))
        {
            return ApiBulkheadLane.Heavy;
        }

        return ApiBulkheadLane.Standard;
    }

    private async Task RejectAsync(HttpContext context, BulkheadLane lane, string reason)
    {
        const int retryAfterSeconds = 1;
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers.RetryAfter = retryAfterSeconds.ToString(CultureInfo.InvariantCulture);
        context.Response.Headers["X-Diva-Rate-Limit"] = $"concurrency;{lane.Name}";
        context.Response.Headers["X-Diva-Bulkhead"] = lane.Name;
        _logger.LogWarning(
            "bulkhead_rejected path={Path} lane={Lane} reason={Reason} traceId={TraceId}",
            context.Request.Path.Value,
            lane.Name,
            reason,
            context.TraceIdentifier);
        await JsonSerializer.SerializeAsync(
            context.Response.Body,
            new
            {
                error = "server_busy",
                retryAfterSeconds,
                lane = lane.Name,
            },
            cancellationToken: CancellationToken.None);
    }

    private sealed class BulkheadLane
    {
        private readonly SemaphoreSlim _admission;
        private readonly SemaphoreSlim _execution;

        internal BulkheadLane(string name, int permitLimit, int queueLimit)
        {
            Name = name;
            _admission = new SemaphoreSlim(checked(permitLimit + queueLimit));
            _execution = new SemaphoreSlim(permitLimit);
        }

        internal string Name { get; }

        internal bool TryAdmit() => _admission.Wait(0);

        internal Task<bool> WaitForExecutionAsync(TimeSpan timeout, CancellationToken cancellationToken) =>
            _execution.WaitAsync(timeout, cancellationToken);

        internal void ReleaseExecution() => _execution.Release();

        internal void ReleaseAdmission() => _admission.Release();
    }
}
