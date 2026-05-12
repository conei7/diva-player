namespace VocadbRecommender.Services;

/// <summary>appsettings.json の Recommender セクション</summary>
public class RecommenderOptions
{
    public string QdrantEndpoint     { get; set; } = "http://localhost:6333";
    public string CollectionHybrid   { get; set; } = "song_hybrid";
    public string CollectionMetadata { get; set; } = "song_metadata";
    public int    AnnCandidates      { get; set; } = 80;   // ANN探索候補数
    public int    GraphWalkSteps     { get; set; } = 40;   // ランダムウォークステップ数
    public double GraphBias          { get; set; } = 0.85; // 同一プロデューサーへのバイアス係数
    public int    MarkovTopK         { get; set; } = 10;   // マルコフで残す上位K状態
    public double BaseDiversity      { get; set; } = 0.5;  // MMR基本多様性パラメータ λ
}
