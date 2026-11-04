//! Decimali numerici degli open data: supporta formati italiani e internazionali.
pub fn parse(value: &str) -> Option<f64> {
    let text: String = value.chars().filter(|ch| !ch.is_whitespace()).collect();
    if text.is_empty() { return None; }
    let decimal = match (text.rfind(','), text.rfind('.')) {
        (Some(comma), Some(dot)) => if comma > dot { ',' } else { '.' },
        (Some(_), None) => ',',
        (None, Some(_)) => '.',
        (None, None) => '.',
    };
    let grouping = if decimal == ',' { '.' } else { ',' };
    let normalized = text.replace(grouping, "").replace(decimal, ".");
    normalized.parse::<f64>().ok().filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_from_italian_and_international_datasets() {
        assert_eq!(parse("1.234,56"), Some(1234.56));
        assert_eq!(parse("1,234.56"), Some(1234.56));
        assert_eq!(parse("12,5"), Some(12.5));
        assert_eq!(parse("542022.99"), Some(542022.99));
        assert_eq!(parse(" 1\u{a0}234,50 "), Some(1234.5));
        assert_eq!(parse("NaN"), None);
        assert_eq!(parse("non noto"), None);
    }
}
