namespace VocadbRecommender.Services;

public static class RecommendationDiversity
{
    public static List<(int SongId, double Score)> ApplySeedArtistCaps(
        List<(int SongId, double Score)> candidates,
        SongInfo seedSong,
        SongInfo[] candidateInfos,
        int maxSameProducer,
        int maxSameVocalist)
    {
        var infoMap = candidateInfos.ToDictionary(i => i.Id);
        var seedProducers = seedSong.ProducerIds.ToHashSet();
        var seedVocalists = seedSong.VocalistIds.ToHashSet();
        var result = new List<(int SongId, double Score)>();
        var sameProducerCount = 0;
        var sameVocalistCount = 0;

        foreach (var candidate in candidates)
        {
            if (!infoMap.TryGetValue(candidate.SongId, out var info))
                continue;

            var sameProducer = seedProducers.Count > 0
                && info.ProducerIds.Any(seedProducers.Contains);
            var sameVocalist = seedVocalists.Count > 0
                && info.VocalistIds.Any(seedVocalists.Contains);

            if (sameProducer && sameProducerCount >= maxSameProducer)
                continue;
            if (sameVocalist && sameVocalistCount >= maxSameVocalist)
                continue;

            result.Add(candidate);
            if (sameProducer) sameProducerCount++;
            if (sameVocalist) sameVocalistCount++;
        }

        return result;
    }
}
