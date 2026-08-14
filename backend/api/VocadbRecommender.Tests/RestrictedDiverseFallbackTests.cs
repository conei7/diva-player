using System.Runtime.CompilerServices;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RestrictedDiverseFallbackTests
{
    [Fact]
    public async Task FullDiverseRestrictedResult_SkipsGlobalQuery()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount).ToArray();
        var calls = new List<string>();

        var result = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            DiverseInfos(restricted),
            _ =>
            {
                calls.Add("restricted");
                return Task.FromResult(restricted);
            },
            _ =>
            {
                calls.Add("global");
                return Task.FromResult(new[] { 999 });
            },
            CancellationToken.None);

        Assert.Equal(restricted, result.CandidateIds);
        Assert.True(result.UsedRestrictedPool);
        Assert.Equal(["restricted"], calls);
    }

    [Fact]
    public async Task ShortRestrictedResult_IsDiscardedAndUsesGlobalQuery()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount - 1).ToArray();
        var global = new[] { 501, 502, 503 };
        var calls = new List<string>();

        var result = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            DiverseInfos(Enumerable.Range(1, requiredCount)),
            _ =>
            {
                calls.Add("restricted");
                return Task.FromResult(restricted);
            },
            _ =>
            {
                calls.Add("global");
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.False(result.UsedRestrictedPool);
        Assert.Equal(["restricted", "global"], calls);
    }

    [Fact]
    public async Task ConcentratedFullRestrictedResult_UsesGlobalQuery()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount).ToArray();
        var concentratedInfos = restricted
            .Select(id => Song(id, producerId: 1_000 + id, vocalistId: 1))
            .ToArray();
        var global = new[] { 701, 702 };
        var globalCalls = 0;

        var result = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            concentratedInfos,
            _ => Task.FromResult(restricted),
            _ =>
            {
                globalCalls++;
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.False(result.UsedRestrictedPool);
        Assert.Equal(1, globalCalls);
    }

    [Fact]
    public async Task MissingRestrictedSongInfo_UsesGlobalQuery()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount).ToArray();
        var global = new[] { 801, 802 };

        var result = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            DiverseInfos(restricted.Take(requiredCount - 1)),
            _ => Task.FromResult(restricted),
            _ => Task.FromResult(global),
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.False(result.UsedRestrictedPool);
    }

    [Fact]
    public async Task DiverseRestrictedProbe_WithConcentratedRerankedHead_LoadsGlobalFallback()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount).ToArray();
        var candidateInfos = DiverseInfos(restricted)
            .Concat(Enumerable.Range(21, requiredCount)
                .Select(id => Song(id, producerId: 3_000 + id, vocalistId: 1)))
            .ToArray();
        var selection = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            candidateInfos,
            _ => Task.FromResult(restricted),
            _ => throw new InvalidOperationException("Initial global fallback must be skipped."),
            CancellationToken.None);
        var reranked = Enumerable.Range(21, requiredCount)
            .Select(id => (SongId: id, Score: 1.0))
            .ToList();
        var global = new[] { 901, 902 };
        var globalCalls = 0;

        var result = await RecommendService.GetMetadataGlobalFallbackIfNeededAsync(
            selection,
            reranked,
            candidateInfos,
            _ =>
            {
                globalCalls++;
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.True(selection.UsedRestrictedPool);
        Assert.Equal(global, result);
        Assert.Equal(1, globalCalls);
    }

    [Fact]
    public async Task DiverseRestrictedProbe_WithDiverseRerankedHead_SkipsGlobalFallback()
    {
        const int requiredCount = 20;
        var restricted = Enumerable.Range(1, requiredCount).ToArray();
        var candidateInfos = DiverseInfos(Enumerable.Range(1, requiredCount * 2));
        var selection = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            candidateInfos,
            _ => Task.FromResult(restricted),
            _ => throw new InvalidOperationException("Initial global fallback must be skipped."),
            CancellationToken.None);
        var reranked = Enumerable.Range(21, requiredCount)
            .Select(id => (SongId: id, Score: 1.0))
            .ToList();
        var globalCalls = 0;

        var result = await RecommendService.GetMetadataGlobalFallbackIfNeededAsync(
            selection,
            reranked,
            candidateInfos,
            _ =>
            {
                globalCalls++;
                return Task.FromResult(new[] { 999 });
            },
            CancellationToken.None);

        Assert.True(selection.UsedRestrictedPool);
        Assert.Null(result);
        Assert.Equal(0, globalCalls);
    }

    [Fact]
    public async Task MetadataGlobalDecision_UsesFixedFirstTwentyAcrossOffsets()
    {
        const int probeCount = RecommendService.MetadataDiversityProbeMinimumCount;
        var restricted = Enumerable.Range(1, probeCount).ToArray();
        var concentratedHead = Enumerable.Range(21, probeCount)
            .Select(id => Song(id, producerId: 3_000 + id, vocalistId: 1));
        var diverseTail = DiverseInfos(Enumerable.Range(41, probeCount));
        var candidateInfos = DiverseInfos(restricted)
            .Concat(concentratedHead)
            .Concat(diverseTail)
            .ToArray();
        var selection = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            probeCount,
            candidateInfos,
            _ => Task.FromResult(restricted),
            _ => throw new InvalidOperationException("Initial global fallback must be skipped."),
            CancellationToken.None);
        var offsetZeroRerank = Enumerable.Range(21, probeCount)
            .Select(id => (SongId: id, Score: 1.0))
            .ToList();
        var offsetTwentyRerank = Enumerable.Range(21, probeCount * 2)
            .Select(id => (SongId: id, Score: 1.0))
            .ToList();
        var global = new[] { 951, 952 };
        var globalCalls = 0;
        Task<int[]> LoadGlobal(CancellationToken _)
        {
            globalCalls++;
            return Task.FromResult(global);
        }

        var offsetZeroResult = await RecommendService.GetMetadataGlobalFallbackIfNeededAsync(
            selection,
            offsetZeroRerank,
            candidateInfos,
            LoadGlobal,
            CancellationToken.None);
        var offsetTwentyResult = await RecommendService.GetMetadataGlobalFallbackIfNeededAsync(
            selection,
            offsetTwentyRerank,
            candidateInfos,
            LoadGlobal,
            CancellationToken.None);

        Assert.Equal(global, offsetZeroResult);
        Assert.Equal(global, offsetTwentyResult);
        Assert.Equal(2, globalCalls);
        Assert.Equal(probeCount, RecommendService.MetadataDiversityProbeCount(60, 20));
        Assert.Equal(probeCount * 2, RecommendService.MetadataDiversityProbeCount(60, 40));
    }

    [Fact]
    public void MetadataTwentyItemDiversityProbe_PreservesRequestedPrefix()
    {
        const int requestedCount = 5;
        var seed = Song(999, producerId: 9_999, vocalistId: 8_999);
        var infos = DiverseInfos(Enumerable.Range(1, 40));
        var candidates = infos
            .Select((info, index) => (SongId: info.Id, Score: 1.0 - index * 0.01))
            .ToList();

        var requested = MetadataRelationshipRanking.RerankRelated(
            candidates,
            seed,
            infos,
            requestedCount);
        var probe = MetadataRelationshipRanking.RerankRelated(
            candidates,
            seed,
            infos,
            RecommendService.MetadataDiversityProbeCount(
                candidates.Count,
                requestedCount));

        Assert.Equal(RecommendService.MetadataDiversityProbeMinimumCount, probe.Count);
        Assert.Equal(requested.Select(item => item.SongId), probe.Take(requestedCount).Select(item => item.SongId));
        Assert.Equal(
            requested.Select(item => BitConverter.DoubleToInt64Bits(item.Score)),
            probe.Take(requestedCount).Select(item => BitConverter.DoubleToInt64Bits(item.Score)));
    }

    [Fact]
    public async Task PreCanceledResolver_DoesNotStartEitherQuery()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var calls = 0;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
                20,
                [],
                _ =>
                {
                    calls++;
                    return Task.FromResult(Array.Empty<int>());
                },
                _ =>
                {
                    calls++;
                    return Task.FromResult(Array.Empty<int>());
                },
                cancellation.Token));

        Assert.Equal(0, calls);
    }

    [Fact]
    public void RestrictedQuery_ReusesExactFallbackSqlWithoutSharingGlobalCache()
    {
        var source = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Services", "DbService.cs");
        var globalMethod = ExtractBetween(
            source,
            "public async Task<int[]> GetDiverseFallbackCandidateIdsAsync(",
            "public async Task<int[]> GetRestrictedDiverseFallbackCandidateIdsAsync(");
        var restrictedMethod = ExtractBetween(
            source,
            "public async Task<int[]> GetRestrictedDiverseFallbackCandidateIdsAsync(",
            "internal static int[] NormalizeRestrictedDiverseFallbackCandidateIds(");
        var queryCore = ExtractBetween(
            source,
            "private async Task<int[]> QueryDiverseFallbackCandidateIdsAsync(",
            "public async Task<List<object>> GetViewHistoryAsync(");

        Assert.Contains("QueryDiverseFallbackCandidateIdsAsync(", globalMethod);
        Assert.Contains("QueryDiverseFallbackCandidateIdsAsync(", restrictedMethod);
        Assert.Contains("GetRecommendationPublicationGenerationAsync", globalMethod);
        Assert.Contains("_objectCache", globalMethod);
        Assert.DoesNotContain("GetRecommendationPublicationGenerationAsync", restrictedMethod);
        Assert.DoesNotContain("_objectCache", restrictedMethod);
        Assert.DoesNotContain("_objectCache", queryCore);
        Assert.Contains("OpenAsync(cancellationToken)", queryCore);
        Assert.Contains("ExecuteReaderAsync(cancellationToken)", queryCore);
        Assert.Contains("ReadAsync(cancellationToken)", queryCore);

        Assert.Contains("AND candidate.id = ANY($3)", queryCore);
        Assert.Contains("NpgsqlDbType.Array | NpgsqlDbType.Integer", queryCore);
        Assert.Contains("quality.discovery_eligible = TRUE", queryCore);
        Assert.Contains("candidate.publish_date BETWEEN seed.publish_date - 730", queryCore);
        Assert.Contains("FROM pvs playable", queryCore);
        Assert.Contains("playable.disabled = FALSE", queryCore);
        Assert.Contains("vocalist.artist_type IN ({VoiceSynthArtistTypesSql})", queryCore);
        Assert.Contains("FROM song_artists candidate_producer", queryCore);
        Assert.Contains("JOIN seed_producers seed_producer", queryCore);
        Assert.Contains("FROM song_artists candidate_vocalist", queryCore);
        Assert.Contains("JOIN seed_vocalists seed_vocalist", queryCore);
        Assert.Contains("CASE WHEN candidate.song_type = seed.song_type THEN 0 ELSE 1 END", queryCore);
        Assert.Contains("features.state_cluster = seed.state_cluster", queryCore);
        Assert.Contains("ABS(candidate.publish_date - seed.publish_date)", queryCore);
        Assert.Contains("quality.quality_score DESC", queryCore);
        Assert.Contains("hashtext(candidate.id::text || ':' || seed.id::text)", queryCore);
        Assert.Contains("candidate.id\n            LIMIT $2", queryCore);
    }

    [Fact]
    public void HybridAndMetadataPaths_CallRestrictedBeforeGlobalFallback()
    {
        var recommendSource = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Services", "RecommendService.cs");
        var programSource = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Program.cs");
        var hybridPath = ExtractBetween(
            recommendSource,
            "public async Task<RecommendResponse> RecommendAsync(",
            "internal static async Task<DiverseFallbackCandidateSelection>");
        var metadataPath = ExtractBetween(
            programSource,
            "// GET /api/recommend/metadata",
            "// GET /api/recommend/audio");

        AssertRestrictedBeforeGlobal(hybridPath);
        AssertRestrictedBeforeGlobal(metadataPath);
        Assert.Contains("if (!fallbackSelection.Value.UsedRestrictedPool)", metadataPath);
        Assert.Contains("MetadataDiversityProbeCount", metadataPath);
        Assert.Contains("GetMetadataGlobalFallbackIfNeededAsync", metadataPath);
        Assert.Contains(".Take(MetadataDiversityProbeMinimumCount)", recommendSource);
    }

    private static void AssertRestrictedBeforeGlobal(string source)
    {
        var resolver = source.IndexOf(
            "GetDiverseFallbackCandidateIdsRestrictedFirstAsync(",
            StringComparison.Ordinal);
        var restricted = source.IndexOf(
            "GetRestrictedDiverseFallbackCandidateIdsAsync(",
            resolver,
            StringComparison.Ordinal);
        var global = source.IndexOf(
            "GetDiverseFallbackCandidateIdsAsync(",
            restricted,
            StringComparison.Ordinal);

        Assert.True(resolver >= 0);
        Assert.True(restricted > resolver);
        Assert.True(global > restricted);
        Assert.Contains("candidateScores.Keys.ToArray()", source);
    }

    private static SongInfo[] DiverseInfos(IEnumerable<int> ids) => ids
        .Select(id => Song(
            id,
            producerId: 1_000 + id,
            vocalistId: 2_000 + id % 10))
        .ToArray();

    private static SongInfo Song(int id, int producerId, int vocalistId) => new(
        Id: id,
        Name: $"Song {id}",
        ArtistString: $"Artist {producerId}",
        LengthSeconds: 180,
        SongType: "Original",
        FavoritedTimes: 10,
        StateCluster: 1,
        ProducerIds: [producerId],
        VocalistIds: [vocalistId],
        YoutubeViews: 10_000,
        NicoViews: 0,
        PublishDate: new DateTime(2024, 1, 1),
        RelatedTagIds: [1, 2],
        AlbumIds: [],
        HasCoreVoiceSynthVocalist: true,
        HasPlayablePv: true,
        DiscoveryEligible: true,
        QualityScore: 1,
        HasAudioFeatures: true,
        HasOriginalPv: true);

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        var start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        var end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
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
