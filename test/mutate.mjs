/**
 * Mutation check: break the code on purpose and confirm the suite notices.
 *
 * A green suite means nothing until it has been shown to go red. Each mutation
 * below reintroduces a bug that shipped, or a plausible one next door to it.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

const mutations = [
  {
    label: 'unguarded data access on the first render',
    file: 'client.js',
    from: 'healthSentence(data?.health, data?.bottleneck)',
    to: 'healthSentence(data.health, data.bottleneck)',
    expect: 'first render (data null)',
  },
  {
    label: 'client module id drifts from the package name',
    file: 'client.js',
    from: "id: 'dsh-system-monitor',",
    to: "id: 'some-other-name',",
    expect: 'client.js module id matches package name',
  },
  {
    label: 'chart loses its time axis',
    file: 'client.js',
    from: "h('div', { className: 'dsm-chartTicks' }",
    to: "h('div', { className: 'dsm-chartTicksDisabled' }",
    expect: 'chart draws time-axis ticks',
  },
  {
    label: 'a partial payload is trusted',
    file: 'client.js',
    from: 'Array.isArray(cpu.history) ? cpu.history : []',
    to: 'cpu.history',
    expect: 'partial payload',
  },
  {
    label: 'the export entry navigates instead of saving',
    file: 'client.js',
    from: "                    className: 'dsm-exportLink',\n                    disabled: exportBusy,",
    to: "                    className: 'dsm-exportLink',\n                    href: exportUrl(format, range, 'series'),\n                    disabled: exportBusy,",
    expect: 'and none carries an export href',
  },
  {
    label: 'a cancelled save is reported as an error',
    file: 'client.js',
    from: '                      if (result.cancelled) return',
    to: '                      if (false) return',
    expect: 'a cancelled save is not reported as a failure',
  },
  {
    label: 'the save dialog is skipped entirely',
    file: 'client.js',
    from: "      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {",
    to: '      if (false) {',
    expect: 'clicking a format raises the system dialog',
  },
  {
    label: 'a stale Host is no longer announced',
    file: 'client.js',
    from: 'const staleHost = data !== null && effectiveProtocol < REQUIRED_PROTOCOL',
    to: 'const staleHost = false',
    expect: 'a stale Host is announced',
  },
  {
    label: 'the protocol is not sent by the Host',
    file: 'metrics.js',
    from: '      protocol: SAMPLER_PROTOCOL,',
    to: '',
    expect: 'the Host declares its protocol',
  },
  {
    label: 'history retention is unbounded',
    file: 'metrics.js',
    from: '      return Math.min(365, Math.round(raw))',
    to: '      return Math.round(raw)',
    expect: 'and the ceiling is a year',
  },
  {
    label: 'the history buffer never flushes',
    file: 'metrics.js',
    from: '    if (now - this.historyAt < HISTORY_FLUSH_MS) return',
    to: '    return',
    expect: 'past the window the buffer drains',
  },
  {
    label: 'a comma in a CSV field is left unescaped',
    file: 'monitor.js',
    from: '  return /[",\\n]/.test(text) ? `"${text.replace(/"/g, \'""\')}"` : text',
    to: '  return text',
    expect: 'a comma is quoted',
  },
  {
    label: 'an uninjected service is touched during apply',
    file: 'client.js',
    from: '        // Opening the panel is resolved lazily rather than during apply.',
    to: '        const eager = ctx.layout\n        // Opening the panel is resolved lazily rather than during apply.',
    expect: 'apply survives a hostile activation',
  },
  {
    label: 'the forecast ignores its minimum baseline',
    file: 'metrics.js',
    from: 'if (spanMs >= DISK_FORECAST_MIN_MS && slope < 0) {',
    to: 'if (slope < 0) {',
    expect: 'a baseline under the floor projects nothing',
  },
  {
    label: 'the alert log is unbounded',
    file: 'metrics.js',
    from: 'if (this.alertLog.length > ALERT_LOG_LIMIT) {',
    to: 'if (false) {',
    expect: 'the alert log is bounded',
  },
]

let caught = 0
const report = join(tmpdir(), `dsm-mutation-${process.pid}.json`)

for (const mutation of mutations) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(mutation.from)) {
    console.log(`  SKIP    ${mutation.label} — anchor not found`)
    continue
  }
  writeFileSync(path, original.replace(mutation.from, mutation.to))
  // stdout is deliberately not piped: a confined environment can refuse to give
  // a child process a pipe, which would silently turn every result into a miss.
  // The child reports through a file instead.
  try {
    rmSync(report, { force: true })
  } catch { /* nothing to remove */ }
  try {
    execFileSync(NODE, [join(ROOT, 'test', 'run.mjs')], {
      stdio: 'ignore',
      env: { ...process.env, DSM_TEST_REPORT: report },
    })
  } catch {
    // A non-zero exit is the expected outcome for a detected mutation.
  }
  writeFileSync(path, original)

  let failures = []
  try {
    failures = JSON.parse(readFileSync(report, 'utf8')).failures ?? []
  } catch {
    failures = []
  }
  const detects = failures.includes(mutation.expect)
  if (detects) caught += 1
  console.log(`  ${detects ? 'CAUGHT ' : 'MISSED '} ${mutation.label}${detects ? '' : ` — wanted a failure named "${mutation.expect}", got ${JSON.stringify(failures.slice(0, 3))}`}`)
}

try {
  rmSync(report, { force: true })
} catch { /* nothing to remove */ }

console.log(`\n${caught}/${mutations.length} mutations caught`)
process.exit(caught === mutations.length ? 0 : 1)
