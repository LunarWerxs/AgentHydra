// Port of the page snapshot in Connections' local browser engine (services/studio/local-mcp/browser.mjs).
// Models read this text and cite refs from it, so the output must stay byte-identical to that engine.

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<any>

export interface SelectorItem {
  role: string
  name: string
  selector: string
}

export interface Point {
  x: number
  y: number
}

export interface SnapshotArgs {
  mode?: string
  maxLines?: number
}

const ARIA_REF_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
])
const ARIA_WRAPPER_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'group',
  'Section',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'strong',
  'emphasis',
  'mark',
  'code',
  'Abbr',
  'time',
  'LabelText',
  'Ruby',
  'subscript',
  'superscript',
  'MenuListPopup',
])
const ARIA_DROP_ROLES = new Set(['InlineTextBox', 'ListMarker', 'LineBreak'])
const ARIA_VALUE_ROLES = new Set(['combobox', 'slider', 'spinbutton', 'progressbar', 'meter'])
const ARIA_NAME_MAX = 100

const SELECTOR_EXPRESSION = `(()=>{const sel='a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],[contenteditable=true]';const els=[...document.querySelectorAll(sel)].filter(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.display!=='none';}).slice(0,200);return els.map(e=>{const role=e.getAttribute('role')||e.tagName.toLowerCase();const name=((e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')||'')+'').trim().replace(/\\s+/g,' ').slice(0,80);let s=e.tagName.toLowerCase();if(e.id)s='#'+CSS.escape(e.id);else{const nm=e.getAttribute('name');if(nm)s=e.tagName.toLowerCase()+'[name='+JSON.stringify(nm)+']';}return {role,name,selector:s};});})()`

const axValue = (v: any) => (v && typeof v === 'object' ? v.value : v)
const axText = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
const clip = (s: string) => (s.length > ARIA_NAME_MAX ? `${s.slice(0, ARIA_NAME_MAX)}...` : s)

function axProps(node: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of node.properties || []) out[p.name] = axValue(p.value)
  return out
}

function ariaStates(role: string, props: Record<string, any>): string[] {
  const states: string[] = []
  if (props.checked === 'true' || props.checked === true) states.push('checked')
  else if (props.checked === 'mixed') states.push('checked=mixed')
  if (props.disabled === true || props.disabled === 'true') states.push('disabled')
  if (props.expanded === true || props.expanded === 'true') states.push('expanded')
  if (props.pressed === 'true' || props.pressed === true) states.push('pressed')
  else if (props.pressed === 'mixed') states.push('pressed=mixed')
  if (props.selected === true || props.selected === 'true') states.push('selected')
  if (role === 'heading' && props.level != null) states.push(`level=${props.level}`)
  return states
}

type OutlineItem =
  | string
  | {
      role: string
      name: string
      ref?: string
      states: string[]
      value: string
      children: OutlineItem[]
    }

function mergeText(items: OutlineItem[]): OutlineItem[] {
  const out: OutlineItem[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (typeof it === 'string' && typeof last === 'string') out[out.length - 1] = `${last} ${it}`
    else out.push(it)
  }
  return out
}

export function distillAxTree(nodes: any[]): OutlineItem[] {
  const byId = new Map((nodes || []).map((n) => [n.nodeId, n]))
  const root = (nodes || []).find((n) => !n.parentId) || nodes?.[0]
  const visit = (node: any): OutlineItem[] => {
    if (!node) return []
    const role: string = axValue(node.role) || ''
    if (ARIA_DROP_ROLES.has(role)) return []
    const kids = mergeText((node.childIds || []).flatMap((id: string) => visit(byId.get(id))))
    if (role === 'StaticText')
      return !node.ignored && axText(axValue(node.name)) ? [clip(axText(axValue(node.name)))] : []
    const props = axProps(node)
    const name = clip(axText(axValue(node.name)))
    const actionable = ARIA_REF_ROLES.has(role) || props.focusable === true
    const ref = actionable && node.backendDOMNodeId ? `e${node.backendDOMNodeId}` : undefined
    if (node.ignored || role === 'RootWebArea') return kids
    if (!ref && !name && ARIA_WRAPPER_ROLES.has(role)) return kids
    if (!ref && !name && (role === 'image' || role === 'img')) return []
    const states = ariaStates(role, props)
    const rawValue = ARIA_VALUE_ROLES.has(role) ? axText(axValue(node.value)) : ''
    const redundant =
      name &&
      kids.length > 0 &&
      kids.every((k) => typeof k === 'string') &&
      axText(kids.join(' ')) === name
    const hidden = redundant || role === 'textbox' || role === 'searchbox'
    return [
      {
        role,
        name,
        ref,
        states,
        value: rawValue ? clip(rawValue) : '',
        children: hidden ? [] : kids,
      },
    ]
  }
  return mergeText(visit(root))
}

const yamlScalar = (s: string) =>
  /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|\s$|^$/.test(s) ? JSON.stringify(s) : s

export function renderAriaSnapshot(
  items: OutlineItem[],
  { maxLines = 600 }: { maxLines?: number } = {},
): string {
  const lines: string[] = []
  const walk = (list: OutlineItem[], depth: number) => {
    for (const it of list) {
      const pad = '  '.repeat(depth)
      if (typeof it === 'string') {
        lines.push(`${pad}- text: ${yamlScalar(it)}`)
        continue
      }
      let head = `${pad}- ${it.role}${it.name ? ` ${JSON.stringify(it.name)}` : ''}`
      for (const s of it.states) head += ` [${s}]`
      if (it.ref) head += ` [ref=${it.ref}]`
      const onlyText = it.children.length === 1 && typeof it.children[0] === 'string'
      if (onlyText) lines.push(`${head}: ${yamlScalar(it.children[0] as string)}`)
      else if (it.value && !it.children.length) lines.push(`${head}: ${yamlScalar(it.value)}`)
      else if (it.children.length) {
        lines.push(`${head}:`)
        walk(it.children, depth + 1)
      } else lines.push(head)
    }
  }
  walk(items, 0)
  const cap = Math.max(1, Number(maxLines) || 600)
  if (lines.length <= cap) return lines.join('\n')
  return `${lines.slice(0, cap).join('\n')}\n# ... ${lines.length - cap} more lines (pass maxLines to see more)`
}

export function parseAriaRef(ref: string): number | null {
  const m = /^(?:aria-ref=)?e(\d+)$/.exec(String(ref ?? '').trim())
  return m ? Number(m[1]) : null
}

// Idea from stablyai/orca (MIT), written fresh: a ref is a backendDOMNodeId, which dies when a SPA re-renders its
// node. Each snapshot also keeps, per ref, the node's role, accessible name and index among same-named nodes, under
// the main frame's loaderId (a navigation gives a new loaderId, so old refs are never healed on the new page).
// Module level because each tool call makes its own instance, and the call that cites a ref is a later one.
interface RefRecord {
  role: string
  name: string
  nth: number
  // how many nodes had this role and name when it was recorded
  of: number
}
interface RefBucket {
  refs: Map<number, RefRecord>
  // a healed ref: the ref the agent holds -> the backendDOMNodeId that now answers for it
  aliases: Map<number, number>
}
const REF_BUCKET_LIMIT = 8
const refBuckets = new Map<string, RefBucket>()

const refRoleOf = (node: any) => axValue(node.role) || ''
const refNameOf = (node: any) => clip(axText(axValue(node.name)))
const isRefNode = (node: any) =>
  !node.ignored &&
  !!node.backendDOMNodeId &&
  (ARIA_REF_ROLES.has(refRoleOf(node)) || axProps(node).focusable === true)

// Merges into the bucket: a later snapshot of the same document must keep the refs an earlier one handed out.
function rememberRefs(nodes: any[], loaderId: string) {
  let bucket = refBuckets.get(loaderId)
  if (!bucket) {
    if (refBuckets.size >= REF_BUCKET_LIMIT)
      refBuckets.delete(refBuckets.keys().next().value as string)
    bucket = { refs: new Map(), aliases: new Map() }
    refBuckets.set(loaderId, bucket)
  }
  const seen = new Map<string, number>()
  const recorded: Array<[number, RefRecord, string]> = []
  for (const node of nodes || []) {
    if (!isRefNode(node)) continue
    const role = refRoleOf(node)
    const name = refNameOf(node)
    const key = `${role}\n${name}`
    const nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    recorded.push([node.backendDOMNodeId, { role, name, nth, of: 0 }, key])
  }
  for (const [id, record, key] of recorded) bucket.refs.set(id, { ...record, of: seen.get(key) ?? 0 })
}

// Refs are main-frame backendDOMNodeIds, valid only on the page their snapshot was taken on.
export function createPageSnapshot(send: CdpSend) {
  let snapshotTaken = false

  async function selectors(): Promise<SelectorItem[]> {
    const r = await send('Runtime.evaluate', {
      expression: SELECTOR_EXPRESSION,
      returnByValue: true,
    })
    return r.result?.value || []
  }

  async function mainLoaderId(): Promise<string | undefined> {
    try {
      const tree = await send('Page.getFrameTree', {})
      return tree?.frameTree?.frame?.loaderId || undefined
    } catch {
      return undefined
    }
  }

  async function aria(args: SnapshotArgs = {}): Promise<string> {
    const loaderId = await mainLoaderId()
    const { nodes } = await send('Accessibility.getFullAXTree', {})
    snapshotTaken = true
    if (loaderId) rememberRefs(nodes, loaderId)
    return renderAriaSnapshot(distillAxTree(nodes), { maxLines: args.maxLines })
  }

  async function snapshot(args: SnapshotArgs = {}): Promise<string> {
    if (args.mode !== 'selectors') {
      const outline = await aria(args)
      return (
        outline ||
        '(the page exposes no accessible content yet - wait for it to load, or take a screenshot)'
      )
    }
    const list = await selectors()
    if (!list.length) return '(no interactable elements visible on the page)'
    return list
      .map((e, i) => `[${i}] ${e.role}${e.name ? ` "${e.name}"` : ''} → ${e.selector}`)
      .join('\n')
  }

  async function objectIdOf(ref: string): Promise<string> {
    const id = parseAriaRef(ref)
    if (!id)
      throw new Error(
        `ref ${JSON.stringify(ref)}: not a snapshot ref (expected e.g. e12 or aria-ref=e12 from browser_snapshot)`,
      )
    if (!snapshotTaken)
      throw new Error(`ref ${ref}: no browser_snapshot was taken on this tab - take one first`)
    const direct = await objectIdFor(id)
    if (direct) return direct
    // Navigation check: a ref heals only on the document it was recorded on. After a navigation the current
    // loaderId has no bucket holding it, so today's error stands and the agent takes a new snapshot.
    const loaderId = await mainLoaderId()
    const bucket = loaderId ? refBuckets.get(loaderId) : undefined
    const alias = bucket?.aliases.get(id)
    const aliased = alias ? await objectIdFor(alias) : undefined
    if (aliased) return aliased
    const record = bucket?.refs.get(id)
    const healed = bucket && record ? await healRef(bucket, id, record) : undefined
    if (healed) return healed
    throw new Error(
      `ref ${ref}: that element is gone (the page changed) - take a new browser_snapshot`,
    )
  }

  async function objectIdFor(backendNodeId: number): Promise<string | undefined> {
    const resolved = await send('DOM.resolveNode', { backendNodeId }).catch(() => null)
    return resolved?.object?.objectId
  }

  // The node was re-rendered: take a fresh tree and use the same role+name node at the recorded index, keeping it
  // for the ref the agent already holds. Only while the page has exactly as many nodes of that role and name as
  // the snapshot did: once a list of same-named buttons grew or shrank, the nth one may be another row's, and a
  // click there is worse than asking for a new snapshot.
  async function healRef(
    bucket: RefBucket,
    id: number,
    record: RefRecord,
  ): Promise<string | undefined> {
    const { nodes } = await send('Accessibility.getFullAXTree', {})
    const same = (nodes || []).filter(
      (n: any) => isRefNode(n) && refRoleOf(n) === record.role && refNameOf(n) === record.name,
    )
    const node = same.length === record.of ? same[record.nth] : undefined
    if (!node) return undefined
    const objectId = await objectIdFor(node.backendDOMNodeId)
    if (objectId) bucket.aliases.set(id, node.backendDOMNodeId)
    return objectId
  }

  async function resolveRef(ref: string): Promise<Point> {
    const objectId = await objectIdOf(ref)
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'})}",
    }).catch(() => {})
    const quads: number[][] | null = await send('DOM.getContentQuads', { objectId })
      .then((r) => r.quads)
      .catch(() => null)
      .finally(() => send('Runtime.releaseObject', { objectId }).catch(() => {}))
    const quad = quads?.[0]
    if (!quad)
      throw new Error(
        `ref ${ref}: the element has no box (hidden or collapsed) - take a new browser_snapshot`,
      )
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    }
  }

  return { snapshot, aria, selectors, resolveRef }
}
