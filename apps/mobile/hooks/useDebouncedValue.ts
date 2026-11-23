import { useEffect, useState } from 'react';

/**
 * Delays a value until it has stopped changing for `delayMs`.
 *
 * Used by Search, at the 300ms the guidelines specify. Debouncing the *value*
 * rather than the request keeps the input itself perfectly responsive — the
 * field updates on every keystroke and only the query waits.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}
