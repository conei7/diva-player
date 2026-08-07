using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>
/// 推薦メインサービス。
/// ANN → 知識グラフ探索 → マルコフフィルタ → MMR 再ランキング の順で処理。
/// </summary>
public class RecommendService
{
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
        double sessionProgress)
    {
        // --- シード曲情報取得 ---
        var seedSong = await _db.GetSongInfoAsync(seedSongId);
        if (seedSong is null)
            return new RecommendResponse([], "seed song not found");

        // Exclude the seed song from candidates. User playback history stays client-local.
        var playedSet = new HashSet<int> { seedSongId };

        // --- 1. ANN 近似最近傍探索 ---
        var annCandidates = await _qdrant.SearchSimilarAsync(
            seedSongId,
            _opts.AnnCandidates,
            playedSet);

        // ハイブリッドコレクションがない場合のフォールバック
        if (annCandidates.Count == 0)
        {
            annCandidates = await _qdrant.SearchMetadataSimilarAsync(
                seedSongId,
                _opts.AnnCandidates,
                playedSet);
        }

        // --- 2. 知識グラフ バイアス付きランダムウォーク ---
        var graphTask = KnowledgeGraphWalkAsync(seedSong, playedSet, _opts.GraphWalkSteps);
        var relationshipTask = _db.GetMetadataRelationshipCandidateIdsAsync(seedSongId, 300);
        await Task.WhenAll(graphTask, relationshipTask);
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
            mergedCandidates.Select(c => c.Key));
        if (MetadataRelationshipRanking.NeedsDiverseFallback(candidateInfos))
        {
            var maximumScore = mergedCandidates.Count == 0
                ? 1.0
                : Math.Max(1e-9, mergedCandidates.Max(candidate => candidate.Value));
            var fallbackIds = await _db.GetDiverseFallbackCandidateIdsAsync(seedSongId, 80);
            foreach (var (id, index) in fallbackIds.Select((id, index) => (id, index)))
            {
                if (playedSet.Contains(id) || candidateScores.ContainsKey(id)) continue;
                candidateScores[id] = maximumScore
                    * _opts.DiverseFallbackScoreWeight
                    / Math.Pow(index + 1.0, 0.15);
            }
            mergedCandidates = candidateScores
                .OrderByDescending(candidate => candidate.Value)
                .Select(candidate => (candidate.Key, candidate.Value))
                .ToList();
            candidateInfos = await _db.GetSongInfoBatchAsync(
                mergedCandidates.Select(candidate => candidate.Key));
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
            seedSong, mergedCandidates, candidateInfos);

        double lambda = Math.Max(0.2, _opts.BaseDiversity - sessionProgress * 0.3);
        var reranked  = MmrRerank(
            filtered,
            candidateInfos,
            count,
            lambda,
            _opts.ProducerDiversityWeight,
            _opts.VocalistDiversityWeight);

        var resultInfos = (await _db.GetSongInfoBatchAsync(reranked.Select(r => r.SongId)))
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

    /// <summary>
    /// Merges several temporary browser-selected seeds with weighted reciprocal
    /// rank fusion. No per-user data is persisted: callers send only the small
    /// seed/exclusion summary for this request.
    /// </summary>
    public async Task<RecommendResponse> RecommendFromSeedsAsync(
        IReadOnlyList<RecommendSeed> seeds,
        int count,
        double sessionProgress,
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
            Response = await RecommendAsync(seed.SongId, perSeedCount, sessionProgress),
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
        int steps)
    {
        var scores = new Dictionary<int, double>();
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

            var songsByProducer = await _db.GetSongsByProducersAsync(
                producerBatch, seed.Id, 20);

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
                    songsByProducer[rand.Next(songsByProducer.Length)]);
                if (nextSong is not null)
                    currentProducers = nextSong.ProducerIds.ToList();
            }
        }

        return scores
            .OrderByDescending(kv => kv.Value)
            .Select(kv => (kv.Key, kv.Value))
            .ToList();
    }

    // ---- MMR (Maximal Marginal Relevance) 再ランキング ----------

    private static List<(int SongId, double Score, string Reason)> MmrRerank(
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

        while (selected.Count < count && remaining.Count > 0)
        {
            (int SongId, double Score, string Reason) best = default;
            double bestMmr = double.NegativeInfinity;

            foreach (var (sid, relevance) in remaining)
            {
                var normalizedRelevance = Math.Clamp(relevance / maximumRelevance, 0, 1);
                double redundancy = 0;
                if (selected.Count > 0 && infoMap.TryGetValue(sid, out var info))
                {
                    var selectedInfos = selected
                        .Select(item => infoMap.GetValueOrDefault(item.SongId))
                        .Where(item => item is not null)
                        .Cast<SongInfo>()
                        .ToArray();
                    var producerRepeats = info.ProducerIds.Length == 0 ? 0 : info.ProducerIds
                        .Max(id => selectedInfos.Count(item => item.ProducerIds.Contains(id)));
                    var vocalistRepeats = info.VocalistIds.Length == 0 ? 0 : info.VocalistIds
                        .Max(id => selectedInfos.Count(item => item.VocalistIds.Contains(id)));
                    var producerRedundancy = 1.0 - Math.Exp(-0.9 * producerRepeats);
                    var vocalistRedundancy = 1.0 - Math.Exp(-0.55 * vocalistRepeats);
                    redundancy = Math.Min(1.0,
                        producerDiversityWeight * producerRedundancy
                        + vocalistDiversityWeight * vocalistRedundancy);
                }

                var mmr = lambda * normalizedRelevance - (1.0 - lambda) * redundancy;
                if (mmr > bestMmr)
                {
                    bestMmr = mmr;
                    var reason = DetermineReason(sid, selected, infoMap);
                    best = (sid, mmr, reason);
                }
            }

            if (best == default) break;
            selected.Add(best);
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
            if (info.ProducerIds.Intersect(sel.ProducerIds).Any()) return "same_producer";
            if (info.VocalistIds.Intersect(sel.VocalistIds).Any()) return "same_vocalist";
        }
        return "similar";
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
