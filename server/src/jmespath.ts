// A JMESPath evaluator, written for AgentHydra's MCP output shaping (mcp-output.ts).
//
// WHY IT EXISTS. An MCP tool result lands whole in the calling agent's context, and a session list
// or a transcript can run to tens of thousands of tokens when the agent wanted one field of each
// row. A JMESPath expression passed with the call lets the agent take only what it needs, and the
// projection runs here, before a byte of the rest reaches the model.
//
// WHY IT IS WRITTEN HERE AND NOT A DEPENDENCY. The server keeps its runtime dependencies to three,
// and every one of them ships in the compiled exe. This covers the JMESPath grammar an agent
// actually writes (https://jmespath.org/specification.html): fields, sub-expressions, indexes,
// slices, list and object projections, flatten, filters, multiselect lists and hashes, pipes,
// comparisons, && / || / !, literals, and the common functions. It is a Pratt parser over the
// spec's own binding powers, so projections stop and continue exactly where the spec says.
//
// compile() throws JmesPathError on a bad expression, BEFORE any tool runs; search() throws it on a
// type error while evaluating (e.g. length(`5`)).

export class JmesPathError extends Error {}

/** One parsed node. Kept as a tagged union so the evaluator is a single switch. */
export type JmesNode =
  | { type: 'identity' }
  | { type: 'field'; name: string }
  | { type: 'literal'; value: unknown }
  | { type: 'subexpr'; left: JmesNode; right: JmesNode }
  | { type: 'index'; index: number }
  | { type: 'slice'; start: number | null; stop: number | null; step: number | null }
  | { type: 'indexExpr'; left: JmesNode; right: JmesNode }
  | { type: 'projection'; left: JmesNode; right: JmesNode }
  | { type: 'valueProjection'; left: JmesNode; right: JmesNode }
  | { type: 'filterProjection'; left: JmesNode; right: JmesNode; condition: JmesNode }
  | { type: 'flatten'; child: JmesNode }
  | { type: 'comparator'; op: string; left: JmesNode; right: JmesNode }
  | { type: 'or'; left: JmesNode; right: JmesNode }
  | { type: 'and'; left: JmesNode; right: JmesNode }
  | { type: 'not'; child: JmesNode }
  | { type: 'pipe'; left: JmesNode; right: JmesNode }
  | { type: 'multiList'; children: JmesNode[] }
  | { type: 'multiHash'; pairs: { key: string; value: JmesNode }[] }
  | { type: 'function'; name: string; args: JmesNode[] }
  | { type: 'expref'; child: JmesNode }

interface Token {
  type: string
  value?: unknown
  pos: number
}

// The spec's binding powers. A projection's right-hand side keeps consuming tokens whose power is
// at least PROJECTION_STOP; anything weaker (a pipe, a comparison) ends the projection.
const BP: Record<string, number> = {
  eof: 0,
  unquoted: 0,
  quoted: 0,
  literal: 0,
  rbracket: 0,
  rparen: 0,
  comma: 0,
  rbrace: 0,
  number: 0,
  current: 0,
  expref: 0,
  colon: 0,
  pipe: 1,
  or: 2,
  and: 3,
  eq: 5,
  ne: 5,
  gt: 5,
  gte: 5,
  lt: 5,
  lte: 5,
  flatten: 9,
  star: 20,
  filter: 21,
  dot: 40,
  not: 45,
  lbrace: 50,
  lbracket: 55,
  lparen: 60,
}
const PROJECTION_STOP = 10

const SIMPLE: Record<string, string> = {
  '.': 'dot',
  '*': 'star',
  ',': 'comma',
  ':': 'colon',
  '{': 'lbrace',
  '}': 'rbrace',
  ']': 'rbracket',
  '(': 'lparen',
  ')': 'rparen',
  '@': 'current',
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const fail = (msg: string): never => {
    throw new JmesPathError(`${msg} at position ${i}`)
  }
  while (i < expr.length) {
    const ch = expr[i] as string
    const pos = i
    if (/\s/.test(ch)) {
      i++
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j] as string)) j++
      tokens.push({ type: 'unquoted', value: expr.slice(i, j), pos })
      i = j
    } else if (SIMPLE[ch]) {
      tokens.push({ type: SIMPLE[ch] as string, pos })
      i++
    } else if (ch === '[') {
      const next = expr[i + 1]
      if (next === ']') {
        tokens.push({ type: 'flatten', pos })
        i += 2
      } else if (next === '?') {
        tokens.push({ type: 'filter', pos })
        i += 2
      } else {
        tokens.push({ type: 'lbracket', pos })
        i++
      }
    } else if (/[0-9-]/.test(ch)) {
      let j = i + 1
      while (j < expr.length && /[0-9]/.test(expr[j] as string)) j++
      const text = expr.slice(i, j)
      if (text === '-') fail('a "-" must start a number')
      tokens.push({ type: 'number', value: Number(text), pos })
      i = j
    } else if (ch === '"') {
      let j = i + 1
      while (j < expr.length && expr[j] !== '"') j += expr[j] === '\\' ? 2 : 1
      if (j >= expr.length) fail('unterminated quoted identifier')
      try {
        tokens.push({ type: 'quoted', value: JSON.parse(expr.slice(i, j + 1)), pos })
      } catch {
        fail('bad quoted identifier')
      }
      i = j + 1
    } else if (ch === "'") {
      let j = i + 1
      let raw = ''
      while (j < expr.length && expr[j] !== "'") {
        if (expr[j] === '\\' && (expr[j + 1] === "'" || expr[j + 1] === '\\')) {
          raw += expr[j + 1]
          j += 2
        } else {
          raw += expr[j]
          j++
        }
      }
      if (j >= expr.length) fail('unterminated raw string')
      tokens.push({ type: 'literal', value: raw, pos })
      i = j + 1
    } else if (ch === '`') {
      let j = i + 1
      while (j < expr.length && expr[j] !== '`') j += expr[j] === '\\' ? 2 : 1
      if (j >= expr.length) fail('unterminated literal')
      const body = expr.slice(i + 1, j).replace(/\\`/g, '`')
      try {
        tokens.push({ type: 'literal', value: JSON.parse(body), pos })
      } catch {
        fail('a `literal` must be JSON')
      }
      i = j + 1
    } else if (ch === '|') {
      tokens.push(expr[i + 1] === '|' ? { type: 'or', pos } : { type: 'pipe', pos })
      i += expr[i + 1] === '|' ? 2 : 1
    } else if (ch === '&') {
      tokens.push(expr[i + 1] === '&' ? { type: 'and', pos } : { type: 'expref', pos })
      i += expr[i + 1] === '&' ? 2 : 1
    } else if (ch === '!') {
      tokens.push(expr[i + 1] === '=' ? { type: 'ne', pos } : { type: 'not', pos })
      i += expr[i + 1] === '=' ? 2 : 1
    } else if (ch === '=') {
      if (expr[i + 1] !== '=') fail('"=" is not an operator (use "==")')
      tokens.push({ type: 'eq', pos })
      i += 2
    } else if (ch === '<' || ch === '>') {
      const orEqual = expr[i + 1] === '='
      tokens.push({ type: `${ch === '<' ? 'lt' : 'gt'}${orEqual ? 'e' : ''}`, pos })
      i += orEqual ? 2 : 1
    } else {
      fail(`unexpected character ${JSON.stringify(ch)}`)
    }
  }
  tokens.push({ type: 'eof', pos: expr.length })
  return tokens
}

const IDENTITY: JmesNode = { type: 'identity' }

class Parser {
  private at = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): JmesNode {
    const node = this.expression(0)
    if (this.peek().type !== 'eof') this.unexpected()
    return node
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.at + ahead, this.tokens.length - 1)] as Token
  }

  private advance(): Token {
    const t = this.peek()
    this.at++
    return t
  }

  private expect(type: string): Token {
    const t = this.peek()
    if (t.type !== type) this.unexpected(`expected ${type}`)
    return this.advance()
  }

  private unexpected(want?: string): never {
    const t = this.peek()
    throw new JmesPathError(
      `${want ? `${want}, found` : 'unexpected'} ${t.type === 'eof' ? 'end of expression' : `"${t.type}"`} at position ${t.pos}`,
    )
  }

  private expression(bp: number): JmesNode {
    let left = this.nud(this.advance())
    while (bp < (BP[this.peek().type] ?? 0)) left = this.led(this.advance(), left)
    return left
  }

  private nud(t: Token): JmesNode {
    switch (t.type) {
      case 'literal':
        return { type: 'literal', value: t.value }
      case 'unquoted':
      case 'quoted':
        return { type: 'field', name: String(t.value) }
      case 'current':
        return IDENTITY
      case 'star':
        return {
          type: 'valueProjection',
          left: IDENTITY,
          right: this.peek().type === 'rbracket' ? IDENTITY : this.projectionRhs(BP.star as number),
        }
      case 'not':
        return { type: 'not', child: this.expression(BP.not as number) }
      case 'expref':
        return { type: 'expref', child: this.expression(BP.expref as number) }
      case 'lparen': {
        const inner = this.expression(0)
        this.expect('rparen')
        return inner
      }
      case 'filter':
        return this.filterRest(IDENTITY)
      case 'flatten': {
        const left: JmesNode = { type: 'flatten', child: IDENTITY }
        return { type: 'projection', left, right: this.projectionRhs(BP.flatten as number) }
      }
      case 'lbrace':
        return this.multiHash()
      case 'lbracket': {
        const next = this.peek().type
        if (next === 'number' || next === 'colon') return this.indexOrSlice(IDENTITY)
        if (next === 'star' && this.peek(1).type === 'rbracket') {
          this.advance()
          this.advance()
          return {
            type: 'projection',
            left: IDENTITY,
            right: this.projectionRhs(BP.star as number),
          }
        }
        return this.multiList()
      }
      default:
        this.at--
        return this.unexpected()
    }
  }

  private led(t: Token, left: JmesNode): JmesNode {
    switch (t.type) {
      case 'dot':
        if (this.peek().type === 'star') {
          this.advance()
          return { type: 'valueProjection', left, right: this.projectionRhs(BP.dot as number) }
        }
        return { type: 'subexpr', left, right: this.dotRhs(BP.dot as number) }
      case 'pipe':
        return { type: 'pipe', left, right: this.expression(BP.pipe as number) }
      case 'or':
        return { type: 'or', left, right: this.expression(BP.or as number) }
      case 'and':
        return { type: 'and', left, right: this.expression(BP.and as number) }
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        return {
          type: 'comparator',
          op: t.type,
          left,
          right: this.expression(BP[t.type] as number),
        }
      case 'lparen': {
        if (left.type !== 'field') throw new JmesPathError(`only a name can be called, at ${t.pos}`)
        const args: JmesNode[] = []
        while (this.peek().type !== 'rparen') {
          args.push(this.expression(0))
          if (this.peek().type === 'comma') this.advance()
          else if (this.peek().type !== 'rparen') this.unexpected('expected , or )')
        }
        this.advance()
        return { type: 'function', name: left.name, args }
      }
      case 'filter':
        return this.filterRest(left)
      case 'flatten':
        return {
          type: 'projection',
          left: { type: 'flatten', child: left },
          right: this.projectionRhs(BP.flatten as number),
        }
      case 'lbracket': {
        const next = this.peek().type
        if (next === 'number' || next === 'colon') return this.indexOrSlice(left)
        this.expect('star')
        this.expect('rbracket')
        return { type: 'projection', left, right: this.projectionRhs(BP.star as number) }
      }
      default:
        this.at--
        return this.unexpected()
    }
  }

  private filterRest(left: JmesNode): JmesNode {
    const condition = this.expression(0)
    this.expect('rbracket')
    const right =
      this.peek().type === 'flatten' ? IDENTITY : this.projectionRhs(BP.filter as number)
    return { type: 'filterProjection', left, right, condition }
  }

  private projectionRhs(bp: number): JmesNode {
    const next = this.peek().type
    if ((BP[next] ?? 0) < PROJECTION_STOP) return IDENTITY
    if (next === 'lbracket' || next === 'filter') return this.expression(bp)
    if (next === 'dot') {
      this.advance()
      return this.dotRhs(bp)
    }
    return this.unexpected()
  }

  private dotRhs(bp: number): JmesNode {
    const next = this.peek().type
    if (next === 'unquoted' || next === 'quoted' || next === 'star') return this.expression(bp)
    if (next === 'lbracket') {
      this.advance()
      return this.multiList()
    }
    if (next === 'lbrace') {
      this.advance()
      return this.multiHash()
    }
    return this.unexpected('expected a name, *, [ or { after "."')
  }

  private indexOrSlice(left: JmesNode): JmesNode {
    const parts: (number | null)[] = [null, null, null]
    let part = 0
    let sawColon = false
    while (this.peek().type !== 'rbracket') {
      const t = this.advance()
      if (t.type === 'colon') {
        sawColon = true
        part++
        if (part > 2) throw new JmesPathError(`a slice takes at most three parts, at ${t.pos}`)
      } else if (t.type === 'number') {
        parts[part] = t.value as number
      } else {
        this.at--
        this.unexpected()
      }
    }
    this.advance()
    if (!sawColon) {
      return { type: 'indexExpr', left, right: { type: 'index', index: parts[0] as number } }
    }
    if (parts[2] === 0) throw new JmesPathError('a slice step cannot be 0')
    const slice: JmesNode = {
      type: 'slice',
      start: parts[0] ?? null,
      stop: parts[1] ?? null,
      step: parts[2] ?? null,
    }
    return {
      type: 'projection',
      left: { type: 'indexExpr', left, right: slice },
      right: this.projectionRhs(BP.star as number),
    }
  }

  private multiList(): JmesNode {
    const children: JmesNode[] = []
    while (true) {
      children.push(this.expression(0))
      if (this.peek().type === 'comma') this.advance()
      else break
    }
    this.expect('rbracket')
    return { type: 'multiList', children }
  }

  private multiHash(): JmesNode {
    const pairs: { key: string; value: JmesNode }[] = []
    while (true) {
      const key = this.advance()
      if (key.type !== 'unquoted' && key.type !== 'quoted') {
        this.at--
        this.unexpected('expected a key name')
      }
      this.expect('colon')
      pairs.push({ key: String(key.value), value: this.expression(0) })
      if (this.peek().type === 'comma') this.advance()
      else break
    }
    this.expect('rbrace')
    return { type: 'multiHash', pairs }
  }
}

/** Parse an expression. Throws JmesPathError naming the position of the first thing it could not
 *  read, so a caller can refuse the call before anything runs. */
export function compile(expression: string): JmesNode {
  return new Parser(tokenize(expression)).parse()
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The spec's truthiness: null, false, '', [] and {} are false; everything else is true. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isObject(v)) return Object.keys(v).length > 0
  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (isObject(v)) return 'object'
  if (typeof v === 'object' && (v as { type?: string }).type === 'expref') return 'expref'
  return typeof v
}

function sliceOf(list: unknown[], start: number | null, stop: number | null, step: number | null) {
  const s = step ?? 1
  const len = list.length
  const clamp = (v: number | null, dflt: number): number => {
    if (v === null) return dflt
    if (v < 0) return Math.max(v + len, s < 0 ? -1 : 0)
    return Math.min(v, s < 0 ? len - 1 : len)
  }
  const from = clamp(start, s < 0 ? len - 1 : 0)
  const to = clamp(stop, s < 0 ? -1 : len)
  const out: unknown[] = []
  if (s > 0) for (let i = from; i < to; i += s) out.push(list[i])
  else for (let i = from; i > to; i += s) out.push(list[i])
  return out
}

type Fn = (args: unknown[], exprefs: (JmesNode | null)[]) => unknown

/** `v`, typed as `T`, once it is one of `types`; otherwise the spec's invalid-type error. */
function need<T>(name: string, v: unknown, ...types: string[]): T {
  if (!types.includes(typeOf(v)))
    throw new JmesPathError(`${name}() expected ${types.join(' or ')}, got ${typeOf(v)}`)
  return v as T
}

function byKey(
  name: string,
  list: unknown,
  node: JmesNode | null,
): { item: unknown; key: unknown }[] {
  need(name, list, 'array')
  if (!node) throw new JmesPathError(`${name}() needs an &expression as its second argument`)
  return (list as unknown[]).map((item) => ({ item, key: evaluate(node, item) }))
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  throw new JmesPathError('can only order numbers against numbers and strings against strings')
}

const FUNCTIONS: Record<string, Fn> = {
  length: ([v]) => {
    need('length', v, 'string', 'array', 'object')
    return typeof v === 'string'
      ? [...v].length
      : Array.isArray(v)
        ? v.length
        : Object.keys(v as object).length
  },
  keys: ([v]) => Object.keys(need<object>('keys', v, 'object')),
  values: ([v]) => Object.values(need<object>('values', v, 'object')),
  type: ([v]) => typeOf(v),
  not_null: (args) => args.find((v) => v !== null && v !== undefined) ?? null,
  contains: ([hay, needle]) => {
    need('contains', hay, 'string', 'array')
    if (typeof hay === 'string') return typeof needle === 'string' && hay.includes(needle)
    return (hay as unknown[]).some((x) => deepEqual(x, needle))
  },
  starts_with: ([s, p]) => need<string>('starts_with', s, 'string').startsWith(String(p)),
  ends_with: ([s, p]) => need<string>('ends_with', s, 'string').endsWith(String(p)),
  join: ([sep, list]) => {
    need('join', list, 'array')
    return (list as unknown[]).map(String).join(String(sep))
  },
  reverse: ([v]) => {
    need('reverse', v, 'string', 'array')
    return typeof v === 'string' ? [...v].reverse().join('') : [...(v as unknown[])].reverse()
  },
  sort: ([v]) => [...need<unknown[]>('sort', v, 'array')].sort(compareKeys),
  sort_by: ([list], [, node]) =>
    byKey('sort_by', list, node ?? null)
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((p) => p.item),
  max_by: ([list], [, node]) =>
    byKey('max_by', list, node ?? null).reduce<{ item: unknown; key: unknown } | null>(
      (best, p) => (best === null || compareKeys(p.key, best.key) > 0 ? p : best),
      null,
    )?.item ?? null,
  min_by: ([list], [, node]) =>
    byKey('min_by', list, node ?? null).reduce<{ item: unknown; key: unknown } | null>(
      (best, p) => (best === null || compareKeys(p.key, best.key) < 0 ? p : best),
      null,
    )?.item ?? null,
  map: ([, list], [node]) => {
    need('map', list, 'array')
    if (!node) throw new JmesPathError('map() needs an &expression as its first argument')
    return (list as unknown[]).map((item) => evaluate(node, item))
  },
  max: ([v]) => {
    need('max', v, 'array')
    const list = v as unknown[]
    return list.length ? list.reduce((a, b) => (compareKeys(b, a) > 0 ? b : a)) : null
  },
  min: ([v]) => {
    need('min', v, 'array')
    const list = v as unknown[]
    return list.length ? list.reduce((a, b) => (compareKeys(b, a) < 0 ? b : a)) : null
  },
  sum: ([v]) => {
    need('sum', v, 'array')
    return (v as unknown[]).reduce<number>((acc, x) => {
      if (typeof x !== 'number') throw new JmesPathError('sum() takes an array of numbers')
      return acc + x
    }, 0)
  },
  avg: ([v]) => {
    need('avg', v, 'array')
    const list = v as unknown[]
    const total = (FUNCTIONS.sum as Fn)([v], []) as number
    return list.length ? total / list.length : null
  },
  to_string: ([v]) => (typeof v === 'string' ? v : JSON.stringify(v)),
  to_number: ([v]) => {
    if (typeof v === 'number') return v
    const n = typeof v === 'string' ? Number(v) : Number.NaN
    return Number.isFinite(n) ? n : null
  },
}

function project(list: unknown[], right: JmesNode): unknown[] {
  const out: unknown[] = []
  for (const item of list) {
    const v = evaluate(right, item)
    if (v !== null && v !== undefined) out.push(v)
  }
  return out
}

function evaluate(node: JmesNode, value: unknown): unknown {
  switch (node.type) {
    case 'identity':
      return value ?? null
    case 'field':
      return isObject(value) ? (value[node.name] ?? null) : null
    case 'literal':
      return node.value
    case 'subexpr':
    case 'indexExpr':
    case 'pipe':
      return evaluate(node.right, evaluate(node.left, value))
    case 'index': {
      if (!Array.isArray(value)) return null
      const i = node.index < 0 ? value.length + node.index : node.index
      return value[i] ?? null
    }
    case 'slice':
      return Array.isArray(value) ? sliceOf(value, node.start, node.stop, node.step) : null
    case 'projection': {
      const base = evaluate(node.left, value)
      return Array.isArray(base) ? project(base, node.right) : null
    }
    case 'valueProjection': {
      const base = evaluate(node.left, value)
      return isObject(base) ? project(Object.values(base), node.right) : null
    }
    case 'filterProjection': {
      const base = evaluate(node.left, value)
      if (!Array.isArray(base)) return null
      return project(
        base.filter((item) => truthy(evaluate(node.condition, item))),
        node.right,
      )
    }
    case 'flatten': {
      const base = evaluate(node.child, value)
      if (!Array.isArray(base)) return null
      return base.flatMap((x) => (Array.isArray(x) ? x : [x]))
    }
    case 'comparator': {
      const l = evaluate(node.left, value)
      const r = evaluate(node.right, value)
      if (node.op === 'eq') return deepEqual(l, r)
      if (node.op === 'ne') return !deepEqual(l, r)
      if (typeof l !== 'number' || typeof r !== 'number') return null
      if (node.op === 'lt') return l < r
      if (node.op === 'lte') return l <= r
      if (node.op === 'gt') return l > r
      return l >= r
    }
    case 'or': {
      const l = evaluate(node.left, value)
      return truthy(l) ? l : evaluate(node.right, value)
    }
    case 'and': {
      const l = evaluate(node.left, value)
      return truthy(l) ? evaluate(node.right, value) : l
    }
    case 'not':
      return !truthy(evaluate(node.child, value))
    case 'multiList':
      return value == null ? null : node.children.map((c) => evaluate(c, value))
    case 'multiHash':
      return value == null
        ? null
        : Object.fromEntries(node.pairs.map((p) => [p.key, evaluate(p.value, value)]))
    case 'expref':
      return node
    case 'function': {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new JmesPathError(`unknown function ${node.name}()`)
      const exprefs = node.args.map((a) => (a.type === 'expref' ? a.child : null))
      const args = node.args.map((a) => (a.type === 'expref' ? a : evaluate(a, value)))
      return fn(args, exprefs)
    }
  }
}

/** Evaluate a compiled expression against a JSON value. Missing fields answer null, as the spec
 *  says; a function handed the wrong type throws JmesPathError. */
export function search(node: JmesNode, value: unknown): unknown {
  return evaluate(node, value)
}
