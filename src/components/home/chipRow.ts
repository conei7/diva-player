/**
 * Scrolls the chip bar's row (only the row, never the page) so the chip is in view, centred when it
 * was not. Focus with preventScroll leaves the row where it is, so a chip focused that way may be
 * scrolled out of the row.
 */
export function revealChipInRow(chip: HTMLElement): void {
  const scroller = chip.closest<HTMLElement>('.overflow-x-auto');
  if (!scroller) return;
  const chipRect = chip.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  if (chipRect.left >= scrollerRect.left && chipRect.right <= scrollerRect.right) return;
  scroller.scrollLeft += chipRect.left - scrollerRect.left - (scrollerRect.width - chipRect.width) / 2;
}
