namespace VocadbRecommender.Tests;

public sealed class ViewHistoryObservationContractTests
{
    private static string RepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !(
            File.Exists(Path.Combine(current.FullName, "package.json")) &&
            File.Exists(Path.Combine(current.FullName, "backend", "database", "schema.sql"))))
            current = current.Parent;
        return current?.FullName ?? throw new InvalidOperationException("Repository root not found");
    }

    [Fact]
    public void MigrationAndSchemaDistinguishMissingSamplesFromObservedZeroes()
    {
        var root = RepositoryRoot();
        var migration = File.ReadAllText(Path.Combine(
            root,
            "backend", "database", "migrations", "0024_view_history_observation_flags.sql"));
        var schema = File.ReadAllText(Path.Combine(root, "backend", "database", "schema.sql"));

        Assert.Contains("youtube_observed BOOLEAN NOT NULL DEFAULT FALSE", migration);
        Assert.Contains("nico_observed BOOLEAN NOT NULL DEFAULT FALSE", migration);
        Assert.Contains("youtube_views > 0", migration);
        Assert.Contains("youtube_observed BOOLEAN NOT NULL DEFAULT FALSE", schema);
        Assert.Contains("nico_observed    BOOLEAN NOT NULL DEFAULT FALSE", schema);
    }

    [Fact]
    public void HistoryAndRankingUseFlagsRunningMaximaAndJapanDates()
    {
        var source = File.ReadAllText(Path.Combine(
            RepositoryRoot(),
            "backend", "api", "VocadbRecommender", "Services", "DbService.cs"));

        Assert.Contains("CASE WHEN h.youtube_observed THEN h.youtube_views END", source);
        Assert.Contains("CASE WHEN h.nico_observed THEN h.nico_views END", source);
        Assert.Contains("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW", source);
        Assert.Contains("AT TIME ZONE 'Asia/Tokyo'", source);
        Assert.DoesNotContain("NULLIF(h.youtube_views, 0)", source);
        Assert.DoesNotContain("NULLIF(h.nico_views, 0)", source);
    }
}
