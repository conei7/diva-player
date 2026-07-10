namespace VocadbRecommender.Services;

public static class RecommendationDiversity
{
    public static List<(int SongId, double Score)> ApplySeedArtistCaps(
        List<(int SongId, double Score)> candidates,
        SongInfo seedSong,
        SongInfo[] candidateInfos,
        int maxSameProducer,
        int maxSameVocalist,
        int minimumResults)
    {
        var infoMap = candidateInfos.ToDictionary(i => i.Id);
        var seedProducers = seedSong.ProducerIds.ToHashSet();
        var seedVocalists = seedSong.VocalistIds.ToHashSet();
        var result = new List<(int SongId, double Score)>();
        var deferred = new List<(int SongId, double Score)>();
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

            if ((sameProducer && sameProducerCount >= maxSameProducer)
                || (sameVocalist && sameVocalistCount >= maxSameVocalist))
            {
                deferred.Add(candidate);
                continue;
            }

            result.Add(candidate);
            if (sameProducer) sameProducerCount++;
            if (sameVocalist) sameVocalistCount++;
        }

        // Prefer diverse candidates, but do not return a short page when the
        // available candidate pool is dominated by the seed's artists.
        if (result.Count < minimumResults)
            result.AddRange(deferred.Take(minimumResults - result.Count));

        return result;
    }
}
