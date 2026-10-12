import { beforeEach, describe, expect, it } from 'vitest';
import { confirmDialog, resolveConfirm, useConfirm, useConfirmStore } from './confirmStore';

const requests = () => useConfirmStore.getState().requests;

describe('confirmStore', () => {
  beforeEach(() => {
    for (const request of requests()) resolveConfirm(request.id, false);
  });

  it('resolves true when confirmed and removes the request', async () => {
    const answer = confirmDialog({ title: '再生履歴をすべて削除しますか？', confirmLabel: '削除' });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ title: '再生履歴をすべて削除しますか？', confirmLabel: '削除' });
    resolveConfirm(requests()[0].id, true);
    await expect(answer).resolves.toBe(true);
    expect(requests()).toHaveLength(0);
  });

  it('resolves false when cancelled', async () => {
    const answer = confirmDialog({ title: 'フォルダーを削除しますか？', message: '中のプレイリストは未分類に移ります', confirmLabel: '削除' });
    resolveConfirm(requests()[0].id, false);
    await expect(answer).resolves.toBe(false);
  });

  it('shows requests one at a time in order', async () => {
    const first = confirmDialog({ title: '1', confirmLabel: 'OK' });
    const second = confirmDialog({ title: '2', confirmLabel: 'OK', cancelLabel: '戻る' });
    expect(requests().map(request => request.title)).toEqual(['1', '2']);
    resolveConfirm(requests()[0].id, true);
    await expect(first).resolves.toBe(true);
    expect(requests()[0]).toMatchObject({ title: '2', cancelLabel: '戻る' });
    resolveConfirm(requests()[0].id, false);
    await expect(second).resolves.toBe(false);
  });

  it('ignores unknown or already answered requests', async () => {
    const answer = confirmDialog({ title: 'x', confirmLabel: 'OK' });
    const { id } = requests()[0];
    resolveConfirm(id, true);
    resolveConfirm(id, false);
    resolveConfirm(9999, true);
    await expect(answer).resolves.toBe(true);
    expect(requests()).toHaveLength(0);
  });

  it('useConfirm returns the same function as confirmDialog', () => {
    expect(useConfirm()).toBe(confirmDialog);
  });
});
