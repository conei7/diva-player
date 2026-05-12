/**
 * ratingStore.ts - 楽曲の星評価（1〜5）グローバル管理
 *
 * Zustand persist ミドルウェアで LocalStorage (キー: "diva-ratings") に保存。
 * 評価は songId (number | string) をキーとした Record で管理する。
 * 同じ星を再クリックすると評価がリセット（未評価=0）される。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface RatingState {
  /** songId (文字列化) → 評価値 (1-5)。0 または未定義は未評価。 */
  ratings: Record<string, number>;

  /**
   * 評価を更新する。
   * 現在と同じ rating を渡すとリセット（0）になる。
   */
  setRating: (songId: string | number, rating: number) => void;

  /** 評価値を取得する（未評価なら 0 を返す）。 */
  getRating: (songId: string | number) => number;
}

export const useRatingStore = create<RatingState>()(
  persist(
    (set, get) => ({
      ratings: {},

      setRating: (songId, rating) => {
        const key = String(songId);
        const current = get().ratings[key] ?? 0;
        const next = current === rating ? 0 : rating; // 同じ星でリセット
        set((state) => ({ ratings: { ...state.ratings, [key]: next } }));
      },

      getRating: (songId) => get().ratings[String(songId)] ?? 0,
    }),
    { name: 'diva-ratings' },
  ),
);
