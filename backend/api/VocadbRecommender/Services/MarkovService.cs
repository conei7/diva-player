using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>
/// マルコフ連鎖フィルタリングサービス。
/// 現在の曲の状態クラスタから遷移確率が高い状態の曲を優先する。
/// </summary>
public class MarkovService
{
    private readonly DbService _db;
    private readonly RecommenderOptions _opts;

    public MarkovService(DbService db, IOptions<RecommenderOptions> opts)
    {
        _db   = db;
        _opts = opts.Value;
    }

    /// <summary>
    /// 候補リストをマルコフ連鎖でフィルタリングし、スコアを調整して返す。
    /// 遷移確率が低すぎる候補を除外または減点する。
    /// </summary>
    public async Task<List<(int SongId, double Score)>> FilterAsync(
        SongInfo seedSong,
        List<(int SongId, double Score)> candidates,
        SongInfo[] candidateInfos)
    {
        if (seedSong.StateCluster < 0)
            return candidates; // クラスタ未計算の場合はパス

        var matrix    = await _db.LoadMarkovMatrixAsync();
        var fromState = seedSong.StateCluster;

        if (!matrix.TryGetValue(fromState, out var transitions))
            return candidates;

        // 遷移確率上位 MarkovTopK 状態を許可
        var allowedStates = transitions
            .OrderByDescending(kv => kv.Value)
            .Take(_opts.MarkovTopK)
            .Select(kv => kv.Key)
            .ToHashSet();

        var infoMap = candidateInfos.ToDictionary(si => si.Id);

        return candidates
            .Select(c =>
            {
                if (!infoMap.TryGetValue(c.SongId, out var info))
                    return c;

                var toState = info.StateCluster;
                if (toState < 0)
                    return c;

                // 遷移確率でスコアを重みづけ
                var prob = transitions.GetValueOrDefault(toState, 0.01);
                var inAllowed = allowedStates.Contains(toState);
                var multiplier = inAllowed ? (1.0 + prob * 0.5) : 0.6;
                return (c.SongId, c.Score * multiplier);
            })
            .OrderByDescending(c => c.Score)
            .ToList();
    }
}
