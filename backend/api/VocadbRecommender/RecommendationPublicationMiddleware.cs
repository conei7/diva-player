using VocadbRecommender.Services;

internal sealed class RecommendationPublicationMiddleware(
    RequestDelegate next,
    ILogger<RecommendationPublicationMiddleware> logger)
{
    public async Task InvokeAsync(
        HttpContext context,
        RecommendationPublicationGuard guard)
    {
        if (!IsGuardedPath(context.Request.Path))
        {
            await next(context);
            return;
        }

        RecommendationPublicationLease? lease;
        try
        {
            lease = await guard.TryEnterAsync(context.RequestAborted);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogError(
                exception,
                "recommendation_publication_guard_failed traceId={TraceId}",
                context.TraceIdentifier);
            await WriteUnavailableAsync(
                context,
                "recommendation_publication_state_unavailable");
            return;
        }

        if (lease is null)
        {
            await WriteUnavailableAsync(
                context,
                "recommendation_publication_in_progress");
            return;
        }

        // Deliberately outside the guard-acquisition catch. Endpoint failures
        // retain their original status/exception and cannot be masked by a
        // second response write after headers have started.
        await using (lease)
            await next(context);
    }

    internal static bool IsGuardedPath(PathString path) =>
        path.StartsWithSegments("/api/recommend");

    private static async Task WriteUnavailableAsync(
        HttpContext context,
        string reason)
    {
        context.Response.Headers.RetryAfter = "5";
        await Results.Json(
            new { status = "temporarily_unavailable", reason },
            statusCode: StatusCodes.Status503ServiceUnavailable)
            .ExecuteAsync(context);
    }
}
