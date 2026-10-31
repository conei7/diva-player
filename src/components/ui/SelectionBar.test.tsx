/**
 * The selection bar is a size container: the playlist page switches its text / icon actions with
 * container queries on the bar (the bar is narrower in the music layout). Static HTML, no DOM.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SelectionBar from './SelectionBar';

describe('SelectionBar', () => {
  it('is a fixed toolbar that is also a container for its actions', () => {
    const html = renderToStaticMarkup(<SelectionBar data-testid="playlist-selection-bar" count={12} onClose={() => {}} />);
    const root = html.match(/^<div[^>]*>/)?.[0] ?? '';
    expect(root).toContain('role="toolbar"');
    expect(root).toMatch(/class="@container fixed /);
    expect(html).toContain('12曲を選択中');
  });
});
