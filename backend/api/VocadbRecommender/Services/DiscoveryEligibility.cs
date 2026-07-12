namespace VocadbRecommender.Services;

/// <summary>
/// Hard boundary for discovery surfaces. The database keeps every VocaDB song,
/// but recommendations only use music with a core singing voice-synth vocalist
/// and at least one enabled PV.
/// </summary>
public static class DiscoveryEligibility
{
    public static bool IsEligible(SongInfo song)
        => song.HasCoreVoiceSynthVocalist
            && song.HasPlayablePv
            && song.SongType is "Original" or "Cover" or "Remix" or "Remaster" or "MusicPV";
}
