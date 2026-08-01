import { beforeEach, describe, expect, it } from 'vitest';
import { useImplicitFeedbackStore } from './implicitFeedbackStore';

describe('implicit feedback playback sources', () => {
  beforeEach(() => useImplicitFeedbackStore.setState({ feedback: {} }));

  it('records discovery completion without treating it as manual or autoplay preference', () => {
    useImplicitFeedbackStore.getState().recordPlayback(42, 90, 100, 'discovery');

    expect(useImplicitFeedbackStore.getState().feedback['42']).toMatchObject({
      completeCount: 1,
      manualCompleteCount: 0,
      autoCompleteCount: 0,
      discoveryCompleteCount: 1,
    });
  });
});
