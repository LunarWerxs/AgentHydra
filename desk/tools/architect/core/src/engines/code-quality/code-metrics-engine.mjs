/**
 * code-metrics-engine — codebase-agnostic function metrics
 * =========================================================
 * Lightweight, regex-driven complexity calculator inspired by:
 *   - lizard (terryyin/lizard): "how complex the code looks" rather than full AST
 *   - radon (rubik/radon): Halstead + Maintainability Index formulas
 *   - SonarSource Cognitive Complexity white paper: nesting penalty model
 *
 * No language frontend required — works on any brace-delimited language file
 * (JS/TS/JSX/TSX, Java, C/C++, C#, Go, Rust, Swift, Kotlin, Scala, PHP) and
 * has a best-effort indent-based fallback for Python.
 *
 * Returns per-function metrics:
 *   - name, startLine, endLine, nloc, paramCount, tokenCount
 *   - cyclomaticComplexity (CC)
 *   - cognitiveComplexity
 *   - halstead: { n1, n2, N1, N2, vocabulary, length, volume, difficulty, effort, bugs }
 * Plus a file-level Maintainability Index (radon SEI variant).
 */

const FUNC_PATTERNS = [
  // JS/TS function declarations: `function NAME(...)`
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g,
  // JS/TS arrow with name: `const NAME = (...) =>` or `const NAME = async (...) =>`
  /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g,
  // Class/object methods: `NAME(...) {` (avoid keywords)
  /(?:^|\s|;|,|\}|\))([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g,
  // Python: `def NAME(...):`
  /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:->[^:]+)?:/g,
  // Go/Rust style: `fn NAME(...)` or `func NAME(...)`
  /(?:^|\s)(?:fn|func)\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)/g,
];

const RESERVED_NOT_FUNCTION = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "catch",
  "do",
  "return",
  "typeof",
  "new",
  "delete",
  "throw",
  "void",
  "await",
  "yield",
  "in",
  "of",
  "instanceof",
  "with",
  "import",
  "export",
  "default",
  "from",
  "as",
  "function",
  "class",
  "const",
  "let",
  "var",
  "this",
  "super",
]);

const HALSTEAD_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "&&",
  "||",
  "!",
  "??",
  "?.",
  "&",
  "|",
  "^",
  "~",
  "<<",
  ">>",
  ">>>",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ";",
  ":",
  "?",
  "=>",
  "...",
  ".",
]);

const KEYWORDS_AS_OPERATORS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "function",
  "var",
  "let",
  "const",
  "class",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "try",
  "catch",
  "finally",
  "throw",
  "import",
  "export",
  "from",
  "as",
  "default",
  "void",
  "await",
  "async",
  "yield",
  "def",
  "fn",
  "func",
  "elif",
  "lambda",
  "with",
]);

function lineAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function matchingBraceEnd(text, openIndex) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripCommentsAndStrings(text) {
  let out = "";
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
      inLineComment = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

const CC_TOKENS = [
  /\bif\b/g,
  /\belse\s+if\b/g,
  /\belif\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /&&/g,
  /\|\|/g,
  /\?\?/g,
  /\?(?!\.)/g,
];

export function cyclomaticComplexity(bodyText) {
  const clean = stripCommentsAndStrings(bodyText);
  let cc = 1;
  for (const re of CC_TOKENS) {
    re.lastIndex = 0;
    const matches = clean.match(re);
    if (matches) cc += matches.length;
  }
  return cc;
}

/**
 * SonarSource Cognitive Complexity:
 *   B1 (+1): if/else if/else, for, while, do, case (per case), catch, ternary, goto/break/continue label, recursion
 *   B2 (nesting penalty): each nested flow-breaking structure adds (nestingLevel) on top of its B1
 *   B3 (ignored): method decl itself (starts at 0), shorthand structures
 *   Boolean operators: each sequence of like operators counts +1 (mixed sequences split)
 */
export function cognitiveComplexity(bodyText) {
  const clean = stripCommentsAndStrings(bodyText);
  let score = 0;
  let depth = 0;
  let i = 0;
  let lastBoolean = null;
  while (i < clean.length) {
    const ch = clean[i];
    const next = clean[i + 1];
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      const op = ch + next;
      if (op !== lastBoolean) {
        score += 1;
        lastBoolean = op;
      }
      i += 2;
      continue;
    }
    lastBoolean = null;
    if (ch === "?" && next !== ".") {
      score += 1 + Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < clean.length && /[\w]/.test(clean[j])) j += 1;
      const word = clean.slice(i, j);
      if (
        word === "if" ||
        word === "for" ||
        word === "while" ||
        word === "case" ||
        word === "catch" ||
        word === "elif"
      ) {
        score += 1 + Math.max(0, depth - 1);
      } else if (word === "else") {
        score += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return score;
}

export function halstead(bodyText) {
  const clean = stripCommentsAndStrings(bodyText);
  const operatorCounts = new Map();
  const operandCounts = new Map();

  const tokenRe =
    /([A-Za-z_$][\w$]*)|(\d+\.?\d*)|("[^"]*"|'[^']*'|`[^`]*`)|(\*\*=|>>>=|>>=|<<=|===|!==|\*\*|=>|\.\.\.|&&|\|\||\?\?|\?\.|==|!=|<=|>=|<<|>>|>>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\+|-|\*|\/|%|=|<|>|!|&|\||\^|~|\(|\)|\[|\]|\{|\}|,|;|:|\?|\.)/g;
  let m;
  while ((m = tokenRe.exec(clean))) {
    const [, word, num, str, op] = m;
    if (word) {
      if (KEYWORDS_AS_OPERATORS.has(word)) {
        operatorCounts.set(word, (operatorCounts.get(word) ?? 0) + 1);
      } else {
        operandCounts.set(word, (operandCounts.get(word) ?? 0) + 1);
      }
    } else if (num) {
      operandCounts.set(num, (operandCounts.get(num) ?? 0) + 1);
    } else if (str) {
      operandCounts.set(str, (operandCounts.get(str) ?? 0) + 1);
    } else if (op && HALSTEAD_OPERATORS.has(op)) {
      operatorCounts.set(op, (operatorCounts.get(op) ?? 0) + 1);
    }
  }

  const n1 = operatorCounts.size;
  const n2 = operandCounts.size;
  let N1 = 0;
  let N2 = 0;
  for (const v of operatorCounts.values()) N1 += v;
  for (const v of operandCounts.values()) N2 += v;
  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  const effort = difficulty * volume;
  const bugs = volume / 3000;
  return { n1, n2, N1, N2, vocabulary, length, volume, difficulty, effort, bugs };
}

function countNloc(bodyText) {
  let count = 0;
  let inBlock = false;
  for (const raw of bodyText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) continue;
    count += 1;
  }
  return count;
}

function countTokens(bodyText) {
  const clean = stripCommentsAndStrings(bodyText);
  const matches = clean.match(/([A-Za-z_$][\w$]*)|\d+\.?\d*|"[^"]*"|'[^']*'|`[^`]*`|[+\-*/%=<>!&|^~?:,.;(){}[\]]/g);
  return matches ? matches.length : 0;
}

function countParams(paramText) {
  if (!paramText || !paramText.trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of paramText) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

function extractPythonBlock(text, headerEndIndex) {
  const headerLineStart = text.lastIndexOf("\n", headerEndIndex) + 1;
  const headerLine = text.slice(headerLineStart, text.indexOf("\n", headerEndIndex));
  const headerIndent = headerLine.match(/^(\s*)/)[1].length;
  let i = text.indexOf("\n", headerEndIndex);
  if (i < 0) return { start: headerEndIndex, end: text.length };
  i += 1;
  let end = i;
  while (i < text.length) {
    const lineEnd = text.indexOf("\n", i);
    const lineStop = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(i, lineStop);
    if (line.trim()) {
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= headerIndent) break;
      end = lineStop;
    }
    if (lineEnd < 0) break;
    i = lineEnd + 1;
  }
  return { start: headerEndIndex, end };
}

export function extractFunctions(text, { language: _language = "auto" } = {}) {
  const seen = new Set();
  const functions = [];
  for (const pattern of FUNC_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      const name = m[1];
      if (!name || RESERVED_NOT_FUNCTION.has(name)) continue;
      const headerEnd = m.index + m[0].length;
      const isPython = /\bdef\s/.test(m[0]);
      let bodyStart;
      let bodyEnd;
      if (isPython) {
        const block = extractPythonBlock(text, headerEnd);
        bodyStart = block.start;
        bodyEnd = block.end;
      } else {
        const openBrace = text.indexOf("{", headerEnd);
        if (openBrace < 0 || openBrace - headerEnd > 200) continue;
        const close = matchingBraceEnd(text, openBrace);
        if (close < 0) continue;
        bodyStart = openBrace;
        bodyEnd = close + 1;
      }
      const key = `${name}@${bodyStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = text.slice(bodyStart, bodyEnd);
      const startLine = lineAtOffset(text, m.index);
      const endLine = lineAtOffset(text, bodyEnd);
      const params = m[2] ?? "";
      functions.push({
        name,
        startLine,
        endLine,
        nloc: countNloc(body),
        paramCount: countParams(params),
        tokenCount: countTokens(body),
        cyclomaticComplexity: cyclomaticComplexity(body),
        cognitiveComplexity: cognitiveComplexity(body),
        halstead: halstead(body),
      });
    }
  }
  functions.sort((a, b) => a.startLine - b.startLine);
  return functions;
}

/**
 * Maintainability Index — radon's SEI variant (capped 0..100):
 *   MI = max(0, 100 * (171 - 5.2 ln(V) - 0.23 G - 16.2 ln(L) + 50 sin(sqrt(2.4 C))) / 171)
 * where V = Halstead volume, G = total cyclomatic complexity, L = SLOC, C = comment ratio.
 *
 * Microsoft Visual Studio thresholds (commonly cited):
 *   >= 20 maintainable, 10..19 moderate, < 10 difficult.
 */
export function fileMaintainabilityIndex(text) {
  const lines = text.split(/\r?\n/);
  let sloc = 0;
  let comments = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      comments += 1;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      comments += 1;
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) {
      comments += 1;
      continue;
    }
    sloc += 1;
  }
  const totalCC = Math.max(
    1,
    extractFunctions(text).reduce((acc, fn) => acc + fn.cyclomaticComplexity, 0),
  );
  const fileHalstead = halstead(text);
  const V = Math.max(1, fileHalstead.volume);
  const L = Math.max(1, sloc);
  const totalLines = sloc + comments;
  const commentRatio = totalLines > 0 ? comments / totalLines : 0;
  const C = Math.sqrt(2.4 * commentRatio);
  const raw = 171 - 5.2 * Math.log(V) - 0.23 * totalCC - 16.2 * Math.log(L) + 50 * Math.sin(C);
  return Math.max(0, Math.min(100, (raw * 100) / 171));
}
