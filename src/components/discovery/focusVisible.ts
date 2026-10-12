/** True when the element got focus from the keyboard (`:focus-visible`); true where the selector is unsupported. */
export function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}
