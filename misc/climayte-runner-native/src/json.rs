//! JSON as JavaScript's `JSON.parse` and `JSON.stringify` see it, with key order and number text
//! kept.
//!
//! The runner reads the daemon's spec, checks that the signal file is whole JSON, reads `agent_id`
//! from a hook's input, and rewrites the worker's settings file. That last one is why order and
//! number text matter: the daemon wrote the settings with `JSON.stringify`, and a rewrite must
//! change the one hook it means to change and leave every other byte as the daemon wrote it.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number's own text, written back unchanged.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    /// In insertion order, as `JSON.parse` builds an object: a repeated key keeps its first place
    /// and its last value.
    Obj(Vec<(String, Json)>),
}

/// Deeper than this is refused rather than risk the stack. Hook inputs and settings files are a
/// handful of levels deep.
const MAX_DEPTH: u32 = 1000;

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
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
            Json::Num(n) => n.parse().ok(),
            _ => None,
        }
    }

    /// Sets `key` in its place when the object has it, else at the end: what `obj.key = value`
    /// does in JavaScript. False when this is not an object.
    pub fn set(&mut self, key: &str, value: Json) -> bool {
        let Json::Obj(m) = self else { return false };
        match m.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => m.push((key.to_string(), value)),
        }
        true
    }

    pub fn num(n: impl std::fmt::Display) -> Json {
        Json::Num(n.to_string())
    }

    pub fn str(s: impl Into<String>) -> Json {
        Json::Str(s.into())
    }

    pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
        Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
}

/// The whole text as one JSON value, surrounding whitespace allowed; None for anything
/// `JSON.parse` would throw on.
pub fn parse(src: &str) -> Option<Json> {
    let mut p = Parser {
        s: src.as_bytes(),
        i: 0,
        depth: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    (p.i == p.s.len()).then_some(v)
}

/// `JSON.stringify`'s compact form.
pub fn to_string(v: &Json) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => out.push_str(n),
        Json::Str(s) => write_str(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Json::Obj(pairs) => {
            out.push('{');
            for (i, (k, item)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(k, out);
                out.push(':');
                write(item, out);
            }
            out.push('}');
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: u32,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    /// The four whitespace characters JSON allows, and no others.
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn literal(&mut self, word: &str, v: Json) -> Option<Json> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn value(&mut self) -> Option<Json> {
        match self.peek()? {
            b'n' => self.literal("null", Json::Null),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => self.nested(Self::array),
            b'{' => self.nested(Self::object),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn nested(&mut self, f: fn(&mut Self) -> Option<Json>) -> Option<Json> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        let v = f(self);
        self.depth -= 1;
        v
    }

    fn array(&mut self) -> Option<Json> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self) -> Option<Json> {
        self.i += 1;
        let mut pairs: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Some(Json::Obj(pairs));
        }
        loop {
            self.ws();
            if self.peek()? != b'"' {
                return None;
            }
            let key = self.string()?;
            self.ws();
            if self.peek()? != b':' {
                return None;
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            match pairs.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = v,
                None => pairs.push((key, v)),
            }
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(Json::Obj(pairs));
                }
                _ => return None,
            }
        }
    }

    fn digits(&mut self) -> bool {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i > start
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek()? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if !self.digits() {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.digits() {
                return None;
            }
        }
        // Every byte of a number is ASCII, so this slice is whole UTF-8.
        Some(Json::Num(
            std::str::from_utf8(&self.s[start..self.i])
                .ok()?
                .to_string(),
        ))
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = self.s.get(self.i..self.i + 4)?;
        if !h.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            // A run of plain text: it stops only at ASCII bytes, so the slice is whole UTF-8.
            let start = self.i;
            while let Some(c) = self.peek() {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).ok()?);
            match self.peek()? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek()?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.escaped_char()?),
                        _ => return None,
                    }
                }
                // A raw control character, which JSON does not allow inside a string.
                _ => return None,
            }
        }
    }

    /// The character after `\u`, joining a surrogate pair. A lone surrogate has no Rust `char`;
    /// it becomes U+FFFD.
    fn escaped_char(&mut self) -> Option<char> {
        let u = self.hex4()?;
        if (0xD800..0xDC00).contains(&u) && self.s[self.i..].starts_with(b"\\u") {
            let back = self.i;
            self.i += 2;
            let lo = self.hex4()?;
            if (0xDC00..0xE000).contains(&lo) {
                return char::from_u32(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00));
            }
            self.i = back;
        }
        Some(char::from_u32(u).unwrap_or('\u{FFFD}'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settings_file_round_trips_byte_for_byte() {
        let text = r#"{"deniedMcpServers":[{"serverUrl":"*://*/api/mcp*"}],"hooks":{"PreToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"python","args":["-S","-c","import os;p='C:\\x'"],"timeout":10}]}],"PostToolUse":[]},"n":-1.5e3,"t":true,"z":null,"u":"é ☃ \ud83d\ude00 \u001f"}"#;
        let v = parse(text).unwrap();
        assert_eq!(to_string(&v), text.replace("\\ud83d\\ude00", "😀"));
    }

    #[test]
    fn set_keeps_a_key_in_its_place_and_appends_a_new_one() {
        let mut v = parse(r#"{"a":1,"hooks":{},"b":2}"#).unwrap();
        v.set("hooks", Json::num(3));
        v.set("c", Json::Null);
        assert_eq!(to_string(&v), r#"{"a":1,"hooks":3,"b":2,"c":null}"#);
    }

    #[test]
    fn a_repeated_key_keeps_its_first_place_and_last_value() {
        assert_eq!(
            to_string(&parse(r#"{"a":1,"b":2,"a":3}"#).unwrap()),
            r#"{"a":3,"b":2}"#
        );
    }

    #[test]
    fn what_json_parse_refuses_is_refused() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "[1,]",
            "01",
            "1.",
            ".5",
            "+1",
            "\u{feff}{}",
            "{'a':1}",
            "\"a\nb\"",
            "\"\\x\"",
            "\"\\u12g4\"",
            "\"\\u+123\"",
            "nul",
            "{} x",
            "NaN",
        ] {
            assert!(parse(bad).is_none(), "{bad:?} parsed");
        }
        assert!(parse(" \t\r\n{} \n").is_some());
    }

    #[test]
    fn nesting_past_the_limit_is_refused_not_a_crash() {
        let deep = "[".repeat(5000) + &"]".repeat(5000);
        assert!(parse(&deep).is_none());
        let ok = "[".repeat(100) + &"]".repeat(100);
        assert!(parse(&ok).is_some());
    }
}
