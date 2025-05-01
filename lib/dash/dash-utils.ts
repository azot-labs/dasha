/**
 * Extracts StartRange and ExpectLength information from a string like "100-300"
 * @param range - The range string in the format "start-end"
 * @returns A tuple containing [StartRange, ExpectLength]
 */
export const parseRange = (range: string): [number, number] => {
  const [startRange, end] = range.split('-').map(Number);
  const expectLength = end - startRange + 1;
  return [startRange, expectLength];
};
