// Page-side helpers injected by harvest.ts (read-only: nothing here mutates the page).
const cv = document.createElement('canvas'); cv.width = cv.height = 1;
const cx = cv.getContext('2d', { willReadFrequently: true });
const hex = (c) => {
  if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return 'transparent';
  cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data; const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(d[0]) + h(d[1]) + h(d[2]) + (d[3] < 255 ? h(d[3]) : '');
};
const rgba = (c) => {
  if (!c || c === 'transparent') return 'transparent';
  const h2 = (n) => Math.round(n).toString(16).padStart(2, '0');
  let m = /^rgba?\(([^)]+)\)$/.exec(c); let a = 1, r, g, b;
  if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean); r = +p[0]; g = +p[1]; b = +p[2]; if (p.length > 3) a = p[3].endsWith('%') ? parseFloat(p[3]) / 100 : +p[3]; }
  else if ((m = /^color\(srgb ([^)]+)\)$/.exec(c))) { const p = m[1].split(/[ \/]+/).filter(Boolean); r = +p[0] * 255; g = +p[1] * 255; b = +p[2] * 255; if (p.length > 3) a = p[3].endsWith('%') ? parseFloat(p[3]) / 100 : +p[3]; }
  else { return hex(c); }
  if (a === 0) return 'transparent';
  return '#' + h2(r) + h2(g) + h2(b) + (a < 1 ? ' @' + Math.round(a * 1000) / 10 + '%' : '');
};
const COLORS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke', 'caretColor'];
const PLAIN = ['display', 'position', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap', 'flexDirection', 'alignItems', 'justifyContent', 'borderTopWidth', 'borderTopStyle', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'boxShadow', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textTransform', 'textAlign', 'whiteSpace', 'overflow', 'opacity', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'animationName', 'animationDuration', 'animationTimingFunction', 'animationIterationCount', 'cursor', 'zIndex', 'backdropFilter', 'backgroundImage', 'boxSizing', 'fontVariantNumeric', 'fontFeatureSettings'];
const SKIP_DEFAULT = new Set(['none', 'normal', 'auto', '0px', 'visible', 'static', 'start', 'rgba(0, 0, 0, 0)', 'ease', '0s', 'all', 'initial', 'default', 'row', 'border-box', 'left', '1', 'solid']);
const BODYFONT = getComputedStyle(document.body).fontFamily;
const sty = (el, extra) => {
  const cs = getComputedStyle(el); const o = {};
  for (const k of COLORS) { const v = cs[k]; if (v && !(k.startsWith('border') && cs.borderTopWidth === '0px') && !(k === 'outlineColor') && !(k === 'caretColor') && !(k === 'fill' && v === 'rgb(0, 0, 0)') && !(k === 'stroke' && v === 'none')) { const h = rgba(v); if (h && h !== 'transparent') o[k] = h; } }
  for (const k of [...PLAIN, ...(extra || [])]) { const v = cs[k]; if (v === undefined || SKIP_DEFAULT.has(v)) continue; if (k === 'fontFamily' && v === BODYFONT) continue; if (k === 'opacity' && v === '1') continue; if (/^(transition|animation)/.test(k) && (v === '0s' || v === 'none' || v === 'all')) continue; o[k] = v; }
  return o;
};
const short = (el) => String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(/\s+/).filter(Boolean).slice(0, 8).join('.').slice(0, 160);
const info = (el, extra) => { if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, aria: el.getAttribute('aria-label') || undefined, cls: short(el), rect: [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10], style: sty(el, extra) }; };
const q = (s, root) => (root || document).querySelector(s);
const qa = (s, root) => [...(root || document).querySelectorAll(s)];
const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const qv = (s, root) => qa(s, root).filter(vis);
const bg = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return rgba(c); e = e.parentElement; } return 'none'; };
const chain = (el, stop) => { const o = []; let e = el; while (e && e !== document.body && !(stop && e.matches(stop))) { const r = e.getBoundingClientRect(); o.push({ tag: e.tagName.toLowerCase(), cls: short(e), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: rgba(getComputedStyle(e).backgroundColor) }); e = e.parentElement; } return o; };
const kids = (el) => [...el.children];
const tree = (el, max, d = 0, o = []) => { if (d > max || ['SCRIPT', 'STYLE'].includes(el.tagName)) return o; const cs = getComputedStyle(el); if (cs.display === 'none') return o; const r = el.getBoundingClientRect(); o.push(' '.repeat(d) + el.tagName.toLowerCase() + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') + (el.getAttribute('aria-label') ? '[aria=' + el.getAttribute('aria-label') + ']' : '') + (el.getAttribute('data-state') ? '[state=' + el.getAttribute('data-state') + ']' : '') + ' .' + short(el) + ' ' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); for (const c of el.children) tree(c, max, d + 1, o); return o; };
