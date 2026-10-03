/* hswarm console core: every API call the console makes, in one place. The page renders; this file talks to the API.
   The token is NOT in this file (a script can be included cross-origin): it is read from the page's
   <meta name="hswarm-token">, which the server renders only for a browser `hswarm ui` signed in. */
;(function () {
  const meta = document.querySelector('meta[name="hswarm-token"]')
  const TOKEN = meta ? meta.content : ''

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Hswarm-Token': TOKEN } }
    let url = '/api/' + path
    if (method === 'GET' && body) url += '?' + new URLSearchParams(body)
    else if (body) {
      opt.headers['Content-Type'] = 'application/json'
      opt.body = JSON.stringify(body)
    }
    const r = await fetch(url, opt)
    const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }))
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    return j
  }
  // Settings calls answer with the whole state; keep it current so the page can re-render from Z.S.
  async function change(path, body) {
    const s = await api('POST', path, body)
    Z.S = s
    emit()
    return s
  }
  const listeners = []
  function emit() {
    for (const f of listeners)
      try {
        f(Z.S)
      } catch (e) {
        console.error(e)
      }
  }

  const Z = {
    S: null,
    api,
    onState(f) {
      listeners.push(f)
      if (Z.S) f(Z.S)
    },
    async refresh() {
      Z.S = await api('GET', 'state')
      emit()
      return Z.S
    },

    keys: (provider) => api('GET', 'keys', { provider }).then((r) => r.rows),
    addKey: async (provider, key) => {
      const r = await api('POST', 'keys/add', { provider, key })
      await Z.refresh()
      return r
    },
    removeKey: async (provider, fingerprint) => {
      const r = await api('POST', 'keys/remove', { provider, fingerprint })
      await Z.refresh()
      return r
    },
    // Priority numbers: 1 is used first; the same number = take turns; null clears it.
    setKeyPriority: (provider, fingerprint, priority) =>
      change('keys/priority', { provider, fingerprint, priority }),
    keyEnabled: async (provider, fingerprint, enabled) => {
      const r = await api('POST', 'keys/enabled', {
        provider,
        fingerprint,
        enabled,
      })
      await Z.refresh()
      return r
    },
    // One free request with that key alone: rejected keys go to the disabled slot with the reason.
    checkKey: async (provider, fingerprint) => {
      const r = await api('POST', 'keys/check', { provider, fingerprint })
      await Z.refresh()
      return r
    },
    // Each provider's favicon, fetched from its website by the server (all never-fetched ones when no list is given).
    fetchIcons: async (providers) => {
      const r = await api('POST', 'favicons/fetch', providers ? { providers } : {})
      await Z.refresh()
      return r
    },
    probe: async (provider) => {
      const r = await api('POST', 'keys/probe', provider ? { provider } : {})
      await Z.refresh()
      return r
    },

    setProvider: (name, fields) => change('providers/set', { name, ...fields }),
    addProvider: (fields) => change('providers/add', fields),
    removeProvider: (name) => change('providers/remove', { name }),

    setModel: (name, enabled) => change('models/enabled', { name, enabled }),
    addModel: (fields) => change('models/add', fields),
    removeModel: (name) => change('models/remove', { name }),
    setModelPriority: (name, priority) => change('models/priority', { name, priority }),
    testModel: (model) => api('POST', 'models/test', { model }),

    setRole: (role, model) => change('roles', { role, model }),
    setOptions: (fields) => change('options', fields),
    select: (profile, tools) => api('POST', 'select', { profile, tools }),

    jobs: (limit = 25) => api('GET', 'jobs', { limit }).then((r) => r.jobs),
    job: (id) => api('GET', 'job', { id }),
    cancelJob: (id) => api('POST', 'job/cancel', { id }),
    ask: (prompt, model = 'auto') => api('POST', 'ask', { prompt, model }),
    doctor: () => api('GET', 'doctor'),
    // Spend and task outcomes per local day, newest last: [{date, tasks, ok, error, cost_usd, providers: {name: usd}}].
    usage: (days = 14) => api('GET', 'usage', { days }).then((r) => r.days),

    clients: () => api('GET', 'clients').then((r) => r.clients),
    install: (client, opts = {}) => api('POST', 'clients/install', { client, ...opts }),

    esc: (s) =>
      String(s ?? '').replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c],
      ),
    money: (v) =>
      v == null ? '–' : '$' + (v < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2)),
    port: location.port || '7793',
    readyProviders: () =>
      new Set(
        (Z.S ? Z.S.providers : []).filter((p) => p.enabled && p.ready > 0).map((p) => p.name),
      ),
  }
  window.Z = Z
})()
