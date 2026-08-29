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
        var hydration = ExtractBetween(
            source,
            "public async Task<SongInfo[]> GetSongInfoBatchAsync(",
            "public async Task<int[]> GetMetadataRelationshipCandidateIdsAsync(");

        Assert.Contains("WHERE song_id = s.id AND is_producer = TRUE\n                       ORDER BY artist_id", hydration);
        Assert.Contains("WHERE song_id = s.id AND is_vocalist = TRUE\n                       ORDER BY artist_id", hydration);
        Assert.Contains("ORDER BY st.tag_id", hydration);
        Assert.Contains("FROM song_album_links album_link", hydration);
        Assert.Contains("ORDER BY album_link.ordinal", hydration);
        Assert.Contains(",sf.audio_computed IS TRUE AS has_audio_features", hydration);
        Assert.DoesNotContain("FROM song_features audio_features", hydration);
        Assert.DoesNotContain("raw_json", hydration);
        Assert.DoesNotContain("jsonb_array_elements", hydration);
        Assert.Contains("WHERE s.id = ANY($1)", hydration);
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
    public void MetadataRelationshipQuery_PreaggregatesAndProbesEligibilityInRankOrder()
    {
        var source = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Services", "DbService.cs");
        var schema = ReadRepositoryFile("backend", "database", "schema.sql");
        var relationshipQuery = ExtractBetween(
            source,
            "public async Task<int[]> GetMetadataRelationshipCandidateIdsAsync(",
            "internal static string MetadataRelationshipCacheKey(");
        var scoredCandidates = ExtractBetween(
            relationshipQuery,
            "scored_candidates AS MATERIALIZED (",
            "            SELECT ranked_candidate.song_id");
        var eligibleRanking = relationshipQuery[
            relationshipQuery.IndexOf("            SELECT ranked_candidate.song_id", StringComparison.Ordinal)..];

        Assert.Contains("GROUP BY candidate_tag.song_id", scoredCandidates);
        Assert.Contains("AS relationship_score", scoredCandidates);
        Assert.Contains("AS matching_tag_count", scoredCandidates);
        Assert.DoesNotContain("song_discovery_quality", scoredCandidates);

        Assert.Contains("FROM scored_candidates candidate", eligibleRanking);
        Assert.Contains("JOIN LATERAL (", eligibleRanking);
        Assert.Contains("WHERE quality.song_id = ranked_candidate.song_id", eligibleRanking);
        Assert.Contains("AND quality.discovery_eligible = TRUE", eligibleRanking);
        Assert.Contains("LIMIT 1\n                OFFSET 0", eligibleRanking);
        Assert.Contains("ranked_candidate.relationship_score DESC", eligibleRanking);
        Assert.Contains("ranked_candidate.matching_tag_count DESC", eligibleRanking);
        Assert.Contains("ranked_candidate.song_id\n            LIMIT $2", eligibleRanking);
        Assert.Equal(
            2,
            eligibleRanking.Split("OFFSET 0", StringSplitOptions.None).Length - 1);
        Assert.Equal(
            1,
            relationshipQuery.Split(
                "FROM song_discovery_quality quality",
                StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("JOIN song_discovery_quality quality", relationshipQuery);
        Assert.Contains(
            "CREATE INDEX IF NOT EXISTS song_discovery_eligible_song_idx\n" +
            "    ON song_discovery_quality (song_id)\n" +
            "    WHERE discovery_eligible;",
            schema);

        var rankedSource = eligibleRanking.IndexOf(
            "FROM scored_candidates candidate",
            StringComparison.Ordinal);
        var rankedOrder = eligibleRanking.IndexOf(
            "candidate.relationship_score DESC",
            rankedSource,
            StringComparison.Ordinal);
        var rankedFence = eligibleRanking.IndexOf(
            "OFFSET 0",
            rankedOrder,
            StringComparison.Ordinal);
        var lateralProbe = eligibleRanking.IndexOf(
            "JOIN LATERAL (",
            rankedFence,
            StringComparison.Ordinal);
        var eligibilityLookup = eligibleRanking.IndexOf(
            "FROM song_discovery_quality quality",
            lateralProbe,
            StringComparison.Ordinal);
        var probeLimit = eligibleRanking.IndexOf(
            "LIMIT 1",
            eligibilityLookup,
            StringComparison.Ordinal);
        var probeFence = eligibleRanking.IndexOf(
            "OFFSET 0",
            probeLimit,
            StringComparison.Ordinal);
        var resultLimit = eligibleRanking.IndexOf(
            "LIMIT $2",
            probeFence,
            StringComparison.Ordinal);

        Assert.True(rankedSource >= 0);
        Assert.True(rankedOrder > rankedSource);
        Assert.True(rankedFence > rankedOrder);
        Assert.True(lateralProbe > rankedFence);
        Assert.True(eligibilityLookup > lateralProbe);
        Assert.True(probeLimit > eligibilityLookup);
        Assert.True(probeFence > probeLimit);
        Assert.True(resultLimit > probeFence);
    }

    [Fact]
    public void MetadataRelationshipPreaggregation_PreservesEdgeCaseRanking()
    {
        const int seedSongId = 1;
        const int limit = 4;
        var matches = new[]
        {
            new RelationshipMatch(seedSongId, 20, 500),
            new RelationshipMatch(2, 20, 500),
            new RelationshipMatch(2, 5, 25),
            new RelationshipMatch(3, 20, 500),
            new RelationshipMatch(3, 5, 25),
            new RelationshipMatch(4, 20, 2),       // High score, but ineligible.
            new RelationshipMatch(5, 1, 2),
            new RelationshipMatch(6, 20, 2),       // Missing quality row.
            new RelationshipMatch(7, 100, 500),    // Exercises the tag-count cap.
            new RelationshipMatch(8, 1, 2),        // Ties song 5; song ID breaks it.
        };
        var eligibility = new Dictionary<int, bool>
        {
            [seedSongId] = true,
            [2] = true,
            [3] = true,
            [4] = false,
            [5] = true,
            [7] = true,
            [8] = true,
        };

        var filterBeforeAggregate = RankRelationshipMatches(
            matches.Where(match =>
                eligibility.TryGetValue(match.SongId, out var eligible) && eligible),
            seedSongId,
            limit);
        var aggregateBeforeFilter = matches
            .Where(match => match.SongId != seedSongId)
            .GroupBy(match => match.SongId)
            .Select(group => new RelationshipRank(
                group.Key,
                group.Sum(RelationshipScore),
                group.LongCount()))
            .Where(candidate =>
                eligibility.TryGetValue(candidate.SongId, out var eligible) && eligible)
            .OrderByDescending(candidate => candidate.Score)
            .ThenByDescending(candidate => candidate.MatchingTagCount)
            .ThenBy(candidate => candidate.SongId)
            .Take(limit)
            .Select(candidate => candidate.SongId)
            .ToArray();

        Assert.Equal(filterBeforeAggregate, aggregateBeforeFilter);
        Assert.Equal([2, 3, 5, 8], aggregateBeforeFilter);
    }

    [Fact]
    public void MetadataRelationshipEligibilityProbe_SkipsHighRankedIneligibleAndMissingRows()
    {
        const int seedSongId = 1;
        const int limit = 3;
        var matches = new[]
        {
            new RelationshipMatch(seedSongId, 20, 2),
            new RelationshipMatch(2, 20, 2),  // Highest candidate, explicitly ineligible.
            new RelationshipMatch(3, 19, 2),  // Next candidate, missing quality row.
            new RelationshipMatch(4, 10, 10),
            new RelationshipMatch(5, 10, 10), // Exact score/count tie; song ID breaks it.
            new RelationshipMatch(6, 10, 10),
            new RelationshipMatch(7, 1, 500), // Eligible but beyond the requested limit.
        };
        var eligibility = new Dictionary<int, bool>
        {
            [seedSongId] = true,
            [2] = false,
            [4] = true,
            [5] = true,
            [6] = true,
            [7] = true,
        };

        var filterThenRank = RankEligibleRelationships(
            matches,
            eligibility,
            seedSongId,
            limit,
            filterBeforeOrdering: true);
        var rankThenProbe = RankEligibleRelationships(
            matches,
            eligibility,
            seedSongId,
            limit,
            filterBeforeOrdering: false);

        Assert.Equal(filterThenRank, rankThenProbe);
        Assert.Equal([4, 5, 6], rankThenProbe);
    }

    [Fact]
    public void MetadataRelationshipEligibilityProbe_ReturnsAllEligibleRowsBelowLargeLimit()
    {
        const int seedSongId = 1;
        const int limit = 600;
        var matches = new[]
        {
            new RelationshipMatch(seedSongId, 20, 2),
            new RelationshipMatch(2, 20, 2),
            new RelationshipMatch(3, 15, 3),
            new RelationshipMatch(4, 10, 4),
            new RelationshipMatch(5, 5, 5),
            new RelationshipMatch(6, 1, 6),
        };
        var eligibility = new Dictionary<int, bool>
        {
            [seedSongId] = true,
            [2] = false,
            [3] = true,
            [4] = true,
            [5] = false,
            // Song 6 deliberately has no quality row.
        };

        var filterThenRank = RankEligibleRelationships(
            matches,
            eligibility,
            seedSongId,
            limit,
            filterBeforeOrdering: true);
        var rankThenProbe = RankEligibleRelationships(
            matches,
            eligibility,
            seedSongId,
            limit,
            filterBeforeOrdering: false);

        Assert.Equal(filterThenRank, rankThenProbe);
        Assert.Equal([3, 4], rankThenProbe);
        Assert.True(rankThenProbe.Length < limit);
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

    [Fact]
    public void AlbumNormalizationMigration_IsBoundedRetryableAndFailClosed()
    {
        var schema = ReadRepositoryFile("backend", "database", "schema.sql");
        var migration = ReadRepositoryFile(
            "backend", "database", "migrations", "0023_normalize_song_album_links.sql");
        var migrator = ReadRepositoryFile("backend", "database", "migrate.sh");
        var manifest = ReadRepositoryFile(
            "backend", "database", "migrations", "migration-manifest.tsv");

        Assert.Contains("CREATE TABLE IF NOT EXISTS song_album_links", schema);
        Assert.Contains("PRIMARY KEY (song_id, ordinal)", schema);
        Assert.Contains("ordinal   INTEGER NOT NULL CHECK (ordinal > 0)", schema);
        Assert.Contains("CREATE OR REPLACE FUNCTION sync_song_album_links_from_raw_json_v1()", schema);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_insert_guard_v1", schema);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_key_preserve_v1", schema);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_links_sync_v1", schema);
        Assert.Contains("TG_WHEN = 'BEFORE'", schema);
        Assert.Contains("jsonb_typeof(NEW.raw_json) = 'object'", schema);
        Assert.Contains("OLD.raw_json ? 'albums'", schema);
        Assert.Contains("non-owner song INSERT must include an explicit albums key", schema);
        Assert.Contains("NOT (NEW.raw_json ? 'albums')", schema);

        Assert.Contains("pg_try_advisory_lock(hashtext('diva-data-pipeline-publication-v1'))", migration);
        Assert.Contains("pg_try_advisory_lock(hashtext('diva-data-pipeline-child-v1'))", migration);
        Assert.Contains("CREATE OR REPLACE PROCEDURE public.backfill_song_album_links_batch_v1", migration);
        Assert.Contains("DO $backfill_procedure_preflight$", migration);
        Assert.Contains("complete dual-write", migration);
        Assert.Contains("/ 5000", migration);
        Assert.Contains("DELETE FROM public.song_album_links links", migration);
        Assert.Contains("INSERT INTO public.song_album_links (song_id, ordinal, album_id)", migration);
        Assert.Contains("WITH ORDINALITY AS album(value, ordinal)", migration);
        Assert.Contains("album.value ->> 'id' ~ '^[0-9]+$'", migration);
        Assert.Contains("SET statement_timeout = ''120s''", migration);
        Assert.Contains("\\gexec", migration);
        Assert.Contains("EXCEPT", migration);
        Assert.Contains("missing_count <> 0 OR unexpected_count <> 0", migration);
        Assert.Contains("REVOKE ALL ON PROCEDURE", migration);
        Assert.Contains("FROM PUBLIC, diva_api_runtime, diva_pipeline_runtime", migration);
        Assert.Contains("GRANT SELECT ON TABLE public.song_album_links TO diva_api_runtime", migration);
        Assert.Contains("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.song_album_links", migration);
        Assert.Contains("relation.relowner = (", migration);
        Assert.Contains("NOT trigger_state.tgisinternal", migration);
        Assert.Contains("FROM pg_rewrite rule_state", migration);
        Assert.Contains("CROSS JOIN LATERAL aclexplode", migration);
        Assert.Contains("DO $post_create_acl_validation$", migration);
        Assert.Contains("CREATE OR REPLACE FUNCTION public.sync_song_album_links_from_raw_json_v1()", migration);
        Assert.Contains("SECURITY INVOKER", migration);
        Assert.Contains("jsonb_typeof(NEW.raw_json) = 'object'", migration);
        Assert.Contains("OLD.raw_json ? 'albums'", migration);
        Assert.Contains("NOT (NEW.raw_json ? 'albums')", migration);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_insert_guard_v1", migration);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_key_preserve_v1", migration);
        Assert.Contains("CREATE OR REPLACE TRIGGER song_album_links_sync_v1", migration);
        Assert.Contains("REVOKE ALL ON FUNCTION public.sync_song_album_links_from_raw_json_v1()", migration);
        Assert.Contains("migrations_sql_dir=\"${MIGRATIONS_SQL_DIR:-/migrations/sql}\"", migrator);
        Assert.Contains("pg_try_advisory_lock", migrator);
        Assert.Contains("content_sha256", migrator);
        Assert.Contains("schema_migration_attempts", migrator);
        Assert.Contains("has incomplete attempt", migrator);
        Assert.Contains("cat \"$migration_file\" >>\"$driver\"", migrator);
        Assert.Contains("INSERT INTO public.schema_migrations", migrator);
        Assert.Matches(
            "(?m)^0023_normalize_song_album_links\\.sql\\|non-transactional\\|[0-9a-f]{64}$",
            manifest.ReplaceLineEndings("\n"));
    }

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        var start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        var end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }

    private static int[] RankRelationshipMatches(
        IEnumerable<RelationshipMatch> matches,
        int seedSongId,
        int limit) =>
        matches
            .Where(match => match.SongId != seedSongId)
            .GroupBy(match => match.SongId)
            .Select(group => new RelationshipRank(
                group.Key,
                group.Sum(RelationshipScore),
                group.LongCount()))
            .OrderByDescending(candidate => candidate.Score)
            .ThenByDescending(candidate => candidate.MatchingTagCount)
            .ThenBy(candidate => candidate.SongId)
            .Take(limit)
            .Select(candidate => candidate.SongId)
            .ToArray();

    private static int[] RankEligibleRelationships(
        IEnumerable<RelationshipMatch> matches,
        IReadOnlyDictionary<int, bool> eligibility,
        int seedSongId,
        int limit,
        bool filterBeforeOrdering)
    {
        var candidates = matches
            .Where(match => match.SongId != seedSongId)
            .GroupBy(match => match.SongId)
            .Select(group => new RelationshipRank(
                group.Key,
                group.Sum(RelationshipScore),
                group.LongCount()));
        Func<RelationshipRank, bool> isEligible = candidate =>
            eligibility.TryGetValue(candidate.SongId, out var eligible) && eligible;

        return filterBeforeOrdering
            ? candidates
                .Where(isEligible)
                .OrderByDescending(candidate => candidate.Score)
                .ThenByDescending(candidate => candidate.MatchingTagCount)
                .ThenBy(candidate => candidate.SongId)
                .Take(limit)
                .Select(candidate => candidate.SongId)
                .ToArray()
            : candidates
                .OrderByDescending(candidate => candidate.Score)
                .ThenByDescending(candidate => candidate.MatchingTagCount)
                .ThenBy(candidate => candidate.SongId)
                .Where(isEligible)
                .Take(limit)
                .Select(candidate => candidate.SongId)
                .ToArray();
    }

    private static double RelationshipScore(RelationshipMatch match) =>
        (1.0 + Math.Log(1.0 + Math.Min(match.TagCount, 20)))
        / Math.Log(2.0 + match.TagFrequency);

    private sealed record RelationshipMatch(int SongId, int TagCount, double TagFrequency);
    private sealed record RelationshipRank(int SongId, double Score, long MatchingTagCount);

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
