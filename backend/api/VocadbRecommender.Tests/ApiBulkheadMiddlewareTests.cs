using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using System.Threading.RateLimiting;

namespace VocadbRecommender.Tests;

public sealed class ApiBulkheadMiddlewareTests
{
    private const string AllowedOrigin = "https://diva-player.pages.dev";

    [Theory]
    [InlineData("/api/ready", "Bypass")]
    [InlineData("/api/health", "Bypass")]
    [InlineData("/api/recommend", "Heavy")]
    [InlineData("/api/recommend/audio", "Heavy")]
    [InlineData("/api/songs/search", "Heavy")]
    [InlineData("/api/discovery/knowledge-map", "Heavy")]
    [InlineData("/api/youtube/playlists/abc/songs", "Provider")]
    [InlineData("/api/nico/playlists/series/1/songs", "Provider")]
    [InlineData("/api/songs/batch", "Standard")]
    public void Classify_UsesBoundedLanes(string path, string expected)
    {
        Assert.Equal(expected, ApiBulkheadMiddleware.Classify(path).ToString());
    }

    [Fact]
    public void Options_UsePoolAwareDefaultsAndRejectUnsafeValues()
    {
        var defaults = ApiBulkheadOptions.FromConfiguration(CreateConfiguration(poolSize: 16));
        Assert.Equal(6, defaults.AggregatePermitLimit);
        Assert.Equal(4, defaults.DatabaseConnectionReserve);
        Assert.Equal(16, defaults.DatabaseMaximumPoolSize);
        Assert.Equal(6, defaults.HeavyPermitLimit);
        Assert.Equal(6, defaults.HeavyQueueLimit);
        Assert.Equal(1_500, defaults.QueueTimeoutMilliseconds);
        Assert.Equal(12, new ApiDatabaseConnectionBudget(defaults).ForegroundConnectionLimit);

        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 16,
                ("Recommender:Bulkhead:HeavyPermitLimit", "0"))));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 16,
                ("Recommender:Bulkhead:StandardPermitLimit", "7"))));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 16,
                ("Recommender:Bulkhead:AggregatePermitLimit", "13"))));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 8,
                ("Recommender:Bulkhead:DatabaseConnectionReserve", "8"))));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 16,
                ("Recommender:Bulkhead:DatabaseConnectionReserve", "3"))));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(new ConfigurationBuilder().Build()));
        Assert.Throws<InvalidOperationException>(() =>
            ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
                poolSize: 16,
                ("ConnectionStrings:Postgres",
                    "Host=localhost;Database=test;Username=test;Pooling=false"))));

        var standby = ApiBulkheadOptions.FromConfiguration(CreateConfiguration(
            poolSize: 8,
            ("Recommender:Bulkhead:AggregatePermitLimit", "3"),
            ("Recommender:Bulkhead:DatabaseConnectionReserve", "4"),
            ("Recommender:Bulkhead:HeavyPermitLimit", "3"),
            ("Recommender:Bulkhead:StandardPermitLimit", "3"),
            ("Recommender:Bulkhead:ProviderPermitLimit", "1")));
        Assert.Equal(4, new ApiDatabaseConnectionBudget(standby).ForegroundConnectionLimit);
    }

    [Fact]
    public async Task CapacityExhaustion_ReturnsBounded503WithoutStartingMoreWork()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async _ =>
            {
                Interlocked.Increment(ref calls);
                entered.TrySetResult();
                await release.Task;
            },
            permitLimit: 1,
            queueLimit: 0,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100);

        var first = CreateContext("/api/recommend");
        var firstTask = middleware.InvokeAsync(first);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var rejected = CreateContext("/api/recommend/metadata");
        await middleware.InvokeAsync(rejected);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, rejected.Response.StatusCode);
        Assert.Equal("1", rejected.Response.Headers.RetryAfter);
        Assert.Equal("concurrency;heavy", rejected.Response.Headers["X-Diva-Rate-Limit"]);
        Assert.Equal(1, Volatile.Read(ref calls));
        rejected.Response.Body.Position = 0;
        using (var document = await JsonDocument.ParseAsync(rejected.Response.Body))
        {
            Assert.Equal("server_busy", document.RootElement.GetProperty("error").GetString());
        }

        release.TrySetResult();
        await firstTask;
    }

    [Fact]
    public async Task AggregateCap_BoundsMixedLanesAndReleasesAfterTimeout()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async context =>
            {
                var call = Interlocked.Increment(ref calls);
                if (call == 1)
                {
                    Assert.Equal("/api/recommend", context.Request.Path);
                    entered.TrySetResult();
                    await release.Task;
                }
            },
            permitLimit: 1,
            queueLimit: 1,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100);

        var heavyTask = middleware.InvokeAsync(CreateContext("/api/recommend"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var standard = CreateContext("/api/songs/batch");
        await middleware.InvokeAsync(standard);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, standard.Response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.TrySetResult();
        await heavyTask;
        var next = CreateContext("/api/songs/batch");
        await middleware.InvokeAsync(next);
        Assert.Equal(StatusCodes.Status200OK, next.Response.StatusCode);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task QueueTimeout_ReleasesAdmissionForTheNextRequest()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async _ =>
            {
                var call = Interlocked.Increment(ref calls);
                if (call == 1)
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            },
            permitLimit: 1,
            queueLimit: 1,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100);

        var firstTask = middleware.InvokeAsync(CreateContext("/api/recommend"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var timedOut = CreateContext("/api/recommend");
        await middleware.InvokeAsync(timedOut);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, timedOut.Response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.TrySetResult();
        await firstTask;
        var next = CreateContext("/api/recommend");
        await middleware.InvokeAsync(next);
        Assert.Equal(StatusCodes.Status200OK, next.Response.StatusCode);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task AbortedQueueWait_ReleasesAdmissionForTheNextRequest()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async _ =>
            {
                var call = Interlocked.Increment(ref calls);
                if (call == 1)
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            },
            permitLimit: 1,
            queueLimit: 1,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 2_000);

        var firstTask = middleware.InvokeAsync(CreateContext("/api/recommend"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        using var abort = new CancellationTokenSource();
        var abortedContext = CreateContext("/api/recommend");
        abortedContext.RequestAborted = abort.Token;
        var abortedTask = middleware.InvokeAsync(abortedContext);
        abort.Cancel();
        await abortedTask.WaitAsync(TimeSpan.FromSeconds(2));

        var next = CreateContext("/api/recommend");
        var nextTask = middleware.InvokeAsync(next);
        release.TrySetResult();
        await Task.WhenAll(firstTask, nextTask).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(StatusCodes.Status200OK, next.Response.StatusCode);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task DownstreamException_ReleasesLaneAggregateAndAdmission()
    {
        var calls = 0;
        var middleware = CreateMiddleware(
            _ =>
            {
                if (Interlocked.Increment(ref calls) == 1)
                {
                    throw new InvalidOperationException("expected downstream failure");
                }
                return Task.CompletedTask;
            },
            permitLimit: 1,
            queueLimit: 0,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            middleware.InvokeAsync(CreateContext("/api/recommend")));

        var next = CreateContext("/api/recommend");
        await middleware.InvokeAsync(next);
        Assert.Equal(StatusCodes.Status200OK, next.Response.StatusCode);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task IntegratedPipeline_PreservesCorsAndBypassesPreflightReadyAndHealthDuringSaturation()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddCors(options => options.AddPolicy("AllowFrontend", policy => policy
            .WithOrigins(AllowedOrigin)
            .WithMethods("GET", "POST", "OPTIONS")
            .WithHeaders("Accept", "Content-Type", "Cache-Control")
            .WithExposedHeaders("Retry-After", "X-Diva-Rate-Limit", "X-Diva-Bulkhead")));
        services.AddSingleton(CreateOptions(
            permitLimit: 1,
            queueLimit: 0,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100));
        services.AddSingleton(serviceProvider => new ApiDatabaseConnectionBudget(
            serviceProvider.GetRequiredService<ApiBulkheadOptions>()));
        await using var serviceProvider = services.BuildServiceProvider();

        var application = new ApplicationBuilder(serviceProvider);
        application.UseCors("AllowFrontend");
        application.UseMiddleware<ApiBulkheadMiddleware>();
        application.Run(async context =>
        {
            Interlocked.Increment(ref calls);
            if (context.Request.Path == "/api/recommend")
            {
                entered.TrySetResult();
                await release.Task;
            }
            context.Response.StatusCode = StatusCodes.Status200OK;
        });
        var pipeline = application.Build();

        var saturated = CreateContext("/api/recommend", serviceProvider);
        saturated.Request.Headers.Origin = AllowedOrigin;
        var saturatedTask = pipeline(saturated);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var rejected = CreateContext("/api/recommend", serviceProvider);
        rejected.Request.Headers.Origin = AllowedOrigin;
        await pipeline(rejected);
        await FireResponseStartingAsync(rejected);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, rejected.Response.StatusCode);
        Assert.Equal(AllowedOrigin, rejected.Response.Headers.AccessControlAllowOrigin);
        Assert.Contains(
            "X-Diva-Bulkhead",
            rejected.Response.Headers.AccessControlExposeHeaders.ToString());

        var preflight = CreateContext("/api/recommend", serviceProvider, HttpMethods.Options);
        preflight.Request.Headers.Origin = AllowedOrigin;
        preflight.Request.Headers.AccessControlRequestMethod = HttpMethods.Get;
        await pipeline(preflight);
        await FireResponseStartingAsync(preflight);
        Assert.Equal(StatusCodes.Status204NoContent, preflight.Response.StatusCode);
        Assert.Equal(AllowedOrigin, preflight.Response.Headers.AccessControlAllowOrigin);

        foreach (var path in new[] { "/api/ready", "/api/health" })
        {
            var probe = CreateContext(path, serviceProvider);
            probe.Request.Headers.Origin = AllowedOrigin;
            await pipeline(probe).WaitAsync(TimeSpan.FromSeconds(2));
            await FireResponseStartingAsync(probe);
            Assert.Equal(StatusCodes.Status200OK, probe.Response.StatusCode);
            Assert.Equal(AllowedOrigin, probe.Response.Headers.AccessControlAllowOrigin);
            Assert.False(probe.Response.Headers.ContainsKey("X-Diva-Bulkhead"));
        }

        Assert.Equal(3, Volatile.Read(ref calls));
        release.TrySetResult();
        await saturatedTask.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task RateLimiterBeforeBulkhead_CountsSameClientBulkheadRejections()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(_ =>
                RateLimitPartition.GetFixedWindowLimiter(
                    "same-client",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 2,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        AutoReplenishment = true,
                    }));
        });
        services.AddSingleton(CreateOptions(
            permitLimit: 1,
            queueLimit: 0,
            aggregatePermitLimit: 1,
            timeoutMilliseconds: 100));
        services.AddSingleton(serviceProvider => new ApiDatabaseConnectionBudget(
            serviceProvider.GetRequiredService<ApiBulkheadOptions>()));
        await using var serviceProvider = services.BuildServiceProvider();

        var application = new ApplicationBuilder(serviceProvider);
        application.UseRateLimiter();
        application.UseMiddleware<ApiBulkheadMiddleware>();
        application.Run(async _ =>
        {
            Interlocked.Increment(ref calls);
            entered.TrySetResult();
            await release.Task;
        });
        var pipeline = application.Build();

        var activeTask = pipeline(CreateContext("/api/recommend", serviceProvider));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        try
        {
            var bulkheadRejected = CreateContext("/api/recommend", serviceProvider);
            await pipeline(bulkheadRejected);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, bulkheadRejected.Response.StatusCode);

            var rateLimited = CreateContext("/api/recommend", serviceProvider);
            await pipeline(rateLimited);
            Assert.Equal(StatusCodes.Status429TooManyRequests, rateLimited.Response.StatusCode);
            Assert.Equal(1, Volatile.Read(ref calls));
        }
        finally
        {
            release.TrySetResult();
            await activeTask.WaitAsync(TimeSpan.FromSeconds(2));
        }
    }

    private static ApiBulkheadMiddleware CreateMiddleware(
        RequestDelegate next,
        int permitLimit,
        int queueLimit,
        int aggregatePermitLimit,
        int timeoutMilliseconds)
    {
        var options = CreateOptions(
                permitLimit,
                queueLimit,
                aggregatePermitLimit,
                timeoutMilliseconds);
        return new ApiBulkheadMiddleware(
            next,
            options,
            new ApiDatabaseConnectionBudget(options),
            NullLogger<ApiBulkheadMiddleware>.Instance);
    }

    private static ApiBulkheadOptions CreateOptions(
        int permitLimit,
        int queueLimit,
        int aggregatePermitLimit,
        int timeoutMilliseconds) =>
        new(
            aggregatePermitLimit,
            DatabaseConnectionReserve: 4,
            DatabaseMaximumPoolSize: checked(aggregatePermitLimit + 4),
            permitLimit,
            queueLimit,
            permitLimit,
            queueLimit,
            permitLimit,
            queueLimit,
            timeoutMilliseconds);

    private static IConfiguration CreateConfiguration(
        int poolSize,
        params (string Key, string? Value)[] overrides)
    {
        var values = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Postgres"] =
                $"Host=localhost;Database=test;Username=test;Maximum Pool Size={poolSize}",
        };
        foreach (var (key, value) in overrides) values[key] = value;
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static DefaultHttpContext CreateContext(
        string path,
        IServiceProvider? serviceProvider = null,
        string method = "GET")
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpResponseFeature>(new CallbackResponseFeature());
        context.Response.Body = new MemoryStream();
        context.Request.Path = path;
        context.Request.Method = method;
        if (serviceProvider is not null) context.RequestServices = serviceProvider;
        return context;
    }

    private static Task FireResponseStartingAsync(DefaultHttpContext context) =>
        ((CallbackResponseFeature)context.Features.Get<IHttpResponseFeature>()!)
            .FireOnStartingAsync();

    private sealed class CallbackResponseFeature : IHttpResponseFeature
    {
        private readonly Stack<(Func<object, Task> Callback, object State)> _onStarting = new();
        private readonly Stack<(Func<object, Task> Callback, object State)> _onCompleted = new();

        public int StatusCode { get; set; } = StatusCodes.Status200OK;
        public string? ReasonPhrase { get; set; }
        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
        public Stream Body { get; set; } = new MemoryStream();
        public bool HasStarted { get; private set; }

        public void OnStarting(Func<object, Task> callback, object state) =>
            _onStarting.Push((callback, state));

        public void OnCompleted(Func<object, Task> callback, object state) =>
            _onCompleted.Push((callback, state));

        internal async Task FireOnStartingAsync()
        {
            if (HasStarted) return;
            while (_onStarting.TryPop(out var registration))
            {
                await registration.Callback(registration.State);
            }
            HasStarted = true;
        }
    }
}
