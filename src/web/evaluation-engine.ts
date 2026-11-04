export type Criterion = { id: string; label: string; weight: number; keywords: string };
export type CriterionResult = { criterion: Criterion; matched: string[]; missing: string[]; evidence: string[]; score: number; max: number };
const tokens = (text: string) => text.normalize('NFKC').toLocaleLowerCase('it').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function contains(needle: string[], haystack: string[]) {
  return needle.length > 0 && haystack.some((_, i) => needle.every((word, j) => haystack[i + j] === word));
}
/** Exact normalized word/phrase matching; evidence is quoted verbatim. */
export function evaluate(report: string, criteria: Criterion[]): CriterionResult[] {
  const sentences = (report.match(/[^.!?\n]+[.!?]?/gu) ?? []).map(s => s.trim()).filter(Boolean);
  const indexed = sentences.map(text => ({ text, words: tokens(text) }));
  return criteria.map(criterion => {
    const phrases = [...new Set(criterion.keywords.split(',').map(s => s.trim()).filter(s => tokens(s).length > 0))];
    const matched: string[] = [], missing: string[] = [], evidence = new Set<string>();
    for (const phrase of phrases) {
      const needle = tokens(phrase);
      const found = indexed.filter(sentence => contains(needle, sentence.words));
      if (found.length) { matched.push(phrase); found.forEach(sentence => evidence.add(sentence.text)); }
      else missing.push(phrase);
    }
    const max = Number.isFinite(criterion.weight) && criterion.weight >= 0 ? criterion.weight : 0;
    return { criterion, matched, missing, evidence: [...evidence].slice(0, 5), score: phrases.length ? max * matched.length / phrases.length : 0, max };
  });
}
