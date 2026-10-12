/**
 * Shared test harness.
 *
 * Everything here exists to make the Client half testable without a browser: a
 * fake module loader, a fake React, and one realistic snapshot fixture. The
 * fakes are deliberately faithful in the two places where being unfaithful hid
 * real bugs — `useState` must honour the initial value a component passes, and
 * the loader must record the id a bundle declares.
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Sentinel that consumes a hook slot but falls through to the component's default. */
export const USE_DEFAULT = Symbol('useDefault')

/**
 * Minimal React stand-in.
 *
 * `useState` resolves from a positional queue so a test can drive any render
 * state; when the queue is empty (or yields {@link USE_DEFAULT}) it returns the
 * initial value the component passed, exactly as React would. That is what makes
 * "what does this do before any interaction" testable — the gap that let a
 * white-screen bug through.
 * @returns a fake React module plus the queue that feeds it.
 */
export function makeReact() {
  const queue = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next !== USE_DEFAULT) return next
        break
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useRef() { return { current: null } },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
  }
  return { React, queue }
}

/**
 * Load the Client half exactly as the shell would, capturing its registration.
 * @param options - `{ localStorage }` seed values.
 * @returns the registration, the slots it registered, and the context it saw.
 */
export async function loadClient(options = {}) {
  const { React, queue } = makeReact()
  const store = new Map(Object.entries(options.localStorage ?? {}))
  let registration = null
  globalThis.window = {
    __ModuleLoader__: { load(reg) { registration = reg } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  }
  // Enough DOM for the export path: it creates an anchor, clicks it and removes it.
  // document.createElement is the part that matters — a harness without it would
  // make the export untestable exactly where it broke.
  const created = []
  globalThis.document = {
    baseURI: 'http://127.0.0.1:19387/',
    body: { appendChild(node) { created.push(node) } },
    createElement(tag) {
      return { tag, style: {}, clicked: 0, click() { this.clicked += 1 }, remove() { this.removed = true } }
    },
  }
  globalThis.URL.createObjectURL = () => 'blob:test'
  globalThis.URL.revokeObjectURL = () => {}
  globalThis.fetch = options?.fetch ?? (async () => ({ ok: true, status: 200, blob: async () => ({ size: 12 }) }))
  globalThis.location = { href: 'http://127.0.0.1:19387/' }

  const registered = []
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    locale: { register: () => () => {}, bind: () => (key) => key },
    layout: { selectPanel(id) { ctx.selectedPanel = id } },
    slots: {
      inject(key, callback) { callback(key) },
      register(options_, component) { registered.push({ name: options_.name, component }); return () => {} },
    },
  }
  // `options.context` replaces context pieces, using descriptors so a getter can
  // be installed to reproduce a service that throws on access. Descriptors are
  // read without ever invoking a getter — destructuring or spreading here would
  // fire the very throw the caller is trying to stage. Slots merge, so a caller
  // can override one method without losing `register`.
  if (options.context) {
    const descriptors = Object.getOwnPropertyDescriptors(options.context)
    const slots = descriptors.slots
    delete descriptors.slots
    Object.defineProperties(ctx, descriptors)
    if (slots) ctx.slots = { ...ctx.slots, ...slots.value }
  }

  // `load()` only captures the registration; the plugin object is what the
  // factory returns, which is what the shell then applies.
  await import(`${pathToFileURL(join(ROOT, 'client.js')).href}?t=${Date.now()}`)
  const plugin = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  plugin.apply(ctx)

  const slot = (name) => registered.find((entry) => entry.name === name)?.component
  return { queue, store, ctx, registration, registered, slot }
}

/**
 * Walk a rendered element tree, invoking components, and hand every host element
 * to a visitor. Throwing components surface as a readable failure.
 * @param node - the element returned by a component.
 * @param visit - called with `(type, props)` for each host element.
 * @returns the number of nodes visited.
 */
export function render(node, visit = () => {}) {
  let count = 0
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string' || typeof current === 'number') { count += 1; return }
    if (Array.isArray(current)) { for (const child of current) walk(child); return }
    if (typeof current.type === 'function') {
      let out
      try {
        out = current.type(current.props)
      } catch (error) {
        throw new Error(`${current.type.name || 'anonymous'} threw: ${error.message}`)
      }
      count += 1
      walk(out)
      return
    }
    count += 1
    visit(current.type, current.props ?? {}, current.children)
    walk(current.children)
  }
  walk(node)
  return count
}

/** A complete, realistic Host snapshot. */
export function snapshot(overrides = {}) {
  const now = overrides.now ?? Date.now()
  const series = overrides.series ?? Array.from({ length: 90 }, (_, index) => ({
    t: now - (89 - index) * 1000,
    cpu: index === 40 ? 96 : 18 + (index % 9),
    mem: index === 70 ? 94 : 76 + (index % 5),
    gpu: index % 13 === 0 ? 61 : 6,
  }))
  const timeline = overrides.timeline ?? Array.from({ length: 16 }, (_, core) =>
    Array.from({ length: 40 }, (_, column) => (core * 13 + column * 7) % 100))
  const capabilities = overrides.capabilities ?? {
    cpu: { available: true }, memory: { available: true }, diskCapacity: { available: true },
    clockSpeed: { available: true }, memoryDetail: { available: true }, gpu: { available: true },
    processGpu: { available: true }, processes: { available: true }, diskThroughput: { available: true },
    diskLatency: { available: true }, forecast: { available: true }, battery: { available: true },
    icons: { available: true },
  }
  const base = {
    ts: now, revision: 14, intervalMs: 1000, windowSec: 60,
    host: { hostname: 'test-host', os: 'Windows 10.0.19045', uptimeSec: 7200, samplerUptimeSec: 600 },
    cpu: {
      model: 'AMD Ryzen 7 7730U', cores: 16, speedMhz: 1996, actualMhz: 3380, nominalMhz: 2000,
      usage: 62.5, perCore: timeline.map((row) => row.at(-1)), history: series.map((point) => point.cpu), timeline,
    },
    memory: {
      total: 16539369472, used: 13365002240, free: 3174367232, usage: 80.8, committed: 2e10,
      commitLimit: 3.2e10, cached: 2.9e9, pageFilePct: 23, history: series.map((point) => point.mem),
    },
    gpu: {
      status: 'live', reason: null, util: 42.4, dedicated: 4e8, shared: 1e9, engines: { '3d': 42.4 },
      updatedAt: now, adapters: [{ name: 'AMD Radeon', memory: 5e8 }], history: series.map((point) => point.gpu),
      diagnostics: {},
    },
    disks: [{ mount: 'C:', total: 262085611520, used: 173191770112, free: 88893841408, usage: 66.1 }],
    series, io: [], latency: [],
    storage: { latencySec: 0.0005, latencyDisk: '0 C:', queue: 0, transfers: 19 },
    clock: { actualMhz: 3380, nominalMhz: 2000, ratio: 1.69, peakMhz: 4070, throttled: false, busy: true },
    bottleneck: { resource: 'memory', pressure: 0.87, pressures: { cpu: 0.69, memory: 0.87, gpu: 0.45, disk: 0.01 }, detail: null },
    // One finished alert span, then one still open — the two shapes the chart draws.
    alertLog: [
      { t: now - 60000, level: 'warn', reasons: [{ key: 'cpu', value: 88, detail: null }] },
      { t: now - 45000, level: 'none', reasons: [] },
      { t: now - 20000, level: 'high', reasons: [{ key: 'memory', value: 96, detail: null }] },
    ],
    summary: {
      startedAt: now - 7200000, since: now - 90000000, seconds: 7200, samples: 7200,
      cpu: { value: 97.4, t: now - 5400000, label: 'Harness' },
      memory: { value: 94.1, t: now - 3600000, label: 'Chrome' },
      gpu: { value: 88.2, t: now - 1800000, label: 'Codex' },
      latencyMs: { value: 62.5, t: now - 600000, disk: '0 C:' },
      cpuAvg: 18.3, memoryAvg: 79.2,
    },
    forecast: {
      disk: { windowSec: 1800, mounts: [{ mount: 'C:', free: 88893841408, bytesPerDay: -4e9, daysLeft: 22.7 }] },
      memory: { windowSec: 1800, committed: 2e10, limit: 3.2e10, bytesPerDay: -1e9, secondsLeft: null },
      battery: { state: 'present', percent: 82, minutes: 214, charging: false },
    },
    alerts: { level: 'none', reasons: [] },
    health: { level: 'busy', resource: 'memory', value: 80.8, disk: null, ratios: {}, culprit: { label: 'Chrome', value: 1.6e9 } },
    capabilities,
    config: {
      alertCpu: 85, alertMemory: 92, alertGpu: 95, alertDisk: 92, alertSustainSeconds: 5,
      showGpu: true, showClock: true, showDiskThroughput: true, showIcons: true, showProcesses: true,
      persist: true, idleSamplingSeconds: 20,
    },
    detail: {
      sampledAt: now - 700,
      processes: [
        { pid: 100, name: 'chrome', label: 'Google Chrome', cpu: 2.4, memory: 5e8, gpu: 0, start: now - 3600e3 },
        { pid: 101, name: 'chrome', label: 'Google Chrome', cpu: 0.6, memory: 2e8, gpu: 0, start: now - 3000e3 },
        { pid: 200, name: 'Code', label: 'Codex', cpu: 4.1, memory: 6e8, gpu: 3.5, start: now - 7200e3 },
      ],
      physicalDisks: [{ name: '0 C:', read: 1e6, write: 5e5, latencySec: 0.0005, queue: 0, transfers: 19 }],
      appIcons: { Codex: 'deadbeef' },
      appPaths: { 'Google Chrome': 'C:\\Chrome\\chrome.exe', Codex: 'C:\\Codex\\Codex.exe' },
      growth: {
        windowSec: 300,
        rows: [
          { label: 'Codex', delta: 180 * 1048576, current: 6e8, fresh: false, count: 1 },
          { label: 'Google Chrome', delta: -60 * 1048576, current: 7e8, fresh: false, count: 2 },
          { label: 'NewApp', delta: 90 * 1048576, current: 9e7, fresh: true, count: 1 },
        ],
      },
    },
  }
  const merged = { ...base, ...overrides }
  delete merged.now
  return merged
}

/** Read a JSON file from the package root. */
export function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
}
