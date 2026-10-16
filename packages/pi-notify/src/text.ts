/** Limit UTF-16 length conservatively without splitting a Unicode code point. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let result = "";
  for (const character of text) {
    if (result.length + character.length > limit - 1) break;
    result += character;
  }
  return `${result}…`;
}
