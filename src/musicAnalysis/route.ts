import { MUSIC_ANALYSIS_PATH } from '../utils/routes';

export function musicAnalysisPath(title: string, videoId: string): string {
  return `${MUSIC_ANALYSIS_PATH}?${new URLSearchParams({ title, video: videoId })}`;
}
