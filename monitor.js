/**
 * Host half of the system-monitor bundle.
 *
 * It owns one {@link SystemSampler} and publishes four endpoints under one
 * loopback HTTP prefix on the harness web server:
 *
 * - `metrics` — the overview payload, plus per-application rows and their icons
 *   when asked with `?detail=1`;
 * - `icon` — one cached application PNG, addressed by content key;
 * - `alerts` — the sustained-load state behind the sidebar badge and the toasts;
 * - `export` — the samples as one flat CSV or JSON table.
 *
 * The Client half — a sidebar panel icon, the `main` page it addresses, and an
 * alert toast in `shell.overlay` — polls those endpoints, so the browser never
 * needs a Harness-internal RPC surface and the host keeps a single sampling
 * cadence no matter how many pages are open.
 *
 * Alerts also go to the Harness log on every transition, which is the only
 * channel that still works with no browser open at all.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { SystemSampler, resolveConfig } from './metrics.js'

/**
 * Optional config schema.
 *
 * `@deepseek-ai/schemastery` resolves from a published npm install, where it
 * gives the Plugin Manager a real settings form and validates the row's config
 * at activation. It does *not* resolve from a linked development bundle, so the
 * import is guarded and `Config` is simply absent there — the sampler then falls
 * back to its own defaults, which it applies either way.
 *
 * @returns the schema, or undefined when the package cannot be resolved.
 */
async function loadConfigSchema() {
  let z
  try {
    z = (await import('@deepseek-ai/schemastery')).default
  } catch {
    return undefined
  }
  if (z === undefined || typeof z.object !== 'function') return undefined
  return z.object({
    alertCpu: z.number().default(85).description('CPU 告警阈值（百分比）'),
    alertMemory: z.number().default(92).description('内存告警阈值（百分比）'),
    alertGpu: z.number().default(95).description('GPU 告警阈值（百分比）'),
    alertDisk: z.number().default(92).description('磁盘告警阈值（百分比）'),
    alertSustainSeconds: z.number().default(5).description('超过阈值持续多少秒后告警'),
    showGpu: z.boolean().default(true).description('显示 GPU 面板'),
    showClock: z.boolean().default(true).description('显示实时频率'),
    showDiskThroughput: z.boolean().default(true).description('显示磁盘吞吐'),
    showIcons: z.boolean().default(true).description('显示应用图标'),
    showProcesses: z.boolean().default(true).description('显示按应用的占用明细'),
  })
}

/** Loader-visible config schema; absent when schemastery is not resolvable. */
export const Config = await loadConfigSchema()

/** Fields the Client localizes; declared here so the schema and the code agree. */
export const CONFIG_KEYS = Object.keys(resolveConfig({}))

/** Route prefix owned by this plugin. */
const ROUTE_PATH = '/dsh-system-monitor'
/** Root-relative metrics endpoint under {@link ROUTE_PATH}. */
const METRICS_PATH = `${ROUTE_PATH}/metrics`
/** Root-relative application-icon endpoint under {@link ROUTE_PATH}. */
const ICON_PATH = `${ROUTE_PATH}/icon`
/** Root-relative sidebar-badge endpoint under {@link ROUTE_PATH}. */
const ALERTS_PATH = `${ROUTE_PATH}/alerts`
/** Root-relative export endpoint under {@link ROUTE_PATH}. */
const EXPORT_PATH = `${ROUTE_PATH}/export`

/** Write a plain-text response. */
function writeText(response, status, text, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  response.end(text)
}

/**
 * Answer one metrics request from the sampler's cached snapshot.
 * @param sampler - live sampler owned by the plugin.
 * @param method - HTTP method, already narrowed to GET or HEAD.
 * @param url - parsed request URL.
 * @param response - response owned by this handler.
 */
function serveMetrics(sampler, method, url, response) {
  // `?detail=1` adds the per-process breakdown; the overview poll stays small.
  const detail = url.searchParams.get('detail') === '1'
  const windowSec = Number(url.searchParams.get('window'))
  sampler.touch()
  const body = JSON.stringify(sampler.snapshot({ detail, window: windowSec }))
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

/** Render one value for CSV, quoting anything that could break a field. */
function csvValue(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Render a `{ columns, rows }` table as CSV.
 * @param table - the table to render.
 * @returns the CSV document, header included.
 */
function toCsv(table) {
  const lines = [table.columns.join(',')]
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => {
      const value = row[column]
      if (column === 't' && typeof value === 'number') return String(value)
      return csvValue(value)
    }).join(','))
  }
  return lines.join('\n')
}

/**
 * Render rows as newline-delimited JSON: one complete object per line.
 *
 * This is the format the sampler would log to if it logged, and it is the one
 * worth standardising on. Appending a sample never rewrites what came before,
 * a torn write costs one line rather than the file, and adding a field later
 * does not invalidate a single row already on disk — all three of which CSV
 * fails, because its schema is the header.
 * @param rows - the objects to render.
 * @returns the NDJSON document.
 */
function toNdjson(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

/**
 * Answer a data export.
 *
 * Three scopes, because they answer different questions and cost different
 * amounts: `series` is the per-second table, `apps` is who was using the
 * machine, and `full` is everything the plugin knows.
 * @param sampler - live sampler owned by the plugin.
 * @param method - HTTP method, already narrowed to GET or HEAD.
 * @param url - parsed request URL.
 * @param response - response owned by this handler.
 */
function serveExport(sampler, method, url, response) {
  const requested = url.searchParams.get('format')
  const format = requested === 'json' || requested === 'ndjson' ? requested : 'csv'
  const scopeParam = url.searchParams.get('scope')
  const scope = scopeParam === 'apps' || scopeParam === 'full' ? scopeParam : 'series'
  const windowSec = Number(url.searchParams.get('window'))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let body
  let type

  if (scope === 'full') {
    // One document, so the row-oriented formats make no sense here: a bundle is
    // an object, and NDJSON of one object is just JSON with a trailing newline.
    const bundle = sampler.exportBundle({ window: windowSec, detail: true })
    body = format === 'ndjson' ? `${JSON.stringify(bundle)}\n` : JSON.stringify(bundle, null, 1)
    type = 'application/json; charset=utf-8'
  } else {
    const table = scope === 'apps' ? sampler.exportApps() : sampler.exportTable(windowSec)
    if (format === 'ndjson') {
      body = toNdjson(table.rows)
      type = 'application/x-ndjson; charset=utf-8'
    } else if (format === 'json') {
      body = JSON.stringify({ generatedAt: Date.now(), windowSec, ...table }, null, 1)
      type = 'application/json; charset=utf-8'
    } else {
      body = toCsv(table)
      type = 'text/csv; charset=utf-8'
    }
  }

  const extension = format === 'ndjson' ? 'ndjson' : format
  const filename = `system-monitor-${scope}-${stamp}.${extension}`

  // `save=1` writes the file here and answers with its path.
  //
  // This exists because the browser-side route is not dependable in an embedded
  // browser: an `<a download>` — and, it turns out, a blob URL handed to a
  // synthetic anchor — can be handled as a *navigation* when the host does not
  // implement downloads. Navigation replaces the whole single-page app, so the
  // user is left on a blank page. Writing the file removes the browser from the
  // picture entirely, and has the pleasant side effect of working even when
  // downloads are blocked outright.
  if (url.searchParams.get('save') === '1') {
    const target = exportTarget(filename)
    try {
      writeFileSync(target, body, 'utf8')
    } catch (error) {
      const failure = JSON.stringify({ ok: false, reason: 'unwritable', detail: error.message })
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(failure)
      return
    }
    const result = JSON.stringify({ ok: true, path: target, bytes: Buffer.byteLength(body), filename })
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(result),
      'cache-control': 'no-store',
    })
    response.end(result)
    return
  }

  response.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

/**
 * Where a saved export goes.
 *
 * `Downloads` when it exists, because that is where a person looks for a file
 * they just asked for; the plugin's own directory otherwise, so a machine
 * without one still has a defined destination rather than a failure.
 * @param filename - the name to save under.
 * @returns an absolute path.
 */
function exportTarget(filename) {
  const downloads = join(os.homedir(), 'Downloads')
  let directory = downloads
  try {
    if (!statSync(downloads).isDirectory()) directory = join(os.homedir(), '.dsh-system-monitor', 'exports')
  } catch {
    directory = join(os.homedir(), '.dsh-system-monitor', 'exports')
  }
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    // Fall through: writeFileSync will report it against a real path.
  }
  return join(directory, filename)
}

/**
 * Answer one application-icon request. Only keys the sampler itself cached are
 * addressable, so the route can never be turned into an arbitrary file read.
 * @param sampler - live sampler owned by the plugin.
 * @param method - HTTP method, already narrowed to GET or HEAD.
 * @param url - parsed request URL.
 * @param response - response owned by this handler.
 */
function serveIcon(sampler, method, url, response) {
  const bytes = sampler.icon(url.searchParams.get('key') ?? '')
  if (bytes === undefined) {
    writeText(response, 404, 'not found', { 'cache-control': 'no-store' })
    return
  }
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': bytes.length,
    'cache-control': 'public, max-age=86400',
  })
  response.end(method === 'HEAD' ? undefined : bytes)
}

/**
 * Answer the sidebar badge's poll.
 *
 * This deliberately does NOT call `touch()`: the badge is always mounted, so
 * keeping the live PowerShell sampler alive for it would cost CPU around the
 * clock. The Node-native CPU, memory and disk readings it uses are sampled
 * anyway; GPU joins in only while a panel has it running.
 * @param sampler - live sampler owned by the plugin.
 * @param method - HTTP method, already narrowed to GET or HEAD.
 * @param response - response owned by this handler.
 */
function serveAlerts(sampler, method, response) {
  const body = JSON.stringify(sampler.alerts())
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

/**
 * Report an alert-level transition to the Harness log.
 *
 * The panel can only reach someone who is already looking at it. This is the one
 * channel that still works when no browser is open at all, which is precisely
 * when an unattended machine starts misbehaving.
 * @param sampler - live sampler owned by the plugin.
 * @param level - the level just reached.
 * @param previous - the level it came from.
 * @param reasons - why the new level was reached.
 */
function reportAlert(sampler, level, previous, reasons) {
  const detail = reasons
    // Not every reason is a percentage. A collector fault carries no value, only
    // a code — printing "sampler null%" would be worse than printing nothing.
    .map((reason) => (reason.value === null || reason.value === undefined
      ? `${reason.key}${reason.detail ? ` ${reason.detail}` : ''}`
      : `${reason.key} ${reason.value}%${reason.detail ? ` (${reason.detail})` : ''}`))
    .join(', ')
  if (level === 'none') sampler.log('info', `alert cleared (was ${previous})`)
  else sampler.log(level === 'high' ? 'warn' : 'info', `${level} alert — ${detail}`)
}

/**
 * Route one request under this plugin's prefix.
 * @param sampler - live sampler owned by the plugin.
 * @param request - incoming HTTP request.
 * @param response - response owned by this handler.
 */
function serve(sampler, request, response) {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    writeText(response, 405, 'method not allowed', { allow: 'GET, HEAD' })
    return
  }
  const url = new URL(request.url ?? '/', 'http://dsh.invalid')
  if (url.pathname === METRICS_PATH) {
    serveMetrics(sampler, method, url, response)
    return
  }
  if (url.pathname === ICON_PATH) {
    serveIcon(sampler, method, url, response)
    return
  }
  if (url.pathname === ALERTS_PATH) {
    serveAlerts(sampler, method, response)
    return
  }
  if (url.pathname === EXPORT_PATH) {
    serveExport(sampler, method, url, response)
    return
  }
  writeText(response, 404, 'not found')
}

/**
 * Activate the bundle: start sampling and publish the metrics route.
 * @param ctx - the plugin's Host context.
 * @param config - the loader row's config; validated when the schema loaded.
 */
export { toCsv, toNdjson }

export function apply(ctx, config) {
  const sampler = new SystemSampler({
    logger: ctx.logger,
    config,
    onAlert: (level, previous, reasons) => reportAlert(sampler, level, previous, reasons),
  })
  ctx.effect(() => () => {
    sampler.dispose()
  }, 'system-monitor: sampler')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (request, response) => {
          serve(sampler, request, response)
        },
      }),
      'system-monitor: metrics route',
    )
  })
}
