/**
 * Host-side behaviour that has no HTTP surface: the forecast regressions, the
 * alert log, the pressure verdict, and the sampling cadence.
 *
 * These are the calculations whose mistakes are plausible and quiet — a
 * projection that is off by a factor, an alert log that grows without bound, a
 * throttle flag that fires at idle.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SystemSampler, resolveConfig, resolveWindow } from '../metrics.js'
import { ROOT } from './harness.mjs'

const MINUTE = 60000
const GIB = 1073741824

/** Feed a synthetic free-space history at an exact per-day slope. */
function seedDisk(sampler, volumes, slopePerDay, samples, spanMinutes) {
  sampler.freeSpace = []
  const start = Date.now() - spanMinutes * MINUTE
  for (let index = 0; index < samples; index += 1) {
    const t = start + (index * spanMinutes * MINUTE) / (samples - 1)
    const free = new Map()
    for (const [mount, base] of Object.entries(volumes)) {
      free.set(mount, base + (slopePerDay / 86400) * ((t - start) / 1000))
    }
    sampler.freeSpace.push({ t, free })
  }
}

export async function run({ check, equal, suite }) {
  suite('config')
  // A percentage is clamped into range rather than discarded, and only a
  // non-numeric value falls back to the default.
  for (const [raw, expected] of [
    [undefined, 92], ['80', 80], [-5, 10], [0, 10], [200, 100], ['abc', 92], [null, 10],
  ]) {
    equal(`alertMemory(${JSON.stringify(raw)})`, resolveConfig({ alertMemory: raw }).alertMemory, expected)
  }
  // 0 is meaningful for idle sampling and must not be treated as "unset".
  for (const [raw, expected] of [[undefined, 20], [0, 0], [-5, 0], [5, 5], [1, 2], [9999, 300]]) {
    equal(`idleSamplingSeconds(${JSON.stringify(raw)})`, resolveConfig({ idleSamplingSeconds: raw }).idleSamplingSeconds, expected)
  }
  // The Client cannot detect a Host that predates it unless the Host says which
  // contract it speaks. That one field is the whole basis of the handshake.
  suite('protocol')
  const handshake = new SystemSampler({ config: {} })
  const declared = handshake.snapshot({ window: 60 }).protocol
  check('the Host declares its protocol', Number.isFinite(declared), `protocol=`)
  check('and it is a positive integer', Number.isInteger(declared) && declared > 0)
  handshake.dispose()

  equal('empty config yields full defaults', Object.keys(resolveConfig({})).length, Object.keys(resolveConfig(undefined)).length)
  // A custom range has to mean what it says. Rounding it to the nearest preset
  // would make the control a lie, so any value in range is honoured as asked and
  // only the retention limit clamps it.
  equal('a custom window is honoured', resolveWindow(900), 900)
  equal('an odd custom window is honoured too', resolveWindow(137), 137)
  equal('beyond retention clamps to retention', resolveWindow(999999), 10800)
  equal('below the floor clamps to the floor', resolveWindow(5), 60)
  equal('a fractional window is rounded', resolveWindow(90.6), 91)
  equal('nonsense falls back to the shortest window', resolveWindow('abc'), 60)

  suite('forecast')
  const sampler = new SystemSampler({ config: {} })

  seedDisk(sampler, { 'C:': 50 * GIB }, -GIB, 6, 10)
  sampler.commitSeries = []
  let forecast = sampler.forecast()
  equal('a volume losing 1 GiB/day reports the window', forecast.disk.windowSec, 600)
  check('daysLeft matches free space over the slope', Math.abs(forecast.disk.mounts[0].daysLeft - 50) < 1,
    `daysLeft=${forecast.disk.mounts[0].daysLeft}`)

  seedDisk(sampler, { 'C:': 50 * GIB }, 0, 6, 10)
  forecast = sampler.forecast()
  check('a flat volume never projects a fill-up', forecast.disk.mounts.every((mount) => mount.daysLeft === null))
  equal('a flat volume still reports its slope', forecast.disk.mounts[0].bytesPerDay, 0)

  seedDisk(sampler, { 'C:': 50 * GIB }, -GIB, 4, 4)
  forecast = sampler.forecast()
  check('a baseline under the floor projects nothing', forecast.disk.mounts[0].daysLeft === null)
  check('a baseline under the floor still measures', forecast.disk.mounts[0].bytesPerDay !== 0)

  seedDisk(sampler, { 'C:': 50 * GIB }, GIB, 6, 10)
  forecast = sampler.forecast()
  check('a volume gaining space never projects a fill-up', forecast.disk.mounts[0].daysLeft === null)

  sampler.system = { committedBytes: 20e9, commitLimitBytes: 30e9 }
  sampler.commitSeries = []
  for (let index = 0; index < 6; index += 1) {
    sampler.commitSeries.push({ t: Date.now() - (6 - index) * 5 * MINUTE, y: 20e9 + (index * 1e9) / 5 })
  }
  forecast = sampler.forecast()
  const expectedSeconds = (30e9 - 21e9) / (1e9 / (25 * 60))
  check('memory exhaustion eta matches the slope', Math.abs(forecast.memory.secondsLeft - expectedSeconds) / expectedSeconds < 0.05,
    `got ${forecast.memory.secondsLeft}, want ~${Math.round(expectedSeconds)}`)

  sampler.commitSeries = []
  for (let index = 0; index < 6; index += 1) {
    sampler.commitSeries.push({ t: Date.now() - (6 - index) * 5 * MINUTE, y: 20e9 - index * 2e8 })
  }
  check('a shrinking commit charge never projects exhaustion', sampler.forecast().memory.secondsLeft === null)

  for (const state of ['unknown', 'absent']) {
    sampler.battery = { state, percent: null, minutes: null, charging: null }
    equal(`battery state ${state} passes through`, sampler.forecast().battery.state, state)
  }
  sampler.battery = { state: 'present', percent: 82, minutes: 214, charging: false }
  const cell = sampler.forecast().battery
  check('a discharging battery reports its remaining time', cell.state === 'present' && cell.minutes === 214 && cell.charging === false)

  suite('diagnostics')
  const alerts = new SystemSampler({ config: { alertSustainSeconds: 0, alertCpu: 60 } })
  const level = () => alerts.alerts().level
  equal('starts clear', level(), 'none')
  equal('crossing the threshold trips', level(), 'none') // sustain 0 trips on the first over-threshold read
  alerts.cpuUsage = 75
  equal('cpu over threshold alerts', level(), 'high')
  alerts.cpuUsage = 80
  const before = alerts.alertLog.length
  level()
  equal('an unchanged level adds no entry', alerts.alertLog.length, before)
  alerts.cpuUsage = 5
  equal('clearing records a transition', level(), 'none')
  equal('the clear is logged', alerts.alertLog.at(-1).level, 'none')

  // A flapping resource must not grow the log without bound.
  for (let index = 0; index < 120; index += 1) {
    alerts.cpuUsage = index % 2 === 0 ? 95 : 5
    alerts.alerts()
  }
  check('the alert log is bounded', alerts.alertLog.length <= 40, `length=${alerts.alertLog.length}`)
  check('the alert log is oldest-first', alerts.alertLog.at(-1).t >= alerts.alertLog[0].t)

  // Pressure is distance from saturation, and capacity is deliberately not pressure.
  const pressure = new SystemSampler({ config: {} })
  pressure.cpuUsage = 45
  pressure.memory.usage = 50
  pressure.gpu.status = 'idle'
  pressure.storage = { latencySec: 0.06, latencyDisk: '0 C:', queue: 1, transfers: 100 }
  equal('a saturated disk is named the bottleneck', pressure.bottleneck()?.resource, 'disk')
  pressure.storage = { latencySec: 0.001, latencyDisk: '0 C:', queue: 0, transfers: 10 }
  equal('an idle machine has no bottleneck', pressure.bottleneck(), null)

  // Low clock at idle is power management; only under load is it throttling.
  const clock = new SystemSampler({ config: {} })
  clock.system = { cpuPerformancePct: 50, cpuNominalMhz: 2000 }
  clock.cpuUsage = 90
  check('a low clock under load reads as throttled', clock.clock().throttled)
  clock.cpuUsage = 5
  check('the same clock at idle does not', clock.clock().throttled === false)
  clock.peakMhz = 0
  clock.system = { cpuPerformancePct: 200, cpuNominalMhz: 2000 }
  equal('the clock derives from the turbo ratio', clock.clock().actualMhz, 4000)

  suite('sampling cadence')
  const rates = new SystemSampler({ config: { idleSamplingSeconds: 20 } })
  const untouched = rates.samplingRate()
  rates.touch()
  const active = rates.samplingRate()
  rates.touchedAt = Date.now() - 60000
  const warm = rates.samplingRate()
  rates.touchedAt = Date.now() - 3600000
  const cold = rates.samplingRate()
  check('rates step down with idle time', untouched === 20 && active === 1 && warm === 4 && cold === 20,
    `${untouched}/${active}/${warm}/${cold}`)

  const stopper = new SystemSampler({ config: { idleSamplingSeconds: 0 } })
  check('idleSamplingSeconds 0 restores stopping', stopper.coldRate === 0 && stopper.samplingRate() === 0)

  // The child learns its cadence from a file, so what is written must be parseable.
  const writer = new SystemSampler({ config: {} })
  writer.ratePath = join(tmpdir(), `dsm-test-rate-${process.pid}`)
  writer.child = { stdin: null }
  writer.touchedAt = Date.now() - 3600000
  writer.syncRate()
  const written = existsSync(writer.ratePath) ? readFileSync(writer.ratePath, 'utf8').trim() : null
  equal('the rate file holds a bare integer', written, '20')
  writer.ratePath = writer.ratePath
  writer.child = null

  suite('export')
  const exporter = new SystemSampler({ config: {} })
  exporter.ingestProcesses([
    { pid: 1, name: 'chrome', desc: 'Google Chrome', cpu: 2, ws: 5e8, start: Date.now() - 3600e3 },
    { pid: 2, name: 'chrome', desc: 'Google Chrome', cpu: 1, ws: 2e8, start: Date.now() - 3600e3 },
    { pid: 3, name: 'code', desc: 'Codex', cpu: 4, ws: 6e8, start: Date.now() - 7200e3 },
  ], {}, Date.now())
  exporter.appPaths = { 'Google Chrome': 'C:\\Chrome\\chrome.exe' }

  const apps = exporter.exportApps()
  equal('apps are grouped, not per-process', apps.rows.length, 2)
  // Two Chrome processes at 700 MB total outrank one Codex at 600 MB: the sort\n  // is by memory, and grouping is what makes that the right answer.\n  equal('the biggest application sorts first', apps.rows[0].app, 'Google Chrome')
  equal('process counts are folded in', apps.rows.find((row) => row.app === 'Google Chrome').processes, 2)
  equal('memory is summed across the group',
    apps.rows.find((row) => row.app === 'Google Chrome').memoryBytes, 7e8)
  check('the executable path is carried through',
    apps.rows.find((row) => row.app === 'Google Chrome').executablePath === 'C:\\Chrome\\chrome.exe')
  // A row missing a declared column renders as a silently empty CSV cell, which
  // is worse than a loud failure here.
  // Keys are not enough: a declared column whose value is never produced
  // exports as a silently empty column. Check that every column has a value in
  // at least one row.
  check('every row carries every declared column',
    apps.rows.every((row) => apps.columns.every((column) => column in row)))
  // Pinned, not inherited. These columns are filled from the disk counters, which
  // arrive from a child process — so leaving them to the environment made this
  // check pass or fail depending on whether the sampler happened to have produced
  // I/O yet. A test that reads the machine is a test that fails on someone else's.
  const stamps = exporter.series.map((point) => point.t)
  exporter.ioHistory = stamps.map((t) => ({ t, read: 1024, write: 512 }))
  exporter.latencyHistory = stamps.map((t) => ({ t, latencyMs: 0.4, queue: 0 }))

  const series = exporter.exportTable(60)
  check('a declared column is never wholly empty',
    series.columns.every((column) => series.rows.length === 0 || series.rows.some((row) => row[column] !== undefined && row[column] !== null && row[column] !== '')),
    series.columns.filter((column) => series.rows.length > 0 && !series.rows.some((row) => row[column] !== undefined && row[column] !== null && row[column] !== '')).join(', '))

  const bundle = exporter.exportBundle({ window: 60, detail: true })
  for (const key of ['bundle', 'revision', 'platform', 'capabilities', 'config', 'alertLog', 'summary', 'forecast', 'series', 'apps']) {
    check(`the bundle carries ${key}`, key in bundle)
  }
  check('the bundle names itself', bundle.bundle === 'dsh-system-monitor')
  check('the bundle reports a revision', Number.isFinite(bundle.revision))
  // A bundle that cannot round-trip is a bug report nobody can read.
  equal('the bundle round-trips', JSON.parse(JSON.stringify(bundle)).apps.length, bundle.apps.length)
  exporter.dispose()

  suite('export formats')
  const { toCsv, toNdjson } = await import('../monitor.js')
  const table = {
    columns: ['app', 'memoryBytes', 'note'],
    rows: [
      { app: 'Plain', memoryBytes: 1, note: null },
      { app: 'Has, comma', memoryBytes: 2, note: 'say "hi"' },
      { app: 'Has "quote"', memoryBytes: 3, note: 'line\nbreak' },
    ],
  }
  const csv = toCsv(table)
  const csvLines = csv.split('\n')
  equal('CSV starts with the header', csvLines[0], 'app,memoryBytes,note')
  // A comma or a quote inside a field silently shifts every later column unless
  // it is escaped — the classic way a CSV export is quietly wrong.
  check('a comma is quoted', csv.includes('"Has, comma"'))
  check('an embedded quote is doubled', csv.includes('"say ""hi"""'))
  check('a newline is quoted rather than emitted raw', csv.includes('"line\nbreak"'))
  check('an empty value stays empty', csvLines[1].endsWith(','))

  const rows = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]
  const ndjson = toNdjson(rows)
  const ndjsonLines = ndjson.split('\n')
  equal('NDJSON is one line per row', ndjsonLines.length, 2)
  check('every NDJSON line parses on its own', ndjsonLines.every((line) => {
    try { JSON.parse(line); return true } catch { return false }
  }))
  equal('NDJSON round-trips', JSON.parse(ndjsonLines[1]).b, 'y')

  // The property that makes NDJSON worth recommending: appending never disturbs
  // what is already on disk, and a torn write costs one line rather than the file.
  const appended = `${ndjson}\n${JSON.stringify({ a: 3, b: 'z' })}\ntorn{"a":`
  const survivor = appended.split('\n').filter((line) => { try { JSON.parse(line); return true } catch { return false } })
  equal('a torn append leaves the earlier rows intact', survivor.length, 3)

  suite('sampler script')
  // The PowerShell half is generated text inside a JavaScript template literal.
  // Nothing type-checks it, so every one of these has already shipped broken at
  // least once — a duplicate hash key that stopped the child dead, and a
  // command-line length ceiling that failed silently.
  const metricsSource = readFileSync(join(ROOT, 'metrics.js'), 'utf8')
  const marker = 'const LIVE_SCRIPT = String.raw`'
  const opened = metricsSource.indexOf(marker) + marker.length
  const script = metricsSource.slice(opened, metricsSource.indexOf('`', opened))
  check('the sampler script was located', script.length > 1000, `${script.length} chars`)

  // A backtick inside the script terminates the template literal and the whole
  // module stops parsing. This has happened.
  check('no stray backtick in the sampler script', !script.includes('`'))

  const opens = (script.match(/\{/g) ?? []).length
  const closes = (script.match(/\}/g) ?? []).length
  check('the sampler script has balanced braces', opens === closes, `${opens} open, ${closes} close`)

  // PowerShell rejects a duplicate key in a hash literal at PARSE time, so the
  // child never starts and every counter-backed panel goes unavailable.
  const initBlock = /\[ordered\]@\{([\s\S]*?)\n\}\)/.exec(script)?.[1] ?? ''
  const initKeys = [...initBlock.matchAll(/^\s{2}(\w+)\s*=/gm)].map((match) => match[1])
  const duplicates = initKeys.filter((key, index) => initKeys.indexOf(key) !== index)
  check('the init payload has no duplicate keys', duplicates.length === 0,
    duplicates.length > 0 ? `duplicated: ${[...new Set(duplicates)].join(', ')}` : `${initKeys.length} keys`)

  // The script used to travel as -EncodedCommand: base64 of UTF-16, 2.67 command
  // line characters per source character, against a hard Windows ceiling of
  // 32767. That is a ~12 KB script limit and it was crossed for real, at which
  // point spawn began failing with ENAMETOOLONG. It goes through a file now.
  check('the script is not passed on the command line',
    !/'-EncodedCommand'/.test(metricsSource) && !/ENCODED_LIVE_SCRIPT/.test(metricsSource))
  check('the script is written to a file and run with -File', /'-File', this\.scriptPath/.test(metricsSource))
  check('the script file is written with a BOM for PowerShell 5.1', /writeScript\(path, source\)/.test(metricsSource) && /\\uFEFF/.test(metricsSource))
  // Not a "still fits" assertion — the opposite. The script has outgrown the
  // command-line ceiling, which is precisely why it must travel as a file. If
  // this ever drops back under, the file route is still correct; if someone
  // reverts to -EncodedCommand while it is over, the spawn fails silently.
  const encodedLength = Math.round(script.length * 2.67)
  check('the script has outgrown the command-line ceiling', encodedLength > 32767,
    `${encodedLength} command-line chars vs a 32767 limit`)

  suite('per-process disk I/O')
  // Cumulative counters in, rates out — the sampler only visits this every thirty
  // seconds, and a rate sampled that rarely would describe one second in thirty.
  const disk = new SystemSampler({ config: {} })
  const t0 = Date.now()
  disk.updateDiskIo({ chrome: { read: 1000, write: 500 } }, t0)
  equal('the first reading has no rate', disk.diskIoRates.get('chrome').read, 0)

  disk.updateDiskIo({ chrome: { read: 31000, write: 2500 } }, t0 + 30000)
  equal('thirty seconds later the rate is per second', Math.round(disk.diskIoRates.get('chrome').read), 1000)
  equal('writes too', Math.round(disk.diskIoRates.get('chrome').write), 67) // 2000/30

  // A recycled PID or a restarted process goes backwards. That is not negative
  // traffic, and must not become a negative rate.
  disk.updateDiskIo({ chrome: { read: 10, write: 10 } }, t0 + 60000)
  equal('a counter reset yields no rate', disk.diskIoRates.get('chrome').read, 0)

  // An exited process must not leave its baseline behind for a long session.
  disk.updateDiskIo({ firefox: { read: 5, write: 5 } }, t0 + 90000)
  check('an exited process is forgotten', !disk.diskIoSeen.has('chrome'))
  check('and the new one is tracked', disk.diskIoSeen.has('firefox'))

  // Rates reach the application rows, which is where they are shown.
  disk.diskIoRates = new Map([['chrome', { read: 2048, write: 1024 }]])
  disk.ingestProcesses([
    { pid: 1, name: 'chrome', desc: 'Google Chrome', cpu: 1, ws: 1e8, start: null },
    { pid: 2, name: 'chrome', desc: 'Google Chrome', cpu: 1, ws: 1e8, start: null },
  ], {}, Date.now())
  equal('per-process rates reach the process rows', disk.processes[0].diskRead, 2048)
  equal('and are summed per application', disk.appTotals.get('Google Chrome').diskRead, 4096)
  const withDisk = disk.exportApps()
  check('the export carries the disk columns', withDisk.columns.includes('diskReadBps') && withDisk.columns.includes('diskWriteBps'))
  equal('with the summed value', withDisk.rows[0].diskReadBps, 4096)
  disk.dispose()

  suite('on-disk history')
  // Bounded, or it is a bug. A monitor that silently fills a disk is worse than
  // one with no history, so retention and the append path are both asserted.
  equal('history retention has a default', resolveConfig({}).historyDays, 7)
  equal('zero disables it', resolveConfig({ historyDays: 0 }).historyDays, 0)
  equal('a negative value disables it too', resolveConfig({ historyDays: -3 }).historyDays, 0)
  equal('nonsense falls back to the default', resolveConfig({ historyDays: 'abc' }).historyDays, 7)
  equal('and the ceiling is a year', resolveConfig({ historyDays: 99999 }).historyDays, 365)

  const historian = new SystemSampler({ config: { historyDays: 7 } })
  historian.recordHistory(Date.now())
  check('a sample is buffered', historian.historyBuffer.length === 1)
  check('and the line is one JSON object', (() => {
    try { JSON.parse(historian.historyBuffer[0]); return true } catch { return false }
  })())
  // Buffered, not written on arrival: a flush every thirty seconds, not every
  // second. A second sample inside that window must not trigger one.
  const flushMark = historian.historyAt
  historian.recordHistory(Date.now())
  check('a second sample inside the window buffers too', historian.historyBuffer.length === 2)
  equal('and neither triggered a flush', historian.historyAt, flushMark)
  // Past the window it flushes, and drains.
  historian.recordHistory(flushMark + 31000)
  equal('past the window the buffer drains', historian.historyBuffer.length, 0)
  check('and the flush time advances', historian.historyAt > flushMark)

  // Disabled means no buffer at all, not a buffer that never flushes.
  const quiet = new SystemSampler({ config: { historyDays: 0 } })
  quiet.recordHistory(Date.now())
  equal('a disabled history buffers nothing', quiet.historyBuffer.length, 0)

  // Pruning is a date comparison over the day files, and must ignore anything
  // that is not one.
  const stale = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)
  const fresh = new Date().toISOString().slice(0, 10)
  check('an old day file is past the cutoff', Date.parse(`${stale}T00:00:00Z`) < Date.now() - 7 * 86400000)
  check('today is not', Date.parse(`${fresh}T00:00:00Z`) >= Date.now() - 7 * 86400000)
  check('the day pattern only matches day files', /^(\d{4})-(\d{2})-(\d{2})\.ndjson$/.test(`${fresh}.ndjson`)
    && !/^(\d{4})-(\d{2})-(\d{2})\.ndjson$/.test('state.json'))
  historian.dispose()
  quiet.dispose()

  suite('collector faults')
  // A sampler that cannot start is not a resource reading, but it is the most
  // important thing this plugin can report: every counter-backed panel loses its
  // data when it happens. It rides the existing alert channel rather than
  // inventing a second one.
  const faulty = new SystemSampler({ config: { alertSustainSeconds: 0 } })
  equal('a healthy sampler raises no fault', faulty.alerts().reasons.length, 0)

  faulty.noteSamplerFault('spawn-failed')
  const raised = faulty.alerts()
  equal('a fault is reported as an alert', raised.level, 'warn')
  equal('and it names the sampler', raised.reasons[0].key, 'sampler')
  equal('carrying a code rather than a percentage', raised.reasons[0].value, null)
  equal('with the code as its detail', raised.reasons[0].detail, 'spawn-failed')

  // Reported once. An alert that repeats every tick is noise, and noise is how a
  // real alert gets ignored.
  equal('it is announced once, not every tick', faulty.alerts().reasons.length, 0)

  faulty.clearSamplerFault()
  equal('a sample clears it', faulty.alerts().reasons.length, 0)
  equal('and the alert settles back to clear', faulty.alerts().level, 'none')

  faulty.dispose()

  suite('alert delivery')
  const events = []
  const watcher = new SystemSampler({
    config: { alertSustainSeconds: 0, alertCpu: 60 },
    onAlert: (next, previous, reasons) => events.push(`${previous}->${next}(${reasons.length})`),
  })
  // The starting level is *restored from the persisted alert log*, so on a machine
  // that has lately been under memory pressure the sampler begins at "warn" and
  // the opening transition is not the one this test is about. Reset both the
  // level and the resources it is computed from, so only the CPU moves.
  watcher.lastAlertLevel = 'none'
  watcher.cpuUsage = 5
  watcher.memory.usage = 0
  for (const disk of watcher.disks) disk.usage = 0

  watcher.cpuUsage = 90
  watcher.alerts()
  watcher.alerts()
  watcher.cpuUsage = 5
  watcher.alerts()
  equal('only transitions are delivered', events.join(','), 'none->high(1),high->none(0)')

  // A listener that throws must not be able to stop the sampler.
  const thrower = new SystemSampler({
    config: { alertSustainSeconds: 0, alertCpu: 60 },
    onAlert: () => { throw new Error('listener bug') },
  })
  thrower.cpuUsage = 90
  let survived = true
  try { thrower.alerts() } catch { survived = false }
  check('a throwing listener cannot break sampling', survived)

  // Logging is the only channel that survives having no browser open, so it has
  // to work on every logger shape and on none at all.
  const lines = []
  const logger = { warn: (m) => lines.push(`warn:${m}`), info: (m) => lines.push(`info:${m}`) }
  const speaking = new SystemSampler({ config: {}, logger })
  speaking.log('warn', 'hello')
  speaking.log('nonsense', 'fallback')
  equal('log routes by level and falls back', lines.join(','), 'warn:hello,info:fallback')
  let safe = true
  try {
    new SystemSampler({ config: {} }).log('warn', 'no logger')
    new SystemSampler({ config: {}, logger: {} }).log('warn', 'empty logger')
    new SystemSampler({ config: {}, logger: { warn() { throw new Error('logger down') } } }).log('warn', 'throwing logger')
  } catch { safe = false }
  check('logging is safe without a usable logger', safe)

  for (const instance of [sampler, alerts, pressure, clock, rates, stopper, writer, watcher, thrower, speaking]) {
    instance.dispose()
  }
}
