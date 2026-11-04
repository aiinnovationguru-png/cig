//! Motore deterministico indipendente dal database: le evidenze sono brani
//! letterali, non affermazioni generate. Non interpreta il significato giuridico.

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub coverage: f64,
    pub evidence: Vec<(String, Vec<String>)>,
    pub gaps: Vec<String>,
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn contains_words(haystack: &[String], needle: &[String]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

pub fn analyze(report: &str, requirements: &[String]) -> MatchResult {
    let sentences: Vec<&str> = report.split_inclusive(['.', '!', '?', '\n'])
        .map(str::trim).filter(|s| !s.is_empty()).collect();
    let tokens: Vec<Vec<String>> = sentences.iter().map(|sentence| words(sentence)).collect();
    let mut matched = vec![Vec::new(); sentences.len()];
    let mut gaps = Vec::new();
    let mut total = 0;
    let mut covered = 0;
    for requirement in requirements {
        let needle = words(requirement);
        if needle.is_empty() { continue; }
        total += 1;
        let mut found = false;
        for (i, text) in tokens.iter().enumerate() {
            if contains_words(text, &needle) {
                found = true;
                if matched[i].len() < 20 { matched[i].push(requirement.clone()); }
            }
        }
        if found { covered += 1; } else { gaps.push(requirement.clone()); }
    }
    let evidence = matched.into_iter().enumerate()
        .filter(|(_, matches)| !matches.is_empty())
        .take(20)
        .map(|(i, matches)| (sentences[i].to_string(), matches))
        .collect();
    MatchResult { coverage: if total == 0 { 0.0 } else { covered as f64 / total as f64 }, evidence, gaps }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_literal_sentences_and_word_boundaries() {
        let result = analyze("Il piano operativo è pronto. Abbiamo certificazioni ISO!", &[
            "piano operativo".into(), "ISO".into(), "piano economico".into(), "pia".into()]);
        assert_eq!(result.coverage, 0.5);
        assert_eq!(result.evidence[0].0, "Il piano operativo è pronto.");
        assert_eq!(result.gaps, ["piano economico", "pia"]);
    }
    #[test]
    fn empty_requirements_never_claim_coverage() {
        assert_eq!(analyze("test", &["  ".into()]).coverage, 0.0);
    }
}
