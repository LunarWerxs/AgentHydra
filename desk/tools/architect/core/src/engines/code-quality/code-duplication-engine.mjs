/**
 * clone-detection-engine — token-based copy/paste detector
 * ========================================================
 * Port of jscpd's approach (kucherenko/jscpd): tokenize source, slide a window
 * of N tokens, hash each window (Rabin–Karp style polynomial rolling hash), and
 * report windows whose hash appears in multiple distinct file:line locations.
 *
 * "Tokens" here are identifier-or-symbol atoms emitted by a tiny generic
 * tokenizer (no language frontend required). Comments and string contents are
 * dropped so prose drift doesn't create false negatives.
 *
 * Defaults: minTokens=50, minLines=5 (jscpd's defaults).
 *
 * NOTE: this is a true Rabin-Karp rolling hash (window roll is O(1) per
 * advance) for parity with jscpd, not a per-window rehash.
 */
const PRIME = 1000000007n;
const BASE = 257n;

function tokenize(text) {
  const tokens = [];
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") line += 1;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === "\n")) {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      tokens.push({ value: "STR", line });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      tokens.push({ value: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < text.length && /[\d.]/.test(text[j])) j += 1;
      tokens.push({ value: "NUM", line });
      i = j;
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (/^(?:\*\*=|>>>=|>>=|<<=|===|!==)$/.test(three)) {
      tokens.push({ value: three, line });
      i += 3;
      continue;
    }
    if (/^(?:\*\*|=>|\.\.|&&|\|\||\?\?|\?\.|==|!=|<=|>=|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)$/.test(two)) {
      tokens.push({ value: two, line });
      i += 2;
      continue;
    }
    tokens.push({ value: ch, line });
    i += 1;
  }
  return tokens;
}

function hashChar(value) {
  let h = 0n;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31n + BASE * BigInt(value.charCodeAt(i) || 0)) % PRIME;
  }
  return h === 0n ? 1n : h;
}

/**
 * Detect clones across multiple files using a true Rabin-Karp rolling hash.
 * @param {Array<{path:string,text:string}>} sources
 * @param {{minTokens?:number, minLines?:number, ignoreShortLines?:boolean}} options
 * @returns {Array<{tokens:number, instances:Array<{path:string,startLine:number,endLine:number}>}>}
 */
export function detectClones(sources, { minTokens = 50, minLines = 5 } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const buckets = new Map();
  const windowSize = Math.max(5, minTokens);

  for (const { path: filePath, text } of sources) {
    const tokens = tokenize(text);
    if (tokens.length < windowSize) continue;

    const tokenHashes = tokens.map((t) => hashChar(t.value));
    let highPower = 1n;
    for (let i = 0; i < windowSize - 1; i += 1) highPower = (highPower * BASE) % PRIME;

    let hash = 0n;
    for (let i = 0; i < windowSize; i += 1) {
      hash = (hash * BASE + tokenHashes[i]) % PRIME;
    }
    pushBucket(buckets, hash, filePath, tokens[0].line, tokens[windowSize - 1].line);

    for (let i = 1; i + windowSize <= tokens.length; i += 1) {
      const drop = (tokenHashes[i - 1] * highPower) % PRIME;
      hash = ((hash + PRIME - drop) * BASE + tokenHashes[i + windowSize - 1]) % PRIME;
      pushBucket(buckets, hash, filePath, tokens[i].line, tokens[i + windowSize - 1].line);
    }
  }

  const clones = [];
  for (const [, instances] of buckets) {
    if (instances.length < 2) continue;
    const uniqueLocs = new Set(instances.map((inst) => `${inst.path}:${inst.startLine}`));
    if (uniqueLocs.size < 2) continue;
    const longest = instances.reduce((acc, inst) => Math.max(acc, inst.endLine - inst.startLine + 1), 0);
    if (longest < minLines) continue;
    const seen = new Set();
    const unique = [];
    for (const inst of instances) {
      const key = `${inst.path}:${inst.startLine}-${inst.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(inst);
    }
    clones.push({ tokens: windowSize, instances: unique });
  }
  return mergeAdjacent(clones);
}

function pushBucket(buckets, hash, filePath, startLine, endLine) {
  const key = hash.toString();
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push({ path: filePath, startLine, endLine });
}

function mergeAdjacent(clones) {
  const collapsed = new Map();
  for (const clone of clones) {
    const key = clone.instances
      .map((i) => `${i.path}:${i.startLine}`)
      .sort()
      .join("|");
    const existing = collapsed.get(key);
    if (!existing || clone.tokens > existing.tokens) {
      collapsed.set(key, clone);
    }
  }
  return [...collapsed.values()].sort((a, b) => b.tokens - a.tokens);
}
