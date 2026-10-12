/**
 * Client render coverage.
 *
 * Every one of these paths has to survive a render, because a throw here is a
 * blank panel rather than a bad number. The first case is the one that actually
 * shipped broken: the initial render happens before the first poll returns, so
 * `data` is null and anything dereferencing it takes the whole panel down.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadClient, render, snapshot, USE_DEFAULT, ROOT } from './harness.mjs'

export async function run({ check, suite }) {
  suite('activation')
  // The plugin scope is disposed if apply() throws, and that removes the sidebar
  // icon and the panel together. So nothing in apply may be able to throw — not
  // even an optional enhancement reaching for a service it does not inject.
  // Activation is caught here rather than left to abort the suite, so the report
  // names the actual check instead of an opaque "threw".
  let hostile = null
  try {
    hostile = await loadClient({
      context: {
        get layout() { throw new Error('service not injected') },
        slots: {
          inject(key, callback) {
            if (key === 'shell.overlay') throw new Error('unknown slot')
            callback(key)
          },
        },
      },
    })
  } catch (error) {
    check('apply survives a hostile activation', false, error.message)
  }
  if (hostile) {
    check('apply survives a throwing layout service', hostile.registered.some((entry) => entry.name === 'main'))
    check('apply survives an unknown overlay slot', hostile.registered.some((entry) => entry.name === 'sidebar.panellist'))
    check('the toaster is simply absent in that case', !hostile.registered.some((entry) => entry.name === 'shell.overlay'))
    let iconSafe = true
    try {
      render(hostile.slot('sidebar.panellist')({ size: 18, active: false }), () => {})
    } catch { iconSafe = false }
    check('a degraded plugin still renders its icon', iconSafe)
  }

  suite('client render')
  const client = await loadClient({ localStorage: { 'dsh-system-monitor:density': 'comfortable' } })
  const { queue, slot } = client

  check('registers the main panel', typeof slot('main') === 'function')
  check('registers the sidebar icon', typeof slot('sidebar.panellist') === 'function')
  check('registers the overlay toaster', typeof slot('shell.overlay') === 'function')

  const panel = slot('main')
  const toaster = slot('shell.overlay')

  /** Render the panel with a given state, collecting what the tree contains. */
  function draw(resource, state, { range = 60, density = USE_DEFAULT } = {}) {
    queue.length = 0
    queue.push([resource, () => {}])
    queue.push([range, () => {}])
    queue.push([density, () => {}])
    queue.push([false, () => {}]) // exportOpen
    queue.push(USE_DEFAULT)       // customOpen
    queue.push(USE_DEFAULT)       // customMinutes
    queue.push(USE_DEFAULT)       // exportBusy
    queue.push(USE_DEFAULT)       // saveToast
    queue.push([state, () => {}])
    queue.push([null, () => {}])
    queue.push(['usage', () => {}])
    queue.push([null, () => {}])
    const seen = { spans: 0, ticks: 0, peaks: 0, ring: null, chart: null, core: null, density: null, panels: 0, stale: 0 }
    const nodes = render(panel({}), (type, props, children) => {
      const cls = props.className
      if (type === 'rect' && props.opacity === 0.13) seen.spans += 1
      if (cls === 'dsm-chartTicks') seen.ticks = (children ?? []).length
      if (cls === 'dsm-chartPeak') seen.peaks += 1
      if (cls === 'dsm-panels') seen.panels = 1
      if (type === 'circle' && props.r && props.strokeWidth >= 7) seen.ring = props.r * 2 + props.strokeWidth + 3
      if (cls === 'dsm-chart' && props.style?.height) seen.chart = props.style.height
      if (cls === 'dsm-coreTrack' && props.style?.height) seen.core = props.style.height
      if (props['data-density']) seen.density = props['data-density']
      // Exact match: includes also matches dsm-staleText, which counted the
      // same banner twice. Substring matching on class names has now produced a
      // wrong test twice in this file.
      if (cls === 'dsm-stale') seen.stale += 1
    })
    return { nodes, seen }
  }

  // The regression that mattered: the very first render, before any data.
  let ok = true
  try { draw(null, { data: null, error: null }) } catch (error) { ok = false; check('first render (data null)', false, error.message) }
  if (ok) check('first render (data null)', true)

  ok = true
  try { draw(null, { data: null, error: 'HTTP 401' }) } catch (error) { ok = false; check('first render with error', false, error.message) }
  if (ok) check('first render with error', true)

  // A payload missing fields is what a version-skewed Host sends.
  ok = true
  try {
    draw(null, { data: { ts: Date.now(), host: {}, cpu: {}, memory: {}, gpu: {}, disks: [], series: [] }, error: null })
  } catch (error) { ok = false; check('partial payload', false, error.message) }
  if (ok) check('partial payload', true)

  for (const resource of ['cpu', 'memory', 'gpu', 'disk', 'status']) {
    ok = true
    try { draw(resource, { data: snapshot(), error: null }) } catch (error) { ok = false; check(`tab ${resource}`, false, error.message) }
    if (ok) check(`tab ${resource}`, true)
  }

  // Stale data plus a transport error must still render the last known values.
  ok = true
  try { draw(null, { data: snapshot(), error: 'HTTP 502' }) } catch (error) { ok = false; check('stale data with error', false, error.message) }
  if (ok) check('stale data with error', true)

  // The chart's own features, which are easy to break while editing the chart.
  const withAlerts = draw(null, { data: snapshot(), error: null })
  check('chart draws alert spans', withAlerts.seen.spans === 2, `spans=${withAlerts.seen.spans}`)
  check('chart draws time-axis ticks', withAlerts.seen.ticks === 5, `ticks=${withAlerts.seen.ticks}`)
  check('chart marks a peak per series', withAlerts.seen.peaks === 3, `peaks=${withAlerts.seen.peaks}`)
  check('core and disk share one grid row', withAlerts.seen.panels === 1)

  const noAlerts = draw(null, { data: snapshot({ alertLog: [] }), error: null })
  check('no alert log means no spans', noAlerts.seen.spans === 0)

  const openAlert = draw(null, { data: snapshot({ alertLog: [{ t: Date.now() - 30000, level: 'high', reasons: [] }] }), error: null })
  check('an open alert still draws one span', openAlert.seen.spans === 1)

  const noGpu = draw(null, { data: snapshot({ capabilities: { ...snapshot().capabilities, gpu: { available: false, reason: { code: 'no-gpu-counters' } } } }), error: null })
  check('a missing GPU drops its peak marker', noGpu.seen.peaks === 2, `peaks=${noGpu.seen.peaks}`)

  // "This machine cannot" and "this broke" must not look the same. A capability
  // that is absent is hidden; one that failed keeps its panel and its reason,
  // because a panel that silently vanishes cannot be told from a missing feature.
  const capOf = (code) => ({ ...snapshot().capabilities, gpu: { available: false, reason: { code } } })
  const gaugeCards = (state) => {
    queue.length = 0
    queue.push([null, () => {}])
    queue.push([60, () => {}])
    queue.push(['comfortable', () => {}])
    queue.push([false, () => {}])  // exportOpen
    queue.push(USE_DEFAULT)        // customOpen
    queue.push(USE_DEFAULT)        // customMinutes
    queue.push(USE_DEFAULT)        // exportBusy
    queue.push(USE_DEFAULT)        // saveToast
    queue.push([state, () => {}])
    queue.push([null, () => {}])
    queue.push(['usage', () => {}])
    queue.push([null, () => {}])
    let cards = 0
    render(panel({}), (type, props) => {
      if (props.className === 'dsm-card' && props['data-openable'] === 'true') cards += 1
    })
    return cards
  }
  suite('export ui')
  // The export used to be an `<a href download>`. In an embedded browser a
  // download it does not handle becomes a navigation, the SPA is replaced, and
  // the user is looking at a blank page — which is exactly what happened. The
  // entries must be buttons that fetch and hand over a blob, so navigation is
  // not merely unlikely, it is impossible.
  const menuOpen = (state) => {
    queue.length = 0
    queue.push([null, () => {}])
    queue.push([60, () => {}])
    queue.push(['comfortable', () => {}])
    queue.push([true, () => {}])  // exportOpen
    // The remaining UI state resolves to its own default, so this no longer has
    // to track the component's hook order every time a control is added.
    queue.push(USE_DEFAULT)
    queue.push(USE_DEFAULT)
    queue.push(USE_DEFAULT)
    queue.push(USE_DEFAULT)
    queue.push([state, () => {}])
    queue.push([null, () => {}])
    queue.push(['usage', () => {}])
    queue.push([null, () => {}])
    const seen = { links: 0, anchors: 0, hrefs: 0 }
    render(panel({}), (type, props) => {
      if (props.className === 'dsm-exportLink') seen.links += 1
      if (type === 'a') seen.anchors += 1
      if (typeof props.href === 'string' && props.href.includes('/export')) seen.hrefs += 1
    })
    return seen
  }
  const menu = menuOpen({ data: snapshot(), error: null })
  check('the export menu offers one entry per format', menu.links === 3, `${menu.links} entries`)
  check('no export entry is an anchor', menu.anchors === 0)
  check('and none carries an export href', menu.hrefs === 0)
  // The Save As dialog is the only way to let someone choose a folder, and
  // `showSaveFilePicker` is the only way to raise one. Its one hard limit is
  // worth stating rather than papering over: the browser never reveals the chosen
  // path, so a save through it reports a filename and nothing more.
  //
  // These drive the real click handler rather than grepping the source. An
  // earlier version of this test asserted the *string* `showSaveFilePicker`
  // appeared in the file — which stayed true when the whole dialog was disabled
  // behind `if (false)`. A test that cannot fail is worse than no test.
  const { queue: q2, slot: s2 } = await loadClient({
    fetch: async (url) => {
      q2.push(['fetched', url])
      return { ok: true, status: 200, blob: async () => ({ size: 42 }) }
    },
  })
  const exportButtons = (open) => {
    q2.length = 0
    q2.push([null, () => {}]); q2.push([60, () => {}]); q2.push(['comfortable', () => {}])
    q2.push([open, () => {}])   // exportOpen
    q2.push(USE_DEFAULT); q2.push(USE_DEFAULT); q2.push(USE_DEFAULT); q2.push(USE_DEFAULT)
    q2.push([{ data: snapshot(), error: null }, () => {}])
    q2.push([null, () => {}]); q2.push(['usage', () => {}]); q2.push([null, () => {}])
    const buttons = []
    render(s2('main')({}), (type, props) => {
      if (props.className === 'dsm-exportLink' && typeof props.onClick === 'function') buttons.push(props.onClick)
    })
    return buttons
  }

  const dialogCalls = []
  const writes = []
  globalThis.window.showSaveFilePicker = async (spec) => {
    dialogCalls.push(spec)
    return {
      name: 'my-monitor.csv',
      createWritable: async () => ({ write: async (blob) => writes.push(blob), close: async () => {} }),
    }
  }
  const buttons = exportButtons(true)
  check('the menu exposes three handlers', buttons.length === 3, `${buttons.length}`)
  await buttons[0]()
  check('clicking a format raises the system dialog', dialogCalls.length === 1)
  check('the dialog is offered the right extension',
    String(dialogCalls[0]?.suggestedName ?? '').endsWith('.csv'), String(dialogCalls[0]?.suggestedName))
  check('and a matching type filter', Boolean(dialogCalls[0]?.types?.[0]?.accept?.['text/csv']))
  check('the file is written through the handle', writes.length === 1)

  // Cancel must be silent: no write, and nothing fetched either — asking for data
  // the user just declined to save would be both rude and wasteful.
  writes.length = 0
  q2.length = 0
  globalThis.window.showSaveFilePicker = async () => {
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    throw abort
  }
  const cancellable = exportButtons(true)
  await cancellable[1]()
  check('cancelling writes nothing', writes.length === 0)
  check('cancelling fetches nothing', !q2.some(([tag]) => tag === 'fetched'))

  const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8')
  check('a cancelled save is not reported as a failure', /if \(result\.cancelled\) return/.test(clientSource))

  check('no blob URL is created anywhere', !/createObjectURL/.test(clientSource))
  check('no anchor is created anywhere', !/createElement\('a'\)/.test(clientSource))

  check('a machine without GPU counters hides the card',
    gaugeCards({ data: snapshot({ capabilities: capOf('no-gpu-counters') }), error: null }) === 2)
  check('a GPU that failed keeps its card',
    gaugeCards({ data: snapshot({ capabilities: capOf('spawn-failed') }), error: null }) === 3)
  check('a sampler that went silent keeps its card',
    gaugeCards({ data: snapshot({ capabilities: capOf('sampler-silent') }), error: null }) === 3)

  // The protocol handshake. A Host older than this Client must say so at the top,
  // because every other way this mismatch presents itself is a mystery.
  const stale = draw(null, { data: snapshot({ protocol: 0 }), error: null })
  check('a stale Host is announced', stale.seen.stale === 1, `banners=${stale.seen.stale}`)
  const current = draw(null, { data: snapshot({ protocol: 1 }), error: null })
  check('a matching Host is not', current.seen.stale === 0)
  // No protocol field at all is the pre-handshake Host, and is the case this
  // was written for: reading a missing field as compatible would silence it.
  const silent = draw(null, { data: snapshot({ protocol: undefined }), error: null })
  check('a Host that reports no protocol is treated as older', silent.seen.stale === 1, `banners=` + silent.seen.stale)
  const loading = draw(null, { data: null, error: null })
  check('the loading render does not cry wolf', loading.seen.stale === 0)
  const newer = draw(null, { data: snapshot({ protocol: 9 }), error: null })
  check('a newer Host is not either', newer.seen.stale === 0)

  const short = draw(null, { data: snapshot({ series: [{ t: Date.now(), cpu: 1, mem: 1, gpu: 1 }] }), error: null })
  check('a single sample draws no chart', short.seen.chart === null)

  // Density must actually change the sizes, not just the attribute.
  const comfy = draw(null, { data: snapshot(), error: null }, { density: 'comfortable' })
  const tight = draw(null, { data: snapshot(), error: null }, { density: 'compact' })
  check('comfortable sizes', comfy.seen.ring === 104 && comfy.seen.chart === 168 && comfy.seen.core === 60,
    `${comfy.seen.ring}/${comfy.seen.chart}/${comfy.seen.core}`)
  check('compact sizes', tight.seen.ring === 84 && tight.seen.chart === 108 && tight.seen.core === 36,
    `${tight.seen.ring}/${tight.seen.chart}/${tight.seen.core}`)
  check('density is reflected on the page', tight.seen.density === 'compact')

  // The saved preference must survive a remount, and junk must not leak through.
  for (const [saved, expected] of [['compact', 'compact'], ['comfortable', 'comfortable'], ['junk', 'comfortable']]) {
    const remount = await loadClient({ localStorage: { 'dsh-system-monitor:density': saved } })
    remount.queue.length = 0
    remount.queue.push([null, () => {}])
    remount.queue.push([60, () => {}])
    remount.queue.push(USE_DEFAULT)  // density, from localStorage
    remount.queue.push(USE_DEFAULT)  // exportOpen
    remount.queue.push(USE_DEFAULT)  // customOpen
    remount.queue.push(USE_DEFAULT)  // customMinutes
    remount.queue.push(USE_DEFAULT)  // exportBusy
    remount.queue.push(USE_DEFAULT)  // saveToast
    remount.queue.push([{ data: snapshot(), error: null }, () => {}])
    remount.queue.push([null, () => {}])
    remount.queue.push(['usage', () => {}])
    remount.queue.push([null, () => {}])
    let density = null
    render(remount.slot('main')({}), (type, props) => { if (props['data-density']) density = props['data-density'] })
    check(`saved density ${saved} resolves to ${expected}`, density === expected, `got ${density}`)
  }

  suite('alert toaster')
  /** Render the toaster with a given toast list and report what it produced. */
  function drawToaster(toasts) {
    queue.length = 0
    queue.push([toasts, () => {}])
    const seen = { toasts: 0, css: false }
    const nodes = render(toaster({}), (type, props, children) => {
      if (props.className === 'dsm-toast') seen.toasts += 1
      if (type === 'style' && (children ?? []).some((child) => typeof child === 'string' && child.includes('.dsm-toasts{'))) {
        seen.css = true
      }
    })
    return { ...seen, nodes }
  }

  const idle = drawToaster([])
  check('no toasts while idle', idle.toasts === 0 && idle.nodes === 0, `toasts=${idle.toasts} nodes=${idle.nodes}`)

  for (const level of ['warn', 'high']) {
    const drawn = drawToaster([{ id: 'a', level, reasons: [{ key: 'cpu', value: 92, detail: null }] }])
    check(`${level} toast renders`, drawn.toasts === 1, `toasts=${drawn.toasts}`)
    check(`${level} toast carries its own stylesheet`, drawn.css)
  }

  // Toasts stack, but only up to the cap.
  const many = drawToaster(Array.from({ length: 3 }, (_, index) => ({ id: `t${index}`, level: 'high', reasons: [] })))
  check('toasts stack', many.toasts === 3, `toasts=${many.toasts}`)

  // An unknown reason key must not be labelled as a disk, and must not throw.
  const odd = drawToaster([{ id: 'x', level: 'high', reasons: [{ key: 'wat', value: 1, detail: null }] }])
  check('an unknown reason key still renders', odd.toasts === 1)
}