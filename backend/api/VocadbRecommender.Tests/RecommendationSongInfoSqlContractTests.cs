using System.Runtime.CompilerServices;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationSongInfoSqlContractTests
{
    [Fact]
    public void SongInfoHydration_UsesDeterministicCoverableRelationshipLookups()
    {
        var source = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Services", "DbService.cs");

        Assert.Contains("WHERE song_id = s.id AND is_producer = TRUE\n                       ORDER BY artist_id", source);
        Assert.Contains("WHERE song_id = s.id AND is_vocalist = TRUE\n                       ORDER BY artist_id", source);
        Assert.Contains("ORDER BY st.tag_id", source);
        Assert.Contains(",sf.audio_computed IS TRUE AS has_audio_features", source);
        Assert.DoesNotContain("FROM song_features audio_features", source);
        Assert.Contains("WHERE s.id = ANY($1)", source);
    }

    [Fact]
    public void MetadataRelationshipCache_IsScopedToPublicationGeneration()
    {
        var first = DbService.MetadataRelationshipCacheKey("generation-a", 368, 300);
        var second = DbService.MetadataRelationshipCacheKey("generation-b", 368, 300);

        Assert.Equal("publication:generation-a:metadata-relationship:368:300", first);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void CoveringIndexMigration_IsConcurrentAndFailClosed()
    {
        var schema = ReadRepositoryFile("backend", "database", "schema.sql");
        var migration = ReadRepositoryFile(
            "backend", "database", "migrations", "0022_recommendation_song_info_covering_indexes.sql");

        foreach (var indexName in new[]
        {
            "song_artists_producer_song_idx",
            "song_artists_vocalist_song_idx",
            "pvs_playable_song_cover_idx",
        })
        {
            Assert.Contains($"CREATE INDEX IF NOT EXISTS {indexName}", schema);
            Assert.Contains($"CREATE INDEX CONCURRENTLY IF NOT EXISTS {indexName}", migration);
        }

        Assert.Contains("INCLUDE (pv_type)", schema);
        Assert.Contains("INCLUDE (pv_type)", migration);
        Assert.Contains("index_state.indisvalid", migration);
        Assert.Contains("index_state.indisready", migration);
        Assert.Contains("index_state.indexprs IS NULL", migration);
        Assert.Contains("access_method.amname = 'btree'", migration);
        Assert.Contains("IS NOT DISTINCT FROM expected.predicate", migration);
    }

    private static string ReadRepositoryFile(
        string firstRelativeSegment,
        params string[] remainingRelativeSegments)
    {
        var relativeSegments = new[] { firstRelativeSegment }
            .Concat(remainingRelativeSegments)
            .ToArray();
        return ReadRepositoryFile(relativeSegments);
    }

    private static string ReadRepositoryFile(
        string[] relativeSegments,
        [CallerFilePath] string testSourcePath = "")
    {
        var testsDirectory = Path.GetDirectoryName(testSourcePath)
            ?? throw new InvalidOperationException("Unable to locate test source directory.");
        var repositoryRoot = Path.GetFullPath(Path.Combine(testsDirectory, "..", "..", ".."));
        return File.ReadAllText(Path.Combine([repositoryRoot, .. relativeSegments]))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
