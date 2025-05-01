/**
 * Extracts length and optional start values from a string formatted as "n[@o]".
 * @param input - The input string.
 * @returns A tuple containing [n (length), o (start)].
 */
export function getRange(input: string): [number, number | null] {
  const parts = input.split('@');
  switch (parts.length) {
    case 0:
      return [0, null];
    case 1:
      return [parseInt(parts[0], 10), null];
    case 2:
      return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    default:
      return [0, null];
  }
}
