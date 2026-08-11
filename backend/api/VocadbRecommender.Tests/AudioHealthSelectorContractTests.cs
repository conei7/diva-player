using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class AudioHealthSelectorContractTests
{
    [Fact]
    public void ActionablePvPredicate_MatchesDownloaderEligibilityContract()
    {
        Assert.Equal(
            """
            p.disabled = FALSE
            AND p.pv_type IN ('Original', 'Reprint')
            AND p.service IN ('Youtube', 'NicoNicoDouga')
            AND NULLIF(BTRIM(p.pv_id), '') IS NOT NULL
            """,
            DbService.AudioHealthActionablePvPredicateSql);
    }
}
