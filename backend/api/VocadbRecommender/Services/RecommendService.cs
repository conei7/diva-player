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
        string? sessionId,
        double sessionProgress,
        Dictionary<int, int>? ratedSongs = null)   // songId → 1-5 の評価値
    {
        // --- シード曲情報取得 ---
        var seedSong = await _db.GetSongInfoAsync(seedSongId);
        if (seedSong is null)
            return new RecommendResponse([], "seed song not found");

        // --- セッション履歴取得 (除外リスト用) ---
        int[] sessionHistory = sessionId is not null
            ? await _db.GetSessionHistoryAsync(sessionId)
            : [];
        var playedSet = sessionHistory.ToHashSet();
        playedSet.Add(seedSongId);

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
        var graphCandidates = await KnowledgeGraphWalkAsync(
            seedSong, playedSet, _opts.GraphWalkSteps);

        // ANN + Graph の候補を統合 (ANN スコアを基準にグラフ候補を加点)
        var candidateScores = new Dictionary<int, double>();
        foreach (var (id, score) in annCandidates)
            candidateScores[id] = score;

        foreach (var (id, score) in graphCandidates)
        {
            if (candidateScores.TryGetValue(id, out var existing))
                candidateScores[id] = existing + score * _opts.GraphBias;
            else
                candidateScores[id] = score * _opts.GraphBias * 0.7;
        }

        var mergedCandidates = candidateScores
            .OrderByDescending(kv => kv.Value)
            .Select(kv => (kv.Key, kv.Value))
            .ToList();

        // --- 3. 候補多様性フィルタ: 同一プロデューサーを上位 N 件に制限 ---
        var candidateInfos = await _db.GetSongInfoBatchAsync(
            mergedCandidates.Select(c => c.Key));
        // count の 1/3 を同一プロデューサー上限とし、残りを他プロデューサーで埋める
        int maxSameProd = Math.Max(2, count / 3);
        mergedCandidates = ApplyProducerDiversityCap(
            mergedCandidates, candidateInfos, seedSong.ProducerIds, maxSameProd);

        // --- 3.5. 好みプロファイルスコアリング (明示的フィードバック) ---
        if (ratedSongs is { Count: > 0 })
        {
            var ratedInfos = await _db.GetSongInfoBatchAsync(ratedSongs.Keys);
            var ratedWithRatings = ratedInfos
                .Select(i => (Info: i, Rating: ratedSongs.GetValueOrDefault(i.Id, 3)))
                .ToList();
            mergedCandidates = ApplyPreferenceScoring(
                mergedCandidates, candidateInfos, ratedWithRatings);
        }

        // --- 3.6. 暗黙的フィードバックスコアリング (再生完了率) ---
        var implicitScores = await _db.GetImplicitScoreMapAsync(
            mergedCandidates.Select(c => c.Key));
        if (implicitScores.Count > 0)
        {
            const double implicitBeta = 0.2;
            mergedCandidates = mergedCandidates
                .Select(c => implicitScores.TryGetValue(c.Key, out var iScore)
                    ? (Key: c.Key, Value: c.Value + iScore * implicitBeta)
                    : c)
                .OrderByDescending(c => c.Value)
                .ToList();
        }

        // --- 4. マルコフ連鎖フィルタリング ---
        var filtered = await _markov.FilterAsync(
            seedSong, mergedCandidates, candidateInfos);

        // --- 5. MMR 再ランキング (多様性 × 関連度) ---
        // セッション進行度が上がるほど多様性を下げる (より関連性重視)
        double lambda = Math.Max(0.2, _opts.BaseDiversity - sessionProgress * 0.3);
        var reranked  = MmrRerank(filtered, candidateInfos, count, lambda);

        // --- 6. VocaDB の曲情報を付けてレスポンスを生成 ---
        var resultInfos = await _db.GetSongInfoBatchAsync(reranked.Select(r => r.SongId));
        var infoMap     = resultInfos.ToDictionary(i => i.Id);

        var items = reranked
            .Where(r => infoMap.ContainsKey(r.SongId))
            .Select(r => new RecommendItem(
                SongId:    r.SongId,
                Name:      infoMap[r.SongId].Name,
                Artist:    infoMap[r.SongId].ArtistString,
                Score:     r.Score,
                Reason:    r.Reason))
            .ToList();

        return new RecommendResponse(items, null);
    }

    // ---- 好みプロファイルスコアリング (明示的フィードバック) ------

    /// <summary>
    /// 評価済み曲のプロデューサー/ボーカリストに基づいて候補スコアを加減算する。
    /// 評価5★ → +alpha ボーナス、評価1★ → -alpha ペナルティ。
    /// 滑らかな重み付けで、ハードコードの足切りを使わない。
    /// </summary>
    private static List<(int SongId, double Score)> ApplyPreferenceScoring(
        List<(int SongId, double Score)> candidates,
        SongInfo[] candidateInfos,
        IReadOnlyList<(SongInfo Info, int Rating)> ratedSongs,
        double alpha = 0.3)
    {
        var infoMap = candidateInfos.ToDictionary(i => i.Id);

        return candidates
            .Select(c =>
            {
                if (!infoMap.TryGetValue(c.SongId, out var info)) return c;

                double bonus     = 0;
                int    matchCount = 0;

                foreach (var (ratedInfo, rating) in ratedSongs)
                {
                    // -1 (最低評価) 〜 +1 (最高評価) の重み
                    double weight = (rating - 3.0) / 2.0;

                    var sharedProducers = info.ProducerIds.Intersect(ratedInfo.ProducerIds).Count();
                    var sharedVocalists = info.VocalistIds.Intersect(ratedInfo.VocalistIds).Count();

                    if (sharedProducers > 0 || sharedVocalists > 0)
                    {
                        bonus += weight * (sharedProducers * 0.6 + sharedVocalists * 0.3);
                        matchCount++;
                    }
                }

                double adjustment = matchCount > 0 ? bonus / matchCount * alpha : 0;
                return (SongId: c.SongId, Score: c.Score + adjustment);
            })
            .OrderByDescending(c => c.Score)
            .ToList();
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
        var rand   = new Random();
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
        double lambda)
    {
        // 簡易的な MMR: プロデューサー・ボーカリスト重複ペナルティ
        var infoMap = infos.ToDictionary(i => i.Id);
        var selected = new List<(int SongId, double Score, string Reason)>();
        var remaining = new List<(int SongId, double Score)>(candidates);

        while (selected.Count < count && remaining.Count > 0)
        {
            (int SongId, double Score, string Reason) best = default;
            double bestMmr = double.NegativeInfinity;

            foreach (var (sid, relevance) in remaining)
            {
                // MMR スコア = λ × 関連度 - (1-λ) × max(similarity to selected)
                double sim = 0;
                if (selected.Count > 0 && infoMap.TryGetValue(sid, out var info))
                {
                    foreach (var (selId, _, _) in selected)
                    {
                        if (!infoMap.TryGetValue(selId, out var selInfo)) continue;
                        // プロデューサー/ボーカリスト重複 → 類似度高
                        var sharedProducers = info.ProducerIds.Intersect(selInfo.ProducerIds).Count();
                        var sharedVocalists = info.VocalistIds.Intersect(selInfo.VocalistIds).Count();
                        var overlap = (sharedProducers * 0.6 + sharedVocalists * 0.3);
                        sim = Math.Max(sim, Math.Min(overlap, 1.0));
                    }
                }

                var mmr = lambda * relevance - (1.0 - lambda) * sim;
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
    string Reason   // "similar" | "same_producer" | "same_vocalist"
);

public record RecommendResponse(
    List<RecommendItem> Items,
    string? Error
);
