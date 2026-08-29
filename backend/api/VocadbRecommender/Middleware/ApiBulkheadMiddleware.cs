using Npgsql;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace VocadbRecommender;

internal sealed record ApiBulkheadOptions(
    int AggregatePermitLimit,
    int DatabaseConnectionReserve,
    int DatabaseMaximumPoolSize,
    int HeavyPermitLimit,
    int HeavyQueueLimit,
    int StandardPermitLimit,
    int StandardQueueLimit,
    int ProviderPermitLimit,
    int ProviderQueueLimit,
    int QueueTimeoutMilliseconds)
{
    internal const int DefaultAggregatePermitLimit = 6;
    internal const int DefaultDatabaseConnectionReserve = 4;
    internal const int DefaultHeavyPermitLimit = 6;
    internal const int DefaultHeavyQueueLimit = 6;
    internal const int DefaultStandardPermitLimit = 6;
    internal const int DefaultStandardQueueLimit = 8;
    internal const int DefaultProviderPermitLimit = 2;
    internal const int DefaultProviderQueueLimit = 2;
    internal const int DefaultQueueTimeoutMilliseconds = 1_500;

    internal static ApiBulkheadOptions FromConfiguration(IConfiguration configuration)
    {
        var section = configuration.GetSection("Recommender:Bulkhead");
        var connectionString = configuration.GetConnectionString("Postgres");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException(
                "ConnectionStrings:Postgres is required for pool-aware bulkhead validation.");
        }

        NpgsqlConnectionStringBuilder postgres;
        try
        {
            postgres = new NpgsqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            throw new InvalidOperationException(
                "ConnectionStrings:Postgres is invalid for pool-aware bulkhead validation.");
        }
        if (!postgres.Pooling)
        {
            throw new InvalidOperationException(
                "ConnectionStrings:Postgres must enable pooling for bounded API execution.");
        }

        var aggregatePermitLimit = ReadBoundedInt(
            section,
            "AggregatePermitLimit",
            DefaultAggregatePermitLimit,
            1,
            64);
        var databaseConnectionReserve = ReadBoundedInt(
            section,
            "DatabaseConnectionReserve",
            DefaultDatabaseConnectionReserve,
            ApiDatabaseConnectionBudget.RequiredConnectionReserve,
            64);
        var options = new ApiBulkheadOptions(
            aggregatePermitLimit,
            databaseConnectionReserve,
            postgres.MaxPoolSize,
            ReadBoundedInt(section, "HeavyPermitLimit", DefaultHeavyPermitLimit, 1, 64),
            ReadBoundedInt(section, "HeavyQueueLimit", DefaultHeavyQueueLimit, 0, 128),
            ReadBoundedInt(section, "StandardPermitLimit", DefaultStandardPermitLimit, 1, 128),
            ReadBoundedInt(section, "StandardQueueLimit", DefaultStandardQueueLimit, 0, 256),
            ReadBoundedInt(section, "ProviderPermitLimit", DefaultProviderPermitLimit, 1, 32),
            ReadBoundedInt(section, "ProviderQueueLimit", DefaultProviderQueueLimit, 0, 64),
            ReadBoundedInt(section, "QueueTimeoutMilliseconds", DefaultQueueTimeoutMilliseconds, 100, 5_000));

        if (options.HeavyPermitLimit > aggregatePermitLimit
            || options.StandardPermitLimit > aggregatePermitLimit
            || options.ProviderPermitLimit > aggregatePermitLimit)
        {
            throw new InvalidOperationException(
                "Every Recommender:Bulkhead lane permit limit must be less than or equal to AggregatePermitLimit.");
        }

        var foregroundConnectionLimit = checked(
            postgres.MaxPoolSize - databaseConnectionReserve);
        if (foregroundConnectionLimit < 1)
        {
            throw new InvalidOperationException(
                "Recommender:Bulkhead:DatabaseConnectionReserve must be smaller than "
                + $"ConnectionStrings:Postgres Maximum Pool Size ({postgres.MaxPoolSize}).");
        }
        if (aggregatePermitLimit > foregroundConnectionLimit)
        {
            throw new InvalidOperationException(
                $"Recommender:Bulkhead:AggregatePermitLimit ({aggregatePermitLimit}) must not exceed "
                + $"the foreground PostgreSQL connection budget ({foregroundConnectionLimit}).");
        }

        return options;
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
    private readonly SemaphoreSlim _aggregateExecution;
    private readonly ApiDatabaseConnectionBudget _databaseConnectionBudget;

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
        ApiDatabaseConnectionBudget databaseConnectionBudget,
        ILogger<ApiBulkheadMiddleware> logger)
    {
        _next = next;
        _logger = logger;
        _databaseConnectionBudget = databaseConnectionBudget;
        _queueTimeout = TimeSpan.FromMilliseconds(options.QueueTimeoutMilliseconds);
        _aggregateExecution = new SemaphoreSlim(options.AggregatePermitLimit);
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
        if (HttpMethods.IsOptions(context.Request.Method)
            || laneKind == ApiBulkheadLane.Bypass)
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

        var queueStartedAt = Stopwatch.GetTimestamp();
        var laneExecuting = false;
        var aggregateExecuting = false;
        try
        {
            try
            {
                laneExecuting = await lane.WaitForExecutionAsync(
                    RemainingQueueTime(queueStartedAt),
                    context.RequestAborted);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                return;
            }

            if (!laneExecuting)
            {
                await RejectAsync(context, lane, "queue-timeout");
                return;
            }

            try
            {
                aggregateExecuting = await _aggregateExecution.WaitAsync(
                    RemainingQueueTime(queueStartedAt),
                    context.RequestAborted);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                return;
            }

            if (!aggregateExecuting)
            {
                await RejectAsync(context, lane, "aggregate-queue-timeout");
                return;
            }

            context.Response.Headers["X-Diva-Bulkhead"] = lane.Name;
            using var databaseRequestScope = _databaseConnectionBudget.EnterRequestScope();
            await _next(context);
        }
        finally
        {
            if (aggregateExecuting) _aggregateExecution.Release();
            if (laneExecuting) lane.ReleaseExecution();
            lane.ReleaseAdmission();
        }
    }

    private TimeSpan RemainingQueueTime(long startedAt)
    {
        var elapsed = Stopwatch.GetElapsedTime(startedAt);
        return elapsed >= _queueTimeout ? TimeSpan.Zero : _queueTimeout - elapsed;
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
