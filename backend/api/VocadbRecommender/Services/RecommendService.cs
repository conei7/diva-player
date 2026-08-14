using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>
/// 推薦メインサービス。
/// ANN → 知識グラフ探索 → マルコフフィルタ → MMR 再ランキング の順で処理。
/// </summary>
public class RecommendService
{
    internal const int DiverseFallbackCandidateCount = 80;
    internal const int VocalistDiversityAssessmentCandidateCount = 100;
    internal const int MetadataDiversityProbeMinimumCount = 20;
    internal const int MetadataDiversityCanonicalLookaheadCount = 100;

    internal enum DiverseFallbackCandidateSource
    {
        RestrictedExisting,
        QualityReservoir,
        ExactGlobal,
    }

    internal readonly record struct DiverseFallbackCandidateSelection(
        int[] CandidateIds,
        DiverseFallbackCandidateSource Source);

    private readonly DbService     _db;
    private readonly QdrantService _qdrant;
    private readonly MarkovService _markov;
    private readonly RecommenderOptions _opts;

    public RecommendService(
        DbService db,
        QdrantService qdrant,
        MarkovService markov,
        IOptions<RecommenderOptions> opts)
    {
        _db     = db;
        _qdrant = qdrant;
        _markov = markov;
        _opts   = opts.Value;
    }

    /// <summary>
    /// メイン推薦エントリポイント。
    /// </summary>
    public async Task<RecommendResponse> RecommendAsync(
        int    seedSongId,
        int    count,
        double sessionProgress,
        CancellationToken cancellationToken)
    {
        // --- シード曲情報取得 ---
        var seedSong = await _db.GetSongInfoAsync(seedSongId, cancellationToken);
        if (seedSong is null)
            return new RecommendResponse([], "seed song not found");

        // Exclude the seed song from candidates. User playback history stays client-local.
        var playedSet = new HashSet<int> { seedSongId };

        // --- 1. ANN 近似最近傍探索 ---
        var annTask = _qdrant.SearchSimilarAsync(
            seedSongId,
            _opts.AnnCandidates,
            cancellationToken,
            playedSet);

        // These sources are independent once the seed is loaded. Starting them
        // together removes cold-start latency without changing the score merge.
        var graphTask = KnowledgeGraphWalkAsync(
            seedSong,
            playedSet,
            _opts.GraphWalkSteps,
            cancellationToken);
        var relationshipTask = _db.GetMetadataRelationshipCandidateIdsAsync(
            seedSongId,
            300,
            cancellationToken);

        // Observe every started operation together. If one source fails, the
        // remaining request-scoped work is still joined instead of becoming an
        // unobserved database or Qdrant operation.
        await Task.WhenAll(annTask, graphTask, relationshipTask);
        var annCandidates = await annTask;

        // ハイブリッドコレクションがない場合のフォールバック
        if (annCandidates.Count == 0)
        {
            annCandidates = await _qdrant.SearchMetadataSimilarAsync(
                seedSongId,
                _opts.AnnCandidates,
                cancellationToken,
                playedSet);
        }
        var vocalistDiversityAssessmentIds = annCandidates
            .Take(VocalistDiversityAssessmentCandidateCount)
            .Select(candidate => candidate.SongId)
            .ToHashSet();

        // --- 2. 知識グラフ バイアス付きランダムウォーク ---
        var graphCandidates = await graphTask;
        var relationshipCandidates = await relationshipTask;

        // ANN + Graph の候補を統合 (ANN スコアを基準にグラフ候補を加点)
        var candidateScores = new Dictionary<int, double>();
        foreach (var (id, score) in annCandidates)
            candidateScores[id] = score;

        foreach (var (id, score) in graphCandidates)
        {
            // Repeated graph visits used to grow without a bound and could
            // overwhelm ANN relevance. Saturation keeps producer context useful
            // without turning the graph walk into a same-catalog shortcut.
            var graphSignal = 1.0 - Math.Exp(-Math.Max(0, score));
            if (candidateScores.TryGetValue(id, out var existing))
                candidateScores[id] = existing + graphSignal * _opts.GraphScoreWeight;
            else
                candidateScores[id] = graphSignal * _opts.GraphScoreWeight * 0.75;
        }

        // Non-vocalist tag relationships widen a catalog-heavy ANN/graph pool.
        // Reciprocal-rank decay keeps this a fallback signal instead of a quota.
        foreach (var (id, index) in relationshipCandidates.Select((id, index) => (id, index)))
        {
            if (playedSet.Contains(id)) continue;
            var relationshipSignal = _opts.RelationshipScoreWeight / Math.Sqrt(index + 1.0);
            if (candidateScores.TryGetValue(id, out var existing))
                candidateScores[id] = existing + relationshipSignal;
            else
                candidateScores[id] = relationshipSignal;
        }

        var mergedCandidates = candidateScores
            .OrderByDescending(kv => kv.Value)
            .Select(kv => (kv.Key, kv.Value))
            .ToList();

        // --- 3. 候補多様性フィルタ: 同一プロデューサーを上位 N 件に制限 ---
        var candidateInfos = await _db.GetSongInfoBatchAsync(
            mergedCandidates.Select(c => c.Key),
            cancellationToken);
        var vocalistDiversityAssessmentInfos = candidateInfos
            .Where(info => vocalistDiversityAssessmentIds.Contains(info.Id));
        if (MetadataRelationshipRanking.NeedsDiverseFallback(
            candidateInfos,
            vocalistDiversityAssessmentInfos))
        {
            var maximumScore = mergedCandidates.Count == 0
                ? 1.0
                : Math.Max(1e-9, mergedCandidates.Max(candidate => candidate.Value));
            var restrictedCandidatePool = candidateScores.Keys.ToArray();
            var fallbackSelection = await GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
                DiverseFallbackCandidateCount,
                candidateInfos,
                token => _db.GetRestrictedDiverseFallbackCandidateIdsAsync(
                    seedSongId,
                    DiverseFallbackCandidateCount,
                    restrictedCandidatePool,
                    token),
                token => _db.GetQualityDiverseFallbackCandidateIdsAsync(
                    seedSongId,
                    DbService.QualityDiverseFallbackPoolCount,
                    token),
                (ids, token) => _db.GetSongInfoBatchAsync(ids, token),
                token => _db.GetDiverseFallbackCandidateIdsAsync(
                    seedSongId,
                    DiverseFallbackCandidateCount,
                    token),
                cancellationToken);
            MergeDiverseFallbackCandidates(
                candidateScores,
                fallbackSelection.CandidateIds,
                playedSet,
                maximumScore,
                _opts.DiverseFallbackScoreWeight);
            mergedCandidates = candidateScores
                .OrderByDescending(candidate => candidate.Value)
                .Select(candidate => (candidate.Key, candidate.Value))
                .ToList();
            candidateInfos = await _db.GetSongInfoBatchAsync(
                mergedCandidates.Select(candidate => candidate.Key),
                cancellationToken);
        }
        var eligibleIds = candidateInfos
            .Where(DiscoveryEligibility.IsEligible)
            .Select(info => info.Id)
            .ToHashSet();
        mergedCandidates = mergedCandidates
            .Where(candidate => eligibleIds.Contains(candidate.Key))
            .ToList();
        // count の 1/3 を同一プロデューサー上限とし、残りを他プロデューサーで埋める
        // Shared singers stay eligible; singer-only matches receive a continuous score correction.
        mergedCandidates = MetadataRelationshipRanking.CorrectSingerOnlyBias(
            mergedCandidates,
            seedSong,
            candidateInfos);
        mergedCandidates = RecommendationQuality.ApplyEvidencePenalty(
            mergedCandidates,
            candidateInfos);
        var filtered = await _markov.FilterAsync(
            seedSong,
            mergedCandidates,
            candidateInfos,
            cancellationToken);

        double lambda = Math.Max(0.2, _opts.BaseDiversity - sessionProgress * 0.3);
        var reranked  = MmrRerank(
            filtered,
            candidateInfos,
            count,
            lambda,
            _opts.ProducerDiversityWeight,
            _opts.VocalistDiversityWeight);

        var resultInfos = (await _db.GetSongInfoBatchAsync(
                reranked.Select(r => r.SongId),
                cancellationToken))
            .Where(DiscoveryEligibility.IsEligible)
            .ToArray();
        var infoMap     = resultInfos.ToDictionary(i => i.Id);

        var items = reranked
            .Where(r => infoMap.ContainsKey(r.SongId))
            .Select(r => new RecommendItem(
                SongId:    r.SongId,
                Name:      infoMap[r.SongId].Name,
                Artist:    infoMap[r.SongId].ArtistString,
                Score:     r.Score,
                Reason:    r.Reason,
                ProducerIds: infoMap[r.SongId].ProducerIds,
                VocalistIds: infoMap[r.SongId].VocalistIds,
                YoutubeViews: infoMap[r.SongId].YoutubeViews,
                NicoViews: infoMap[r.SongId].NicoViews))
            .ToList();

        return new RecommendResponse(items, null);
    }

    internal static async Task<DiverseFallbackCandidateSelection>
        GetDiverseFallbackCandidateIdsRestrictedFirstAsync(
        int requiredCount,
        IReadOnlyCollection<SongInfo> candidateInfos,
        Func<CancellationToken, Task<int[]>> restrictedLoader,
        Func<CancellationToken, Task<int[]>> qualityReservoirLoader,
        Func<IReadOnlyCollection<int>, CancellationToken, Task<SongInfo[]>> songInfoLoader,
        Func<CancellationToken, Task<int[]>> globalLoader,
        CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(requiredCount);
        ArgumentNullException.ThrowIfNull(candidateInfos);
        ArgumentNullException.ThrowIfNull(restrictedLoader);
        ArgumentNullException.ThrowIfNull(qualityReservoirLoader);
        ArgumentNullException.ThrowIfNull(songInfoLoader);
        ArgumentNullException.ThrowIfNull(globalLoader);
        cancellationToken.ThrowIfCancellationRequested();

        var restrictedIds = await restrictedLoader(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (RestrictedDiverseFallbackIsUsable(
            restrictedIds,
            requiredCount,
            candidateInfos))
        {
            return new DiverseFallbackCandidateSelection(
                restrictedIds,
                DiverseFallbackCandidateSource.RestrictedExisting);
        }

        var qualityReservoirIds = await qualityReservoirLoader(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (qualityReservoirIds.Length > 0)
        {
            var qualityReservoirInfos = await songInfoLoader(
                qualityReservoirIds,
                cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            var selectedQualityIds = SelectQualityDiverseFallbackCandidateIds(
                qualityReservoirIds,
                qualityReservoirInfos,
                requiredCount);
            if (RestrictedDiverseFallbackIsUsable(
                selectedQualityIds,
                requiredCount,
                qualityReservoirInfos))
            {
                return new DiverseFallbackCandidateSelection(
                    selectedQualityIds,
                    DiverseFallbackCandidateSource.QualityReservoir);
            }
        }

        return new DiverseFallbackCandidateSelection(
            await globalLoader(cancellationToken),
            DiverseFallbackCandidateSource.ExactGlobal);
    }

    internal static int[] SelectQualityDiverseFallbackCandidateIds(
        IReadOnlyCollection<int> orderedCandidateIds,
        IReadOnlyCollection<SongInfo> candidateInfos,
        int requiredCount)
    {
        ArgumentNullException.ThrowIfNull(orderedCandidateIds);
        ArgumentNullException.ThrowIfNull(candidateInfos);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(requiredCount);

        var infoMap = candidateInfos
            .GroupBy(info => info.Id)
            .ToDictionary(group => group.Key, group => group.First());
        var orderedIds = orderedCandidateIds
            .Where(id => id > 0)
            .Distinct()
            .Where(id => infoMap.TryGetValue(id, out var info)
                && DiscoveryEligibility.IsEligible(info)
                && info.ProducerIds.Length > 0
                && info.VocalistIds.Length > 0)
            .ToArray();
        var fullIdentityCap = Math.Max(1, (int)Math.Ceiling(requiredCount * 0.20));
        var prefixCount = Math.Min(MetadataDiversityProbeMinimumCount, requiredCount);
        var prefixIds = SelectStableDiversePrefixCandidateIds(
            orderedIds.Take(MetadataDiversityCanonicalLookaheadCount),
            infoMap,
            prefixCount,
            Math.Min(fullIdentityCap, (int)Math.Ceiling(prefixCount * 0.60)));
        if (prefixIds.Length != prefixCount)
            return [];

        var selectedIds = new List<int>(requiredCount);
        var selectedSet = new HashSet<int>();
        var producerCounts = new Dictionary<int, int>();
        var vocalistCounts = new Dictionary<int, int>();
        foreach (var id in prefixIds)
        {
            if (!TryAddWithinRelationshipCaps(
                infoMap[id],
                producerCounts,
                vocalistCounts,
                fullIdentityCap))
            {
                return [];
            }
            selectedIds.Add(id);
            selectedSet.Add(id);
        }

        foreach (var id in orderedIds)
        {
            if (selectedIds.Count >= requiredCount)
                break;
            if (selectedSet.Contains(id)
                || !TryAddWithinRelationshipCaps(
                    infoMap[id],
                    producerCounts,
                    vocalistCounts,
                    fullIdentityCap))
            {
                continue;
            }
            selectedIds.Add(id);
            selectedSet.Add(id);
        }
        return selectedIds.Count == requiredCount ? selectedIds.ToArray() : [];
    }

    internal static bool RestrictedDiverseFallbackIsUsable(
        IReadOnlyCollection<int> restrictedIds,
        int requiredCount,
        IReadOnlyCollection<SongInfo> candidateInfos)
    {
        if (restrictedIds.Count != requiredCount)
            return false;

        var restrictedIdSet = restrictedIds.ToHashSet();
        if (restrictedIdSet.Count != requiredCount)
            return false;

        var restrictedInfos = candidateInfos
            .Where(info => restrictedIdSet.Contains(info.Id))
            .ToArray();
        return restrictedInfos.Length == requiredCount
            && !MetadataRelationshipRanking.NeedsDiverseFallback(restrictedInfos);
    }

    internal static int MetadataDiversityProbeCount(
        int availableCount,
        int requestedCount) =>
        Math.Min(
            Math.Max(0, availableCount),
            Math.Max(MetadataDiversityProbeMinimumCount, requestedCount));

    internal static int MetadataDiversityCanonicalRerankCount(
        int availableCount,
        int requestedCount) =>
        Math.Min(
            Math.Max(0, availableCount),
            Math.Max(MetadataDiversityCanonicalLookaheadCount, requestedCount));

    internal static List<(int SongId, double Score)> StabilizeMetadataFallbackDiversity(
        IReadOnlyCollection<(int SongId, double Score)> rerankedCandidates,
        IReadOnlyCollection<SongInfo> candidateInfos)
    {
        ArgumentNullException.ThrowIfNull(rerankedCandidates);
        ArgumentNullException.ThrowIfNull(candidateInfos);
        var ordered = rerankedCandidates.ToList();
        if (ordered.Count < MetadataDiversityProbeMinimumCount
            || ordered.Select(candidate => candidate.SongId).Distinct().Count() != ordered.Count)
        {
            return ordered;
        }

        var infoMap = candidateInfos
            .GroupBy(info => info.Id)
            .ToDictionary(group => group.Key, group => group.First());
        var currentProbeIds = ordered
            .Take(MetadataDiversityProbeMinimumCount)
            .Select(candidate => candidate.SongId)
            .ToArray();
        if (DiverseProbeIsUsable(currentProbeIds, infoMap))
            return ordered;

        var prefixIds = SelectStableDiversePrefixCandidateIds(
            ordered
                .Take(MetadataDiversityCanonicalLookaheadCount)
                .Select(candidate => candidate.SongId),
            infoMap,
            MetadataDiversityProbeMinimumCount,
            identityCap: 12);
        if (prefixIds.Length != MetadataDiversityProbeMinimumCount
            || !DiverseProbeIsUsable(prefixIds, infoMap))
        {
            return ordered;
        }

        var prefixSet = prefixIds.ToHashSet();
        var candidateMap = ordered.ToDictionary(candidate => candidate.SongId);
        return prefixIds
            .Select(id => candidateMap[id])
            .Concat(ordered.Where(candidate => !prefixSet.Contains(candidate.SongId)))
            .ToList();
    }

    internal static async Task<int[]?> GetMetadataGlobalFallbackIfNeededAsync(
        DiverseFallbackCandidateSelection fallbackSelection,
        IReadOnlyCollection<(int SongId, double Score)> rerankedCandidates,
        IReadOnlyCollection<SongInfo> candidateInfos,
        Func<CancellationToken, Task<int[]>> globalLoader,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rerankedCandidates);
        ArgumentNullException.ThrowIfNull(candidateInfos);
        ArgumentNullException.ThrowIfNull(globalLoader);
        cancellationToken.ThrowIfCancellationRequested();
        if (fallbackSelection.Source == DiverseFallbackCandidateSource.ExactGlobal)
            return null;

        var diversityProbeCandidates = rerankedCandidates
            .Take(MetadataDiversityProbeMinimumCount)
            .ToArray();
        var selectedIds = diversityProbeCandidates
            .Select(candidate => candidate.SongId)
            .ToHashSet();
        var selectedInfos = candidateInfos
            .Where(info => selectedIds.Contains(info.Id))
            .ToArray();
        var needsGlobalFallback = selectedIds.Count != diversityProbeCandidates.Length
            || selectedInfos.Length != selectedIds.Count
            || MetadataRelationshipRanking.NeedsDiverseFallback(selectedInfos);
        if (!needsGlobalFallback)
            return null;

        return await globalLoader(cancellationToken);
    }

    private static int[] SelectStableDiversePrefixCandidateIds(
        IEnumerable<int> orderedCandidateIds,
        IReadOnlyDictionary<int, SongInfo> infoMap,
        int prefixCount,
        int identityCap)
    {
        if (prefixCount < MetadataDiversityProbeMinimumCount)
            return [];

        var candidates = orderedCandidateIds
            .Distinct()
            .Where(id => infoMap.TryGetValue(id, out var info)
                && DiscoveryEligibility.IsEligible(info)
                && info.ProducerIds.Length > 0
                && info.VocalistIds.Length > 0)
            .ToArray();
        var anchorIds = new HashSet<int>();
        var anchorProducerIds = new HashSet<int>();
        var anchorVocalistIds = new HashSet<int>();
        foreach (var id in candidates)
        {
            var info = infoMap[id];
            var addsProducer = anchorProducerIds.Count < 8
                && info.ProducerIds.Distinct().Any(producerId => !anchorProducerIds.Contains(producerId));
            var addsVocalist = anchorVocalistIds.Count < 8
                && info.VocalistIds.Distinct().Any(vocalistId => !anchorVocalistIds.Contains(vocalistId));
            if (!addsProducer && !addsVocalist)
                continue;

            anchorIds.Add(id);
            anchorProducerIds.UnionWith(info.ProducerIds.Distinct());
            anchorVocalistIds.UnionWith(info.VocalistIds.Distinct());
            if (anchorProducerIds.Count >= 8 && anchorVocalistIds.Count >= 8)
                break;
        }
        if (anchorProducerIds.Count < 8 || anchorVocalistIds.Count < 8)
            return [];

        var selected = new List<int>(prefixCount);
        var producerCounts = new Dictionary<int, int>();
        var vocalistCounts = new Dictionary<int, int>();
        var remainingAnchors = anchorIds.Count;
        foreach (var id in candidates)
        {
            var isAnchor = anchorIds.Contains(id);
            if (isAnchor)
                remainingAnchors--;
            if (!isAnchor && selected.Count + remainingAnchors >= prefixCount)
                continue;
            if (!TryAddWithinRelationshipCaps(
                infoMap[id],
                producerCounts,
                vocalistCounts,
                identityCap))
            {
                if (isAnchor)
                    return [];
                continue;
            }

            selected.Add(id);
            if (selected.Count == prefixCount && remainingAnchors == 0)
                break;
        }

        if (selected.Count != prefixCount)
            return [];
        return DiverseProbeIsUsable(selected, infoMap) ? selected.ToArray() : [];
    }

    private static bool TryAddWithinRelationshipCaps(
        SongInfo info,
        Dictionary<int, int> producerCounts,
        Dictionary<int, int> vocalistCounts,
        int identityCap)
    {
        var producerIds = info.ProducerIds.Distinct().ToArray();
        var vocalistIds = info.VocalistIds.Distinct().ToArray();
        if (producerIds.Any(id => producerCounts.GetValueOrDefault(id) >= identityCap)
            || vocalistIds.Any(id => vocalistCounts.GetValueOrDefault(id) >= identityCap))
        {
            return false;
        }

        foreach (var id in producerIds)
            producerCounts[id] = producerCounts.GetValueOrDefault(id) + 1;
        foreach (var id in vocalistIds)
            vocalistCounts[id] = vocalistCounts.GetValueOrDefault(id) + 1;
        return true;
    }

    private static bool DiverseProbeIsUsable(
        IReadOnlyCollection<int> candidateIds,
        IReadOnlyDictionary<int, SongInfo> infoMap)
    {
        if (candidateIds.Count != MetadataDiversityProbeMinimumCount
            || candidateIds.Distinct().Count() != candidateIds.Count
            || candidateIds.Any(id => !infoMap.ContainsKey(id)))
        {
            return false;
        }
        return !MetadataRelationshipRanking.NeedsDiverseFallback(
            candidateIds.Select(id => infoMap[id]));
    }

    internal static void MergeDiverseFallbackCandidates(
        IDictionary<int, double> candidateScores,
        IEnumerable<int> fallbackIds,
        IReadOnlySet<int> excludedSongIds,
        double maximumScore,
        double fallbackScoreWeight)
    {
        foreach (var (id, index) in fallbackIds.Select((id, index) => (id, index)))
        {
            if (excludedSongIds.Contains(id)) continue;
            var fallbackScore = maximumScore
                * fallbackScoreWeight
                / Math.Pow(index + 1.0, 0.15);
            if (!candidateScores.TryGetValue(id, out var existingScore)
                || existingScore < fallbackScore)
            {
                candidateScores[id] = fallbackScore;
            }
        }
    }

    /// <summary>
    /// Merges several temporary browser-selected seeds with weighted reciprocal
    /// rank fusion. No per-user data is persisted: callers send only the small
    /// seed/exclusion summary for this request.
    /// </summary>
    public async Task<RecommendResponse> RecommendFromSeedsAsync(
        IReadOnlyList<RecommendSeed> seeds,
        int count,
        double sessionProgress,
        CancellationToken cancellationToken,
        IReadOnlySet<int>? excludedSongIds = null,
        int offset = 0)
    {
        var normalizedSeeds = seeds
            .Where(seed => seed.SongId > 0 && seed.Weight > 0)
            .GroupBy(seed => seed.SongId)
            .Select(group => new RecommendSeed(group.Key, Math.Min(1.0, group.Max(seed => seed.Weight))))
            .OrderByDescending(seed => seed.Weight)
            .Take(8)
            .ToList();
        if (normalizedSeeds.Count == 0)
            return new RecommendResponse([], "at least one valid seed is required");

        var perSeedCount = Math.Min(100, Math.Max(30, count));
        var results = await Task.WhenAll(normalizedSeeds.Select(async seed => new
        {
            Seed = seed,
            Response = await RecommendAsync(
                seed.SongId,
                perSeedCount,
                sessionProgress,
                cancellationToken),
        }));
        var excluded = excludedSongIds is null
            ? new HashSet<int>()
            : new HashSet<int>(excludedSongIds);
        foreach (var seed in normalizedSeeds) excluded.Add(seed.SongId);
        var scores = new Dictionary<int, (RecommendItem Item, double Score)>();
        var errors = new List<string>();

        foreach (var result in results)
        {
            if (!string.IsNullOrWhiteSpace(result.Response.Error)) errors.Add(result.Response.Error!);
            foreach (var (item, rank) in result.Response.Items.Select((item, rank) => (item, rank)))
            {
                if (excluded.Contains(item.SongId)) continue;
                var current = scores.GetValueOrDefault(item.SongId);
                var score = current.Score + result.Seed.Weight / (60.0 + rank + 1);
                scores[item.SongId] = (current.Item ?? item, score);
            }
        }

        var items = scores.Values
            .OrderByDescending(entry => entry.Score)
            .Skip(offset)
            .Take(count)
            .Select(entry => entry.Item with { Score = entry.Score })
            .ToList();
        return new RecommendResponse(items, items.Count > 0 ? null : errors.FirstOrDefault() ?? "no candidates found");
    }

    // ---- 同一プロデューサー上限フィルタ --------------------------

    /// <summary>
    /// 候補リストから同一プロデューサー曲を上位 maxSameProducer 件に制限する。
    /// 非同一プロデューサー曲は全て残す。
    /// </summary>
    private static List<(int SongId, double Score)> ApplyProducerDiversityCap(
        List<(int SongId, double Score)> candidates,
        SongInfo[] infos,
        IEnumerable<int> seedProducerIds,
        int maxSameProducer)
    {
        var seedProducers = seedProducerIds.ToHashSet();
        var infoMap       = infos.ToDictionary(i => i.Id);
        var result        = new List<(int SongId, double Score)>();
        int sameCount     = 0;

        foreach (var c in candidates)
        {
            bool sameProducer = infoMap.TryGetValue(c.SongId, out var info)
                && info.ProducerIds.Any(p => seedProducers.Contains(p));

            if (!sameProducer)
            {
                result.Add(c); // 他プロデューサーは全て保持
            }
            else if (sameCount < maxSameProducer)
            {
                result.Add(c);
                sameCount++;
            }
            // else: 同一プロデューサー上限超過 → スキップ
        }

        return result;
    }

    // ---- 知識グラフ バイアス付きランダムウォーク ----------------

    private async Task<List<(int SongId, double Score)>> KnowledgeGraphWalkAsync(
        SongInfo seed,
        HashSet<int> excludeIds,
        int steps,
        CancellationToken cancellationToken)
    {
        var scores = new Dictionary<int, double>();
        var songsByProducerCache = new Dictionary<string, int[]>();
        // Use a stable walk so offset-based requests share the same ranking.
        var rand   = new Random(seed.Id);
        var currentProducers = seed.ProducerIds.ToList();

        for (int i = 0; i < steps; i++)
        {
            if (currentProducers.Count == 0) break;

            // バイアス付き: 同一プロデューサーの曲を優先
            var producerBatch = currentProducers
                .OrderBy(_ => rand.Next())
                .Take(3)
                .ToArray();

            var producerBatchCacheKey = ProducerBatchCacheKey(producerBatch);
            if (!songsByProducerCache.TryGetValue(producerBatchCacheKey, out var songsByProducer))
            {
                songsByProducer = await _db.GetSongsByProducersAsync(
                    producerBatch,
                    seed.Id,
                    20,
                    cancellationToken);
                songsByProducerCache[producerBatchCacheKey] = songsByProducer;
            }

            foreach (var sid in songsByProducer)
            {
                if (excludeIds.Contains(sid)) continue;
                // 訪問回数をスコアに加算 (ランダムウォークの訪問頻度)
                scores[sid] = scores.GetValueOrDefault(sid, 0) + 1.0 / (i + 1);
            }

            // 次のステップのノードとして取得した曲のプロデューサーを使用 (探索範囲を広げる)
            if (songsByProducer.Length > 0 && rand.NextDouble() > _opts.GraphBias)
            {
                var nextSong = await _db.GetSongInfoAsync(
                    songsByProducer[rand.Next(songsByProducer.Length)],
                    cancellationToken);
                if (nextSong is not null)
                    currentProducers = nextSong.ProducerIds.ToList();
            }
        }

        return scores
            .OrderByDescending(kv => kv.Value)
            .Select(kv => (kv.Key, kv.Value))
            .ToList();
    }

    internal static string ProducerBatchCacheKey(IEnumerable<int> producerIds) =>
        string.Join(",", producerIds.Order());

    // ---- MMR (Maximal Marginal Relevance) 再ランキング ----------

    internal static List<(int SongId, double Score, string Reason)> MmrRerank(
        List<(int SongId, double Score)> candidates,
        SongInfo[] infos,
        int count,
        double lambda,
        double producerDiversityWeight,
        double vocalistDiversityWeight)
    {
        var infoMap = infos.ToDictionary(i => i.Id);
        var selected = new List<(int SongId, double Score, string Reason)>();
        var remaining = new List<(int SongId, double Score)>(candidates);
        var maximumRelevance = Math.Max(1e-9, remaining.Count == 0 ? 0 : remaining.Max(item => Math.Max(0, item.Score)));
        producerDiversityWeight = Math.Clamp(producerDiversityWeight, 0, 1);
        vocalistDiversityWeight = Math.Clamp(vocalistDiversityWeight, 0, 1);
        // Counts represent selected songs containing each relationship ID, not
        // raw array occurrences. This is the incremental form of the legacy scans.
        var selectedProducerCounts = new Dictionary<int, int>();
        var selectedVocalistCounts = new Dictionary<int, int>();

        while (selected.Count < count && remaining.Count > 0)
        {
            var bestIndex = -1;
            double bestMmr = double.NegativeInfinity;

            for (var index = 0; index < remaining.Count; index++)
            {
                var (sid, relevance) = remaining[index];
                var normalizedRelevance = Math.Clamp(relevance / maximumRelevance, 0, 1);
                double redundancy = 0;
                if (selected.Count > 0 && infoMap.TryGetValue(sid, out var info))
                {
                    var producerRepeats = info.ProducerIds.Length == 0 ? 0 : info.ProducerIds
                        .Max(id => selectedProducerCounts.GetValueOrDefault(id));
                    var vocalistRepeats = info.VocalistIds.Length == 0 ? 0 : info.VocalistIds
                        .Max(id => selectedVocalistCounts.GetValueOrDefault(id));
                    var producerRedundancy = 1.0 - Math.Exp(-0.9 * producerRepeats);
                    var vocalistRedundancy = 1.0 - Math.Exp(-0.55 * vocalistRepeats);
                    redundancy = Math.Min(1.0,
                        producerDiversityWeight * producerRedundancy
                        + vocalistDiversityWeight * vocalistRedundancy);
                }

                var mmr = lambda * normalizedRelevance - (1.0 - lambda) * redundancy;
                // Preserve the legacy strict-greater comparison, including its
                // behavior for non-finite defensive-test inputs.
                if (!(mmr > bestMmr)) continue;
                bestMmr = mmr;
                bestIndex = index;
            }

            if (bestIndex < 0) break;
            var bestCandidate = remaining[bestIndex];
            var best = (
                bestCandidate.SongId,
                Score: bestMmr,
                Reason: DetermineReason(bestCandidate.SongId, selected, infoMap));
            selected.Add(best);
            if (infoMap.TryGetValue(best.SongId, out var selectedInfo))
            {
                IncrementSelectedRelationshipCounts(
                    selectedProducerCounts,
                    selectedInfo.ProducerIds);
                IncrementSelectedRelationshipCounts(
                    selectedVocalistCounts,
                    selectedInfo.VocalistIds);
            }
            remaining.RemoveAll(r => r.SongId == best.SongId);
        }

        return selected;
    }

    private static string DetermineReason(
        int candidateId,
        List<(int SongId, double Score, string Reason)> selected,
        Dictionary<int, SongInfo> infoMap)
    {
        if (selected.Count == 0) return "similar";
        if (!infoMap.TryGetValue(candidateId, out var info)) return "similar";

        foreach (var (selId, _, _) in selected)
        {
            if (!infoMap.TryGetValue(selId, out var sel)) continue;
            if (SharesAny(info.ProducerIds, sel.ProducerIds)) return "same_producer";
            if (SharesAny(info.VocalistIds, sel.VocalistIds)) return "same_vocalist";
        }
        return "similar";
    }

    private static void IncrementSelectedRelationshipCounts(
        Dictionary<int, int> counts,
        int[] relationshipIds)
    {
        for (var index = 0; index < relationshipIds.Length; index++)
        {
            var relationshipId = relationshipIds[index];
            var alreadyCounted = false;
            for (var previousIndex = 0; previousIndex < index; previousIndex++)
            {
                if (relationshipIds[previousIndex] != relationshipId) continue;
                alreadyCounted = true;
                break;
            }
            if (!alreadyCounted)
                counts[relationshipId] = counts.GetValueOrDefault(relationshipId) + 1;
        }
    }

    private static bool SharesAny(int[] first, int[] second)
    {
        foreach (var firstId in first)
        foreach (var secondId in second)
        {
            if (firstId == secondId) return true;
        }
        return false;
    }
}

// ---- DTO ---------------------------------------------------------

public record RecommendItem(
    int    SongId,
    string Name,
    string Artist,
    double Score,
    string Reason,   // "similar" | "same_producer" | "same_vocalist"
    int[] ProducerIds,
    int[] VocalistIds,
    long YoutubeViews,
    long NicoViews
);

public record RecommendResponse(
    List<RecommendItem> Items,
    string? Error
);

public record RecommendSeed(int SongId, double Weight);
