using System.Globalization;
using VocadbRecommender.Services;

internal static class ExhibitionEndpoints
{
    private static readonly TimeSpan JapanOffset = TimeSpan.FromHours(9);
    private static readonly DateOnly FirstDay = new(2026, 11, 21);
    private static readonly DateOnly LastDay = new(2026, 11, 22);

    public static IEndpointRouteBuilder MapExhibitionEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/exhibition/visits", RegisterVisitAsync);
        endpoints.MapGet("/api/exhibition/visits", GetVisitCountsAsync);
        return endpoints;
    }

    internal static DateOnly? ActiveDay(DateTimeOffset utcNow)
    {
        var day = DateOnly.FromDateTime(utcNow.ToOffset(JapanOffset).DateTime);
        return day == FirstDay || day == LastDay ? day : null;
    }

    private static async Task<IResult> RegisterVisitAsync(
        ExhibitionVisitRequest visit,
        HttpContext context,
        DbService db,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var day = ActiveDay(TimeProvider.System.GetUtcNow());
        if (day is null) return Results.NotFound();
        if (!DateOnly.TryParseExact(visit.Day, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var requestedDay) || requestedDay != day
            || !Guid.TryParseExact(visit.VisitId, "N", out var visitId) || visitId == Guid.Empty)
        {
            return Results.BadRequest();
        }

        var ordinal = await db.RegisterExhibitionVisitAsync(day.Value, visitId, cancellationToken);
        return ordinal.HasValue
            ? Results.Ok(new { ordinal = ordinal.Value })
            : Results.StatusCode(StatusCodes.Status429TooManyRequests);
    }

    private static async Task<IResult> GetVisitCountsAsync(
        HttpContext context,
        DbService db,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        var counts = await db.GetExhibitionVisitCountsAsync(cancellationToken);
        return Results.Ok(new[]
        {
            new { day = FirstDay, count = counts.GetValueOrDefault(FirstDay) },
            new { day = LastDay, count = counts.GetValueOrDefault(LastDay) },
        });
    }

    private sealed record ExhibitionVisitRequest(string Day, string VisitId);
}
