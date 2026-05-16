namespace VocadbRecommender.Services;

/// <summary>appsettings.json の Recommender セクション</summary>
public class RecommenderOptions
{
    public string QdrantEndpoint     { get; set; } = "http://localhost:6333";
    public string CollectionHybrid   { get; set; } = "song_hybrid";
    public string CollectionMetadata { get; set; } = "song_metadata";
    /// <summary>Named Vectors コレクション (audio + meta を1つに格納)</summary>
    public string CollectionNamed    { get; set; } = "songs_v2";
    public int    AnnCandidates      { get; set; } = 80;   // ANN探索候補数
    public int    GraphWalkSteps     { get; set; } = 40;   // ランダムウォークステップ数
    public double GraphBias          { get; set; } = 0.85; // 同一プロデューサーへのバイアス係数
    public int    MarkovTopK         { get; set; } = 10;   // マルコフで残す上位K状態
    public double BaseDiversity      { get; set; } = 0.5;  // MMR基本多様性パラメータ λ
    /// <summary>Named Vectors ハイブリッド検索の音響重み (0〜1)</summary>
    public double AudioWeight        { get; set; } = 0.4;
    /// <summary>Named Vectors ハイブリッド検索のメタ重み (0〜1)</summary>
    public double MetaWeight         { get; set; } = 0.6;
}
