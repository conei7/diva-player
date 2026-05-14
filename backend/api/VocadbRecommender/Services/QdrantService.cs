using Qdrant.Client;
using Qdrant.Client.Grpc;
using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>Qdrant ベクトルデータベースサービス (ANN 近似最近傍探索)</summary>
public class QdrantService
{
    private readonly QdrantClient _client;
    private readonly RecommenderOptions _opts;

    public QdrantService(IOptions<RecommenderOptions> opts)
    {
        _opts = opts.Value;
        _client = new QdrantClient(new Uri(_opts.QdrantEndpoint));
    }

    /// <summary>
    /// ハイブリッドコレクションで ANN 探索を行い、
    /// 類似度スコア付きの候補 (songId, score) リストを返す。
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchSimilarAsync(
        int seedSongId,
        int topK,
        IEnumerable<int>? excludeIds = null)
    {
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // シード曲のベクトルを取得
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionHybrid,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        // ANN 探索
        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionHybrid,
            vector: seedVector,
            limit: (ulong)(topK + excludeSet.Count + 10));  // 除外分を多めに

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }

    /// <summary>
    /// メタデータコレクションを使った探索 (音響未処理曲のフォールバック)
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchMetadataSimilarAsync(
        int seedSongId,
        int topK,
        IEnumerable<int>? excludeIds = null)
    {
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionMetadata,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionMetadata,
            vector: seedVector,
            limit: (ulong)(topK + excludeSet.Count + 10));

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }
}
