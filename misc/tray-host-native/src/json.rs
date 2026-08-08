//! A small, complete JSON reader.
//!
//! The first version of this host scanned for `"key": "value"` with `str::find`, which is fine
//! until a value legitimately contains a quote. The daemon start command always does, because the
//! interpreter path has to be quoted:
//!
//! ```text
//! "startCommand": "\"C:\\...\\bun.exe\" server/src/index.ts"
//! ```
//!
//! The scanner returned an empty string there, cmd.exe started happily and ran nothing, and the
//! host sat waiting for a daemon that was never going to exist. Parsing properly is ~150 lines and
//! removes the whole class, while still costing no dependency.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(m) => m.get(key),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }
    /// Truthiness the way the PowerShell host treated these flags: a missing key, `null` and
    /// `false` are all off, and so is `0`. Anything else is on.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Num(n) => *n != 0.0,
            Json::Str(s) => !s.is_empty() && s != "0" && !s.eq_ignore_ascii_case("false"),
            _ => true,
        }
    }
    pub fn str_at(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Json::as_str)
    }
    pub fn num_at(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(Json::as_f64)
    }
    pub fn flag_at(&self, key: &str) -> bool {
        self.get(key).map(Json::truthy).unwrap_or(false)
    }
}

pub fn parse(src: &str) -> Option<Json> {
    let bytes: Vec<char> = src.chars().collect();
    let mut p = Parser { s: &bytes, i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    Some(v)
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }
    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.i += 1;
        }
        c
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.i += 1;
        }
    }
    fn lit(&mut self, word: &str) -> bool {
        if self.s[self.i..].starts_with(&word.chars().collect::<Vec<_>>()[..]) {
            self.i += word.chars().count();
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> Option<Json> {
        self.ws();
        match self.peek()? {
            '{' => self.object(),
            '[' => self.array(),
            '"' => self.string().map(Json::Str),
            't' => self.lit("true").then_some(Json::Bool(true)),
            'f' => self.lit("false").then_some(Json::Bool(false)),
            'n' => self.lit("null").then_some(Json::Null),
            _ => self.number(),
        }
    }

    fn object(&mut self) -> Option<Json> {
        self.next()?; // '{'
        let mut map = BTreeMap::new();
        self.ws();
        if self.peek() == Some('}') {
            self.next();
            return Some(Json::Obj(map));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.ws();
            if self.next()? != ':' {
                return None;
            }
            let v = self.value()?;
            map.insert(k, v);
            self.ws();
            match self.next()? {
                ',' => continue,
                '}' => return Some(Json::Obj(map)),
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<Json> {
        self.next()?; // '['
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(']') {
            self.next();
            return Some(Json::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.ws();
            match self.next()? {
                ',' => continue,
                ']' => return Some(Json::Arr(out)),
                _ => return None,
            }
        }
    }

    fn string(&mut self) -> Option<String> {
        if self.next()? != '"' {
            return None;
        }
        let mut out = String::new();
        loop {
            match self.next()? {
                '"' => return Some(out),
                '\\' => match self.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'u' => {
                        let mut code = 0u32;
                        for _ in 0..4 {
                            code = code * 16 + self.next()?.to_digit(16)?;
                        }
                        // Lone surrogates are kept as the replacement char rather than failing the
                        // whole parse: a config that carries one is still usable.
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    other => out.push(other),
                },
                c => out.push(c),
            }
        }
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        if self.peek() == Some('-') {
            self.i += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
        {
            self.i += 1;
        }
        let text: String = self.s[start..self.i].iter().collect();
        text.parse::<f64>().ok().map(Json::Num)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_value_that_starts_with_an_escaped_quote() {
        // The exact shape that defeated the hand-rolled scanner.
        let src = r#"{"startCommand": "\"C:\\bun.exe\" server/src/index.ts", "port": 7787}"#;
        let v = parse(src).expect("parses");
        assert_eq!(
            v.str_at("startCommand"),
            Some(r#""C:\bun.exe" server/src/index.ts"#)
        );
        assert_eq!(v.num_at("port"), Some(7787.0));
    }

    #[test]
    fn reads_nested_objects_and_flags() {
        let src = r#"{"portableWindowSize":{"width":1060,"height":800},"hint":true,"off":false}"#;
        let v = parse(src).unwrap();
        let size = v.get("portableWindowSize").unwrap();
        assert_eq!(size.num_at("width"), Some(1060.0));
        assert_eq!(size.num_at("height"), Some(800.0));
        assert!(v.flag_at("hint"));
        assert!(!v.flag_at("off"));
        assert!(!v.flag_at("missing"));
    }

    #[test]
    fn rejects_garbage_instead_of_guessing() {
        assert!(parse("{oops}").is_none());
        assert!(parse("{\"a\":").is_none());
    }

    #[test]
    fn handles_unicode_escapes() {
        let v = parse(r#"{"name":"R\u0113Design"}"#).unwrap();
        assert_eq!(v.str_at("name"), Some("RēDesign"));
    }
}
