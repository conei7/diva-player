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
            NoQualityReservoir,
            NoSongInfos,
            _ =>
            {
                calls.Add("global");
                return Task.FromResult(new[] { 999 });
            },
            CancellationToken.None);

        Assert.Equal(restricted, result.CandidateIds);
        Assert.Equal(
            RecommendService.DiverseFallbackCandidateSource.RestrictedExisting,
            result.Source);
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
            NoQualityReservoir,
            NoSongInfos,
            _ =>
            {
                calls.Add("global");
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.Equal(RecommendService.DiverseFallbackCandidateSource.ExactGlobal, result.Source);
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
            NoQualityReservoir,
            NoSongInfos,
            _ =>
            {
                globalCalls++;
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.Equal(RecommendService.DiverseFallbackCandidateSource.ExactGlobal, result.Source);
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
            NoQualityReservoir,
            NoSongInfos,
            _ => Task.FromResult(global),
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.Equal(RecommendService.DiverseFallbackCandidateSource.ExactGlobal, result.Source);
    }

    [Fact]
    public async Task ShortRestrictedResult_UsesQualityReservoirBeforeExactGlobal()
    {
        const int requiredCount = 100;
        var restricted = Enumerable.Range(1, requiredCount - 1).ToArray();
        var reservoir = Enumerable.Range(101, 200).ToArray();
        var reservoirInfos = DiverseInfos(reservoir);
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
                calls.Add("reservoir");
                return Task.FromResult(reservoir);
            },
            (ids, _) =>
            {
                calls.Add("hydrate");
                Assert.Equal(reservoir, ids);
                return Task.FromResult(reservoirInfos);
            },
            _ =>
            {
                calls.Add("global");
                return Task.FromResult(new[] { 999 });
            },
            CancellationToken.None);

        Assert.Equal(requiredCount, result.CandidateIds.Length);
        Assert.Equal(
            RecommendService.DiverseFallbackCandidateSource.QualityReservoir,
            result.Source);
        Assert.Equal(["restricted", "reservoir", "hydrate"], calls);
    }

    [Fact]
    public async Task UnusableQualityReservoir_UsesExactGlobalOnce()
    {
        const int requiredCount = 100;
        var restricted = Enumerable.Range(1, requiredCount - 1).ToArray();
        var reservoir = Enumerable.Range(101, requiredCount - 1)
            .Append(101)
            .ToArray();
        var reservoirInfos = DiverseInfos(reservoir.Distinct().Take(requiredCount - 2));
        var global = new[] { 701, 702 };
        var globalCalls = 0;

        var result = await RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
            requiredCount,
            DiverseInfos(restricted),
            _ => Task.FromResult(restricted),
            _ => Task.FromResult(reservoir),
            (_, _) => Task.FromResult(reservoirInfos),
            _ =>
            {
                globalCalls++;
                return Task.FromResult(global);
            },
            CancellationToken.None);

        Assert.Equal(global, result.CandidateIds);
        Assert.Equal(RecommendService.DiverseFallbackCandidateSource.ExactGlobal, result.Source);
        Assert.Equal(1, globalCalls);
    }

    [Fact]
    public void QualityReservoirSelection_IsDistinctEligibleAndCapsEachRelationshipAtTwentyPercent()
    {
        const int requiredCount = 100;
        var ordered = Enumerable.Range(1, 250)
            .Prepend(1)
            .Append(-1)
            .ToArray();
        var infos = Enumerable.Range(1, 250)
            .Where(id => id != 249)
            .Select(id => Song(
                    id,
                    producerId: 1_000 + id,
                    vocalistId: id <= 60 ? 1 : 2_000 + id)
                with
                {
                    VocalistIds = id == 1 ? [1, 1] : [id <= 60 ? 1 : 2_000 + id],
                    DiscoveryEligible = id != 248,
                })
            .ToArray();

        var selected = RecommendService.SelectQualityDiverseFallbackCandidateIds(
            ordered,
            infos,
            requiredCount);
        var selectedInfos = infos.Where(info => selected.Contains(info.Id)).ToArray();
        var maxProducerCount = selectedInfos
            .SelectMany(info => info.ProducerIds.Distinct())
            .GroupBy(id => id)
            .Max(group => group.Count());
        var maxVocalistCount = selectedInfos
            .SelectMany(info => info.VocalistIds.Distinct())
            .GroupBy(id => id)
            .Max(group => group.Count());

        Assert.Equal(requiredCount, selected.Length);
        Assert.Equal(requiredCount, selected.Distinct().Count());
        Assert.DoesNotContain(248, selected);
        Assert.DoesNotContain(249, selected);
        Assert.True(maxProducerCount <= 20);
        Assert.True(maxVocalistCount <= 20);
        Assert.False(MetadataRelationshipRanking.NeedsDiverseFallback(selectedInfos));
    }

    [Fact]
    public void MetadataFallbackStabilizer_UsesCanonicalFirstHundredAcrossOffsets()
    {
        var infos = Enumerable.Range(1, 140)
            .Select(id => Song(
                id,
                producerId: 1_000 + id,
                vocalistId: id <= 14 ? 1 : 2_000 + id))
            .ToArray();
        var candidates = infos
            .Select((info, index) => (SongId: info.Id, Score: 1.0 - index * 0.001))
            .ToList();

        var pageZeroInput = candidates.Take(100).ToList();
        var deepOffsetInput = candidates.Take(120).ToList();
        var pageZero = RecommendService.StabilizeMetadataFallbackDiversity(
            pageZeroInput,
            infos);
        var deepOffset = RecommendService.StabilizeMetadataFallbackDiversity(
            deepOffsetInput,
            infos);
        var firstTwentyIds = pageZero.Take(20).Select(candidate => candidate.SongId).ToArray();
        var firstTwentyInfos = infos.Where(info => firstTwentyIds.Contains(info.Id)).ToArray();

        Assert.Equal(firstTwentyIds, deepOffset.Take(20).Select(candidate => candidate.SongId));
        Assert.Equal(pageZero.Select(candidate => candidate.SongId), deepOffset.Take(100).Select(candidate => candidate.SongId));
        Assert.Equal(pageZeroInput.Count, pageZero.Count);
        Assert.Equal(
            pageZeroInput.Select(candidate => candidate.SongId).Order(),
            pageZero.Select(candidate => candidate.SongId).Order());
        Assert.False(MetadataRelationshipRanking.NeedsDiverseFallback(firstTwentyInfos));
        Assert.Equal(100, RecommendService.MetadataDiversityCanonicalRerankCount(140, 5));
        Assert.Equal(100, RecommendService.MetadataDiversityCanonicalRerankCount(140, 40));
        Assert.Equal(120, RecommendService.MetadataDiversityCanonicalRerankCount(140, 120));

        var seed = Song(999, producerId: 9_999, vocalistId: 8_999);
        var rerankedForPageZero = MetadataRelationshipRanking.RerankRelated(
            candidates,
            seed,
            infos,
            RecommendService.MetadataDiversityCanonicalRerankCount(140, 5));
        var rerankedForDeepOffset = MetadataRelationshipRanking.RerankRelated(
            candidates,
            seed,
            infos,
            RecommendService.MetadataDiversityCanonicalRerankCount(140, 120));
        var stabilizedPageZero = RecommendService.StabilizeMetadataFallbackDiversity(
            rerankedForPageZero,
            infos);
        var stabilizedDeepOffset = RecommendService.StabilizeMetadataFallbackDiversity(
            rerankedForDeepOffset,
            infos);
        Assert.Equal(
            stabilizedPageZero.Select(candidate => candidate.SongId),
            stabilizedDeepOffset.Take(100).Select(candidate => candidate.SongId));
    }

    [Fact]
    public async Task ExactGlobalSelection_NeverLoadsExactGlobalTwice()
    {
        var selection = new RecommendService.DiverseFallbackCandidateSelection(
            [1, 2],
            RecommendService.DiverseFallbackCandidateSource.ExactGlobal);
        var globalCalls = 0;

        var result = await RecommendService.GetMetadataGlobalFallbackIfNeededAsync(
            selection,
            Enumerable.Range(1, 20).Select(id => (SongId: id, Score: 1.0)).ToArray(),
            Enumerable.Range(1, 20)
                .Select(id => Song(id, producerId: 1_000 + id, vocalistId: 1))
                .ToArray(),
            _ =>
            {
                globalCalls++;
                return Task.FromResult(new[] { 999 });
            },
            CancellationToken.None);

        Assert.Null(result);
        Assert.Equal(0, globalCalls);
    }

    [Fact]
    public async Task CancellationAfterReservoirLoad_PreventsHydrationAndGlobalQuery()
    {
        using var cancellation = new CancellationTokenSource();
        var hydrateCalls = 0;
        var globalCalls = 0;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            RecommendService.GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
                100,
                [],
                _ => Task.FromResult(Array.Empty<int>()),
                _ =>
                {
                    cancellation.Cancel();
                    return Task.FromResult(Enumerable.Range(1, 200).ToArray());
                },
                (_, _) =>
                {
                    hydrateCalls++;
                    return Task.FromResult(Array.Empty<SongInfo>());
                },
                _ =>
                {
                    globalCalls++;
                    return Task.FromResult(Array.Empty<int>());
                },
                cancellation.Token));

        Assert.Equal(0, hydrateCalls);
        Assert.Equal(0, globalCalls);
    }

    [Fact]
    public void QualityReservoirSourceCacheKey_IsGenerationAndSeedScoped()
    {
        var first = DbService.QualityDiverseFallbackSourceCacheKey("generation-a", 3022);

        Assert.Equal(first, DbService.QualityDiverseFallbackSourceCacheKey("generation-a", 3022));
        Assert.NotEqual(first, DbService.QualityDiverseFallbackSourceCacheKey("generation-b", 3022));
        Assert.NotEqual(first, DbService.QualityDiverseFallbackSourceCacheKey("generation-a", 368));
        Assert.Contains("quality-diverse-fallback-source:v1:3022:source-2000", first);
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
            NoQualityReservoir,
            NoSongInfos,
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

        Assert.Equal(
            RecommendService.DiverseFallbackCandidateSource.RestrictedExisting,
            selection.Source);
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
            NoQualityReservoir,
            NoSongInfos,
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

        Assert.Equal(
            RecommendService.DiverseFallbackCandidateSource.RestrictedExisting,
            selection.Source);
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
            NoQualityReservoir,
            NoSongInfos,
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
                (_, _) =>
                {
                    calls++;
                    return Task.FromResult(Array.Empty<SongInfo>());
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
            "public async Task<int[]> GetQualityDiverseFallbackCandidateIdsAsync(");
        var qualityMethod = ExtractBetween(
            source,
            "public async Task<int[]> GetQualityDiverseFallbackCandidateIdsAsync(",
            "internal static string QualityDiverseFallbackSourceCacheKey(");
        var qualitySourceQuery = ExtractBetween(
            source,
            "private async Task<int[]> QueryQualityDiverseFallbackSourceCandidateIdsAsync(",
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
        Assert.Contains("GetRecommendationPublicationGenerationAsync", qualityMethod);
        Assert.Contains("_objectCache", qualityMethod);
        Assert.Contains("QueryDiverseFallbackCandidateIdsAsync(", qualityMethod);
        Assert.Contains("QueryQualityDiverseFallbackSourceCandidateIdsAsync(", qualityMethod);
        var qualitySourceLoad = qualityMethod.IndexOf(
            "QueryQualityDiverseFallbackSourceCandidateIdsAsync(",
            StringComparison.Ordinal);
        var qualityCachePublish = qualityMethod.IndexOf(
            "_objectCache.Set(",
            qualitySourceLoad,
            StringComparison.Ordinal);
        var exactHardRecheck = qualityMethod.LastIndexOf(
            "return await QueryDiverseFallbackCandidateIdsAsync(",
            StringComparison.Ordinal);
        Assert.True(qualitySourceLoad >= 0);
        Assert.True(qualityCachePublish > qualitySourceLoad);
        Assert.True(exactHardRecheck > qualityCachePublish);
        Assert.Contains(
            "cancellationToken.ThrowIfCancellationRequested();",
            qualityMethod[qualitySourceLoad..qualityCachePublish]);
        Assert.DoesNotContain("_objectCache.Set(", qualityMethod[exactHardRecheck..]);
        Assert.Contains("quality.discovery_eligible = TRUE", qualitySourceQuery);
        Assert.Contains("candidate.publish_date BETWEEN seed.publish_date - 730", qualitySourceQuery);
        Assert.Contains("quality.quality_score DESC", qualitySourceQuery);
        Assert.Contains("LIMIT {QualityDiverseFallbackSourceCount}", qualitySourceQuery);
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
        Assert.Contains("DiverseFallbackCandidateSource.RestrictedExisting", metadataPath);
        Assert.Contains("MetadataDiversityCanonicalRerankCount", metadataPath);
        Assert.Contains("StabilizeMetadataFallbackDiversity", metadataPath);
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
        var quality = source.IndexOf(
            "GetQualityDiverseFallbackCandidateIdsAsync(",
            restricted,
            StringComparison.Ordinal);
        var global = source.IndexOf(
            "GetDiverseFallbackCandidateIdsAsync(",
            quality,
            StringComparison.Ordinal);

        Assert.True(resolver >= 0);
        Assert.True(restricted > resolver);
        Assert.True(quality > restricted);
        Assert.True(global > quality);
        Assert.Contains("candidateScores.Keys.ToArray()", source);
    }

    private static Task<int[]> NoQualityReservoir(CancellationToken _) =>
        Task.FromResult(Array.Empty<int>());

    private static Task<SongInfo[]> NoSongInfos(
        IReadOnlyCollection<int> _,
        CancellationToken __) =>
        Task.FromResult(Array.Empty<SongInfo>());

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
