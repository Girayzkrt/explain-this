const DENSE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

export function estimateTokens(value: string): number {
  let estimate = 0;
  for (const character of value.normalize("NFC")) {
    if (/\s/u.test(character)) estimate += 0.1;
    else if (DENSE_SCRIPT.test(character)) estimate += 1;
    else estimate += 0.33;
  }
  return Math.ceil(estimate);
}
