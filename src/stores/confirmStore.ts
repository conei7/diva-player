/**
 * Confirmation for actions that cannot be undone (DESIGN_SPEC §4.7): clearing all history,
 * replacing data from a backup, deleting a folder, discarding unapplied filters, unhiding every
 * hidden song. Undoable deletions use a toast with 「元に戻す」 instead. Replaces window.confirm.
 * Labels are passed in already translated (the host translates only the default 「キャンセル」).
 */
import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Default 「キャンセル」. */
  cancelLabel?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
}

interface ConfirmState {
  /** requests[0] is on screen; later ones wait. */
  requests: ConfirmRequest[];
}

export const useConfirmStore = create<ConfirmState>(() => ({ requests: [] }));

const resolvers = new Map<number, (confirmed: boolean) => void>();
let sequence = 0;

/** Asks the user; resolves true for the confirm button, false for cancel / Esc / backdrop. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const id = ++sequence;
  return new Promise<boolean>(resolve => {
    resolvers.set(id, resolve);
    useConfirmStore.setState(state => ({ requests: [...state.requests, { ...options, id }] }));
  });
}

/** Called by ConfirmHost. */
export function resolveConfirm(id: number, confirmed: boolean): void {
  const resolve = resolvers.get(id);
  if (!resolve) return;
  resolvers.delete(id);
  useConfirmStore.setState(state => ({ requests: state.requests.filter(request => request.id !== id) }));
  resolve(confirmed);
}

/** `const confirm = useConfirm(); if (await confirm({ … })) …` */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirmDialog;
}
