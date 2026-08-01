namespace VocadbRecommender.Services;

/// <summary>
/// Soft confidence adjustment for proactive recommendations.
/// Similarity is still useful when a song is obscure or partially indexed, but
/// candidates with little supporting evidence should not outrank well-supported
/// songs solely because their tags happen to overlap.
/// </summary>
public static class RecommendationQuality
{
    public static double EvidenceMultiplier(SongInfo song)
    {
        var quality = Math.Clamp(song.QualityScore, 0.0, 1.0);
        var multiplier = 0.55 + quality * 0.45;

        // Missing audio removes an independent similarity signal. Keep the
        // candidate eligible, but make metadata-only matches clearly softer.
        if (!song.HasAudioFeatures) multiplier *= 0.62;

        // An Original PV is a useful identity/availability signal. Reprints
        // and other PVs remain valid, just with less confidence.
        if (!song.HasOriginalPv) multiplier *= 0.88;

        var totalViews = Math.Max(0L, song.YoutubeViews) + Math.Max(0L, song.NicoViews);
        multiplier *= totalViews switch
        {
            0 => 0.55,
            < 1_000 => 0.65,
            < 10_000 => 0.82,
            < 100_000 => 0.93,
            _ => 1.0,
        };

        if (song.FavoritedTimes <= 0) multiplier *= 0.92;
        return Math.Clamp(multiplier, 0.25, 1.0);
    }

    public static List<(int SongId, double Score)> ApplyEvidencePenalty(
        IEnumerable<(int SongId, double Score)> candidates,
        IEnumerable<SongInfo> candidateInfos)
    {
        var infoMap = candidateInfos.ToDictionary(info => info.Id);
        return candidates
            .Select(candidate => infoMap.TryGetValue(candidate.SongId, out var info)
                ? (candidate.SongId, Score: candidate.Score * EvidenceMultiplier(info))
                : candidate)
            .OrderByDescending(candidate => candidate.Score)
            .ThenBy(candidate => candidate.SongId)
            .ToList();
    }
}
