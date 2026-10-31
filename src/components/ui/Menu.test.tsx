/**
 * Markup contract of menu rows (DESIGN_SPEC §4.5): keyboard focus shows an inset ring on top of the
 * hover tint. Rendered to static HTML, no DOM needed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MenuItem, MenuItemRadio } from './Menu';

function rowClass(html: string): string {
  return html.match(/class="([^"]*)"/)?.[1] ?? '';
}

describe('MenuItem', () => {
  it('draws a keyboard focus ring that outline-none cannot switch off', () => {
    const classes = rowClass(renderToStaticMarkup(<MenuItem onSelect={() => {}}>後で聴くに保存</MenuItem>)).split(' ');
    // outline-none sets --tw-outline-style: none, so the ring needs its own outline-solid.
    expect(classes).toEqual(expect.arrayContaining([
      'outline-none',
      'focus-visible:bg-yt-tonal',
      'focus-visible:outline-solid',
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-2',
      'focus-visible:outline-yt-focus',
    ]));
    expect(rowClass(renderToStaticMarkup(<MenuItemRadio checked onSelect={() => {}}>English</MenuItemRadio>)))
      .toContain('focus-visible:outline-solid');
  });

  it('leaves disabled rows without a ring (they are not focusable)', () => {
    const html = renderToStaticMarkup(<MenuItem disabled onSelect={() => {}}>後で聴くに保存</MenuItem>);
    expect(html).toContain('disabled=""');
    expect(rowClass(html)).not.toContain('focus-visible:outline');
  });

  it('keeps the tint on a content row while focus is on one of its controls', () => {
    const html = renderToStaticMarkup(<MenuItem keepOpen><button type="button">★</button></MenuItem>);
    expect(html).toMatch(/^<div [^>]*data-menu-item="content"/);
    expect(rowClass(html)).toContain('focus-within:bg-yt-tonal');
  });
});
