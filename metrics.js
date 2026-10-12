/**
 * Host-side metric collection for the system-monitor plugin.
 *
 * CPU, memory and disk capacities come straight from Node built-ins (`node:os`,
 * `node:fs.statfs`) because they are cheap and never block. Everything Windows
 * only exposes through performance counters or the process table — GPU
 * utilisation, per-process CPU/memory/GPU, and physical-disk throughput — comes
 * from ONE long-lived PowerShell child that streams a compact JSON line per
 * sample. That child runs only while a browser is polling, so an unopened panel
 * costs nothing.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

/** Host-side sampling cadence for the Node-native metrics. */
const SAMPLE_MS = 1000
/** How many samples the aligned chart series keeps: thirty minutes at 1 Hz. */
const SERIES_LIMIT = 10800
/** How many samples the per-card sparklines keep. */
const SPARK_LIMIT = 60
/** How many per-core samples feed the heatmap; the Client draws the last 40. */
const CORE_LIMIT = 240
/** Columns of per-core history the client draws. */
const CORE_COLUMNS = 40
/** How many samples the disk throughput and latency series keep. */
const IO_LIMIT = 3600
/** The windows a client may ask for, in seconds. */
const WINDOWS = [60, 300, 1800]
/** Offered as presets; any value up to {@link SERIES_LIMIT} is accepted. */
/** Points a windowed series is reduced to, so a long window stays a small payload. */
const WINDOW_POINTS = 180
/** How often the mounted-volume list is re-scanned. */
const MOUNT_RESCAN_MS = 20000
/** The live sampler stops after this long with no client request. */
/** A sampler that has not been looked at for this long drops to the warm rate. */
const RATE_ACTIVE_MS = 15000
/** After this long with no viewer it drops to the cold rate. */
const RATE_WARM_MS = 600000
/** Sampler loop multipliers: active, warm, and the configured cold cadence. */
const RATE_ACTIVE = 1
const RATE_WARM = 4
/** Delay before restarting a failed live sampler. */
const LIVE_RESTART_MS = 10000
/** Consecutive live-sampler failures tolerated before it is given up on. */
const LIVE_MAX_ATTEMPTS = 5
/** A child that never reports anything within this window is considered stuck. */
const LIVE_FIRST_MESSAGE_MS = 20000
/** Most applications one icon-extraction batch covers. */
const ICON_MAX_APPS = 140
/** Minimum gap between icon-extraction attempts, so a failure cannot spin. */
const ICON_RETRY_MS = 60000
/** An extraction batch that runs longer than this is killed. */
const ICON_TIMEOUT_MS = 30000
/**
 * Sustained-load thresholds for the sidebar badge, in percent. Memory sits near
 * 80% on a healthy Windows machine because of caching, so its threshold is
 * deliberately above the point where that alone would raise an alarm.
 */
const DEFAULT_CONFIG = {
  alertCpu: 85,
  alertMemory: 92,
  alertGpu: 95,
  alertDisk: 92,
  alertSustainSeconds: 5,
  showGpu: true,
  showClock: true,
  showDiskThroughput: true,
  showIcons: true,
  showProcesses: true,
  persist: true,
  idleSamplingSeconds: 20,
  historyDays: 7,
  showProcessDisk: true,
}

/**
 * Merge a loader row's `config` over the defaults.
 *
 * Every number is clamped, so a typo in `cordis.patch.yml` can make a threshold
 * odd but can never disable the sampler or wedge the page. This runs without a
 * schema on purpose: `@deepseek-ai/schemastery` resolves from a published
 * install but not from a linked development bundle, so the plugin has to be
 * correct with or without it.
 *
 * @param raw - the row's config object, or anything else.
 * @returns the effective config, with every key present.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bounded = (key, fallback, min, max) => {
    const value = Number(source[key])
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const flag = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback)
  return {
    alertCpu: Math.round(bounded('alertCpu', DEFAULT_CONFIG.alertCpu, 10, 100)),
    alertMemory: Math.round(bounded('alertMemory', DEFAULT_CONFIG.alertMemory, 10, 100)),
    alertGpu: Math.round(bounded('alertGpu', DEFAULT_CONFIG.alertGpu, 10, 100)),
    alertDisk: Math.round(bounded('alertDisk', DEFAULT_CONFIG.alertDisk, 10, 100)),
    alertSustainSeconds: Math.round(bounded('alertSustainSeconds', DEFAULT_CONFIG.alertSustainSeconds, 0, 600)),
    showGpu: flag('showGpu', DEFAULT_CONFIG.showGpu),
    showClock: flag('showClock', DEFAULT_CONFIG.showClock),
    showDiskThroughput: flag('showDiskThroughput', DEFAULT_CONFIG.showDiskThroughput),
    showIcons: flag('showIcons', DEFAULT_CONFIG.showIcons),
    showProcesses: flag('showProcesses', DEFAULT_CONFIG.showProcesses),
    persist: flag('persist', DEFAULT_CONFIG.persist),
    // 0 is a meaningful choice here (stop when idle), so it must survive clamping.
    // 0 disables the on-disk history entirely; the ceiling is a year because an
    // unbounded retention setting is a disk-filling bug waiting to happen.
    showProcessDisk: flag('showProcessDisk', DEFAULT_CONFIG.showProcessDisk),
    historyDays: (() => {
      const raw = Number(source.historyDays)
      if (!Number.isFinite(raw)) return DEFAULT_CONFIG.historyDays
      if (raw <= 0) return 0
      return Math.min(365, Math.round(raw))
    })(),
    idleSamplingSeconds: (() => {
      const raw = Number(source.idleSamplingSeconds)
      if (!Number.isFinite(raw)) return DEFAULT_CONFIG.idleSamplingSeconds
      if (raw <= 0) return 0
      return Math.min(300, Math.max(2, Math.round(raw)))
    })(),
  }
}

/** How far past a threshold a reading must go before it counts as critical. */
const ALERT_HIGH_MARGIN = 5
/** A resource this close to its threshold reads as "busy" rather than "fine". */
const BUSY_RATIO = 0.85
/**
 * What counts as saturated for the bottleneck comparison. CPU and memory are
 * percentages; disk is latency and queue depth, because a full disk is not a
 * slow one.
 */
const SATURATION = { cpu: 90, memory: 95, gpu: 95, latencySec: 0.05, queue: 4 }
/** Below this pressure nothing is worth calling a bottleneck. */
const BOTTLENECK_FLOOR = 0.6
/** A clock this far under nominal, while busy, reads as throttling. */
const THROTTLE_RATIO = 0.85
/** Below this load the CPU is idle and low clocks mean nothing. */
const THROTTLE_MIN_LOAD = 45
/** Alert transitions retained for the timeline. */
const ALERT_LOG_LIMIT = 40
/** How often the per-application memory baseline is captured. */
const APP_MEMORY_INTERVAL_MS = 30000
/** How many baselines are kept; 20 × 30 s covers ten minutes. */
const APP_MEMORY_SAMPLES = 20
/** The span growth is measured over, when enough history exists. */
const APP_GROWTH_WINDOW_MS = 300000
/** Movement smaller than this is noise, not a trend. */
const APP_GROWTH_FLOOR = 8 * 1024 * 1024
/** Applications listed in the growth ranking. */
const APP_GROWTH_ROWS = 12
/** How often the slow-moving series behind the forecasts are sampled. */
const FORECAST_INTERVAL_MS = 60000
/** How many forecast samples are kept; 60 × 60 s is one hour. */
const FORECAST_SAMPLES = 60
/** Memory moves fast enough to project from five minutes. */
const MEMORY_FORECAST_MIN_MS = 300000
/** Disk free space moves slowly, so it needs a longer baseline to mean anything. */
const DISK_FORECAST_MIN_MS = 600000
/** A projection beyond this is not worth stating. */
const FORECAST_MAX_DAYS = 3650
/** Minimum gap between state writes. */
const PERSIST_INTERVAL_MS = 60000

/**
 * Least-squares slope of a series, in units per second.
 * @param points - `{ t, y }` samples in ascending time order.
 * @returns the slope, or 0 when it is not defined.
 */
function slopePerSecond(points) {
  const count = points.length
  if (count < 2) return 0
  const origin = points[0].t
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const point of points) {
    const x = (point.t - origin) / 1000
    sumX += x
    sumY += point.y
    sumXY += x * point.y
    sumXX += x * x
  }
  const denominator = count * sumXX - sumX * sumX
  if (denominator === 0) return 0
  return (count * sumXY - sumX * sumY) / denominator
}
/** Bumped whenever the payload shape or collection logic changes. */
/**
 * Wire-contract version between the two halves of this bundle.
 *
 * Bump it when the payload's *shape* changes incompatibly — a renamed field, a
 * changed unit, a removed key. Not for a bug fix: the point is to let a Client
 * detect a Host that predates it and say so, instead of failing in whatever
 * creative way the mismatch happens to produce.
 *
 * This exists because of a real afternoon. The Client can be rebuilt and served
 * by the page in seconds, but the Host module lives in the process until DSH is
 * restarted — so the two drift apart routinely during development, and the
 * symptoms (a blank window, a vanished panel, an empty export) never point at
 * the cause.
 */
const SAMPLER_PROTOCOL = 1
const SAMPLER_REVISION = 29

/**
 * Interpreters tried in order. Bare names come first so the machine's own PATH
 * decides, and the absolute paths guarantee a PowerShell exists even when the
 * Host process inherited no interactive PATH. Nothing is filtered by
 * `existsSync`: the MSIX `pwsh` alias is a reparse point that reports absent, so
 * a probe would silently discard a working interpreter. An interpreter that
 * cannot start fails fast and the next candidate is tried immediately.
 */
const GPU_INTERPRETERS = [
  'pwsh',
  'powershell',
  `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`,
  `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WindowsApps\\pwsh.exe`,
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
].filter((candidate) => candidate !== '')

/**
 * The live sampler, run as a persistent PowerShell child. It announces its own
 * capabilities once (`init`) and then emits one `sample` line per iteration
 * carrying GPU counters, physical-disk throughput and the process table.
 * The script travels as a BOM-prefixed temp file passed to `-File`: the command-line
 * form has a hard length ceiling that this script has already outgrown. All output is
 * ASCII-escaped so the parent can always parse it as UTF-8.
 *
 * Process CPU is reported as cumulative processor SECONDS; the Node half turns
 * that into a percentage, because only it knows the wall-clock delta.
 */
const LIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Escape every non-ASCII code unit so the parent always reads pure UTF-8 text,
# using only constructs that behave identically on Windows PowerShell 5.1 and 7.
function ConvertTo-AsciiJson($payload) {
  $text = $payload | ConvertTo-Json -Compress -Depth 8
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $text.ToCharArray()) {
    $code = [int]$character
    if ($code -lt 128) { [void]$builder.Append($character) }
    else { [void]$builder.AppendFormat('\u{0:x4}', $code) }
  }
  return $builder.ToString()
}

function Send-Json($payload) {
  [Console]::Out.WriteLine((ConvertTo-AsciiJson $payload))
  [Console]::Out.Flush()
}

# A CounterSet's .Counter entries are full paths on both PowerShell 5.1 and 7;
# accept a bare counter name as well so an unexpected shape cannot disable a probe.
function Test-Counter($set, $suffix) {
  foreach ($path in @($set.Counter)) {
    if ($path -eq $suffix) { return $true }
    if ($path -like "*\$suffix") { return $true }
  }
  return $false
}

$adapters = @()
try {
  $entries = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*' -ErrorAction SilentlyContinue
  foreach ($entry in $entries) {
    if (-not $entry.DriverDesc) { continue }
    $vram = 0
    if ($entry.'HardwareInformation.qwMemorySize') { $vram = [long]$entry.'HardwareInformation.qwMemorySize' }
    $adapters += [ordered]@{ name = [string]$entry.DriverDesc; driver = [string]$entry.DriverVersion; memory = $vram }
  }
} catch { }

$paths = @()
$hasEngine = $false
$hasPhysical = $false
$hasLatency = $false
$hasFrequency = $false
$memCounters = @()
$probeFailed = $false
try {
  $engineSet = Get-Counter -ListSet 'GPU Engine' -ErrorAction Stop
  if (Test-Counter $engineSet 'Utilization Percentage') {
    $paths += '\GPU Engine(*)\Utilization Percentage'
    $hasEngine = $true
  }
} catch { $probeFailed = $true }
try {
  $memorySet = Get-Counter -ListSet 'GPU Adapter Memory' -ErrorAction Stop
  foreach ($name in @('Dedicated Usage', 'Shared Usage')) {
    if (Test-Counter $memorySet $name) {
      $paths += ('\GPU Adapter Memory(*)\' + $name)
      $memCounters += $name
    }
  }
} catch { $probeFailed = $true }
try {
  $diskSet = Get-Counter -ListSet 'PhysicalDisk' -ErrorAction Stop
  foreach ($name in @('Disk Read Bytes/sec', 'Disk Write Bytes/sec')) {
    if (Test-Counter $diskSet $name) {
      $paths += ('\PhysicalDisk(*)\' + $name)
      $hasPhysical = $true
    }
  }
  # Latency and queue length say whether a disk is actually struggling; throughput
  # alone cannot, because a busy disk and an idle one can move the same bytes.
  foreach ($name in @('Avg. Disk sec/Transfer', 'Current Disk Queue Length', 'Disk Transfers/sec')) {
    if (Test-Counter $diskSet $name) {
      $paths += ('\PhysicalDisk(*)\' + $name)
      $hasLatency = $true
    }
  }
} catch { }

# Single-instance counters carrying the machine-level picture: real clock speed
# (nominal times turbo ratio) and the memory composition behind one percentage.
try {
  $cpuSet = Get-Counter -ListSet 'Processor Information' -ErrorAction Stop
  if (Test-Counter $cpuSet '% Processor Performance') {
    $paths += '\Processor Information(_Total)\% Processor Performance'
  }
  if (Test-Counter $cpuSet 'Processor Frequency') {
    $paths += '\Processor Information(_Total)\Processor Frequency'
    $hasFrequency = $true
  }
} catch { }
try {
  $sysSet = Get-Counter -ListSet 'Memory' -ErrorAction Stop
  foreach ($name in @('Available MBytes', 'Committed Bytes', 'Commit Limit', 'Standby Cache Normal Priority Bytes')) {
    if (Test-Counter $sysSet $name) { $paths += ('\Memory\' + $name) }
  }
} catch { }
try {
  $pageSet = Get-Counter -ListSet 'Paging File' -ErrorAction Stop
  if (Test-Counter $pageSet '% Usage') { $paths += '\Paging File(_Total)\% Usage' }
} catch { }

# Nothing was learned from the probes: try the well-known GPU paths and let the
# sampling loop report the truth instead of declaring the GPU unsupported.
$guessed = $false
if ($paths.Count -eq 0 -and $probeFailed) {
  $paths = @('\GPU Engine(*)\Utilization Percentage', '\GPU Adapter Memory(*)\Dedicated Usage')
  $hasEngine = $true
  $memCounters = @('Dedicated Usage')
  $guessed = $true
}

Send-Json ([ordered]@{
  type = 'init'
  pid = $PID
  psVersion = $PSVersionTable.PSVersion.ToString()
  hasEngine = $hasEngine
  hasPhysical = $hasPhysical
  hasLatency = $hasLatency
  hasFrequency = $hasFrequency
  guessed = $guessed
  memCounters = @($memCounters)
  adapters = @($adapters)
  pathCount = $paths.Count
})

$failures = 0
# Battery is polled far less often than everything else: it is a CIM query, it is
# slow, and it changes on a scale of minutes. It is also probed here rather than
# at init so a machine where CIM is unavailable cannot delay the first sample.
# Per-process disk I/O is polled on its own slower clock: a counter object per
# process name is not free, and disk attribution changes on a scale of minutes.
$diskIoEvery = 30
$diskIoTick = 1
$diskIoSample = [ordered]@{ }
$batteryState = 'unknown'
$battery = $null
$tick = 0
# The Host writes a loop multiplier here; 1 means "sample every pass". Re-reading
# a small file is far cheaper than restarting the child to change its cadence.
$rateFile = [string]$env:DSM_RATE_FILE
$rate = 1
while ($true) {
  $tick = $tick + 1
  if ($rateFile -ne '') {
    try {
      $parsed = 0
      $raw = [string](Get-Content -LiteralPath $rateFile -Raw -ErrorAction Stop)
      if ([int]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 600) {
        $rate = $parsed
      }
    } catch { }
  }
  $util = $null
  $dedicated = $null
  $shared = $null
  $engines = [ordered]@{}
  $gpuByPid = [ordered]@{}
  $physical = @()
  $system = [ordered]@{}

  if ($tick % 6 -eq 1) {
    try {
      $cell = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop | Select-Object -First 1
      if ($null -eq $cell) {
        $batteryState = 'absent'
        $battery = $null
      } else {
        $batteryState = 'present'
        $battery = [ordered]@{
          percent = [int]$cell.EstimatedChargeRemaining
          status = [int]$cell.BatteryStatus
          minutes = [int]$cell.EstimatedRunTime
        }
      }
    } catch {
      $batteryState = 'absent'
      $battery = $null
    }
  }

  if ($paths.Count -gt 0) {
    try {
      $set = Get-Counter -Counter $paths -MaxSamples 1 -ErrorAction Stop
      $failures = 0
      $byEngine = @{}
      $byPid = @{}
      $dedicatedTotal = [double]0
      $sharedTotal = [double]0
      $disks = @{}
      foreach ($sample in $set.CounterSamples) {
        $path = ([string]$sample.Path).ToLowerInvariant()
        $value = [double]$sample.CookedValue
        $instance = [string]$sample.InstanceName
        if ($path -like '*gpu engine*') {
          $owner = $null
          if ($instance -match '^pid_(\d+)_') { $owner = $Matches[1] }
          if ($instance -match 'engtype_(.+)$') {
            $type = $Matches[1]
            if ($byEngine.ContainsKey($type)) { $byEngine[$type] = $byEngine[$type] + $value }
            else { $byEngine[$type] = $value }
            if ($owner -ne $null) {
              if ($byPid.ContainsKey($owner)) {
                if ($value -gt $byPid[$owner]) { $byPid[$owner] = $value }
              } else { $byPid[$owner] = $value }
            }
          }
        }
        elseif ($path -like '*dedicated usage*') { $dedicatedTotal += $value }
        elseif ($path -like '*shared usage*') { $sharedTotal += $value }
        elseif ($path -like '*physicaldisk*') {
          if ($instance -ne '_total') {
            if (-not $disks.ContainsKey($instance)) {
              $disks[$instance] = @{
                name = $instance; read = [double]0; write = [double]0
                latency = [double]0; queue = [double]0; transfers = [double]0
                hasLatency = $false
              }
            }
            if ($path -like '*read bytes*') { $disks[$instance].read = $disks[$instance].read + $value }
            elseif ($path -like '*write bytes*') { $disks[$instance].write = $disks[$instance].write + $value }
            elseif ($path -like '*sec/transfer*') { $disks[$instance].latency = $value; $disks[$instance].hasLatency = $true }
            elseif ($path -like '*queue length*') { $disks[$instance].queue = $value }
            elseif ($path -like '*transfers/sec*') { $disks[$instance].transfers = $value }
          }
        }
        elseif ($path -like '*processor performance*') { $system['cpuPerformancePct'] = $value }
        elseif ($path -like '*processor frequency*') { $system['cpuNominalMhz'] = $value }
        elseif ($path -like '*available mbytes*') { $system['availableMb'] = $value }
        elseif ($path -like '*committed bytes*') { $system['committedBytes'] = $value }
        elseif ($path -like '*commit limit*') { $system['commitLimitBytes'] = $value }
        elseif ($path -like '*standby cache*') { $system['standbyBytes'] = $value }
        elseif ($path -like '*paging file*') { $system['pageFilePct'] = $value }
      }
      $peak = [double]0
      foreach ($key in $byEngine.Keys) { if ($byEngine[$key] -gt $peak) { $peak = $byEngine[$key] } }
      foreach ($key in ($byEngine.Keys | Sort-Object)) { $engines[$key] = [math]::Round($byEngine[$key], 1) }
      foreach ($key in ($byPid.Keys | Sort-Object)) { $gpuByPid[$key] = [math]::Round($byPid[$key], 1) }
      $util = [math]::Round($peak, 1)
      $dedicated = [long]$dedicatedTotal
      $shared = [long]$sharedTotal
      $physical = @($disks.Values)
    } catch {
      $failures = $failures + 1
      Send-Json ([ordered]@{
        type = 'error'
        t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        message = [string]$_.Exception.Message
      })
      if ($failures -ge 4) {
        $paths = @()
        $failures = 0
        Send-Json ([ordered]@{ type = 'counters-off' })
      }
    }
  }

  # Per-process CPU seconds, working set and friendly application name.
  $procs = @()
  $apps = @{}
  $procNames = @{}
  foreach ($item in @(Get-Process -ErrorAction SilentlyContinue)) {
    try { $procNames[[string]$item.ProcessName] = $true } catch { }
    $description = ''
    try { $description = [string]$item.Description } catch { }
    $cpuSeconds = [double]0
    try { $cpuSeconds = [double]$item.TotalProcessorTime.TotalSeconds } catch { }
    $workingSet = [long]0
    try { $workingSet = [long]$item.WorkingSet64 } catch { }
    $executable = ''
    try { $executable = [string]$item.Path } catch { }
    # Start time throws for protected processes, so a missing value is normal.
    $startedAt = [long]0
    try { $startedAt = [long]([DateTimeOffset]$item.StartTime).ToUnixTimeMilliseconds() } catch { }
    $procs += [ordered]@{
      pid = [int]$item.Id
      name = [string]$item.ProcessName
      desc = $description
      cpu = [math]::Round($cpuSeconds, 3)
      ws = $workingSet
      start = $startedAt
    }
    # One executable per application label: the largest process owns it, because
    # launchers and crash handlers often share a name with a smaller image.
    if ($executable -ne '') {
      $label = $description
      if ($label -eq '') { $label = [string]$item.ProcessName }
      $known = $apps[$label]
      if ($null -eq $known -or $workingSet -gt $known.ws) {
        $apps[$label] = @{ path = $executable; ws = $workingSet }
      }
    }
  }
  $appPaths = [ordered]@{}
  foreach ($label in $apps.Keys) { $appPaths[$label] = $apps[$label].path }

  # Per-process disk I/O, throttled hard.
  #
  # The IO Read Bytes/sec counter is a *rate*, and a rate sampled once every
  # thirty seconds describes the second it was sampled in — not the thirty. So
  # this reads RawValue, which is the cumulative byte count, and lets the Node
  # half difference it: correct at any cadence, the same lesson the network
  # source taught.
  #
  # It is throttled because a PerformanceCounter per process name is not free,
  # and because disk attribution changes slowly. Measured at ~11 ms for eight
  # names, so a sixty-name machine costs well under a tenth of a second every
  # thirty seconds.
  if ($diskIoTick -le 0) {
    $diskIo = [ordered]@{}
    foreach ($name in $procNames.Keys) {
      try {
        $readCounter = New-Object System.Diagnostics.PerformanceCounter('Process', 'IO Read Bytes/sec', $name, $true)
        $writeCounter = New-Object System.Diagnostics.PerformanceCounter('Process', 'IO Write Bytes/sec', $name, $true)
        [void]$readCounter.NextValue()
        [void]$writeCounter.NextValue()
        $diskIo[$name] = @{ read = [long]$readCounter.RawValue; write = [long]$writeCounter.RawValue }
        $readCounter.Dispose()
        $writeCounter.Dispose()
      } catch { }
    }
    $diskIoSample = $diskIo
    $diskIoTick = $diskIoEvery
  }
  $diskIoTick = $diskIoTick - 1

  Send-Json ([ordered]@{
    type = 'sample'
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    util = $util
    dedicated = $dedicated
    shared = $shared
    engines = $engines
    gpuByPid = $gpuByPid
    physical = @($physical)
    procs = @($procs)
    appPaths = $appPaths
    diskIo = $diskIoSample
    system = $system
    batteryState = $batteryState
    battery = $battery
  })

  # The rate is a target period in seconds. Roughly a second of it is already
  # spent inside Get-Counter waiting on its PDH interval, so only the rest is
  # slept; at rate 1 this is the original 400 ms.
  #
  # It is slept in one-second chunks that re-read the rate file, because one long
  # sleep cannot hear a panel open. At the 20 s cadence that is up to 20 s of a
  # stale number, and it lands exactly when someone has just opened the panel to
  # look at it. Re-reading a two-byte file costs nothing next to Get-Counter.
  $target = [math]::Max(400, ($rate * 1000) - 1000)
  $slept = 0
  while ($slept -lt $target) {
    $chunk = [math]::Min(1000, $target - $slept)
    Start-Sleep -Milliseconds $chunk
    $slept = $slept + $chunk
    if ($rateFile -eq '') { continue }
    try {
      $parsed = 0
      $probe = [string](Get-Content -LiteralPath $rateFile -Raw -ErrorAction Stop)
      if ([int]::TryParse($probe.Trim(), [ref]$parsed) -and $parsed -ge 1 -and $parsed -lt $rate) {
        # Someone started watching: stop waiting and sample now.
        $rate = $parsed
        break
      }
    } catch { }
  }
}
`

/**
 * Write a PowerShell script somewhere the child can read it.
 *
 * The script used to travel as `-EncodedCommand`, which base64-encodes it as
 * UTF-16 — 2.67 bytes of command line per source character. Windows caps a
 * command line at 32767 characters, so the sampler had a hidden ceiling of about
 * 12 KB of script and no warning when it was crossed: the spawn simply began
 * failing with `ENAMETOOLONG` and every counter-backed panel went unavailable.
 * It was crossed for real while adding a feature.
 *
 * A file has no such ceiling, and the BOM is not decoration: Windows PowerShell
 * 5.1 reads a BOM-less file as ANSI and mangles anything non-ASCII.
 * @param path - where to write.
 * @param source - the script text.
 */
function writeScript(path, source) {
  writeFileSync(path, `\uFEFF${source}`, 'utf8')
}

/**
 * The icon extractor, run as a short-lived PowerShell child only when an
 * application icon is missing. It reads one base64 blob from stdin whose lines
 * are tab-separated, individually base64-encoded `label`/`path` pairs, and
 * answers with one base64 JSON line carrying a PNG per icon.
 * `ExtractAssociatedIcon` returns the 32px image Windows itself shows.
 *
 * The input deliberately avoids JSON and raw paths: Windows PowerShell 5.1
 * parses a JSON array differently from 7, and a path outside the console code
 * page would arrive corrupted. Base64 text has neither problem.
 */
const ICON_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pairs = @()
try {
  $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim()))
  foreach ($line in $text.Split([char]10)) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '') { continue }
    $parts = $trimmed.Split([char]9)
    if ($parts.Count -lt 2) { continue }
    $label = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0]))
    $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    if ($label -ne '' -and $path -ne '') { $pairs += @{ label = $label; path = $path } }
  }
} catch { }

Add-Type -AssemblyName System.Drawing

$results = @()
foreach ($pair in $pairs) {
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($pair.path)
    if ($null -eq $icon) { continue }
    $bitmap = $icon.ToBitmap()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $results += [ordered]@{ label = $pair.label; data = [Convert]::ToBase64String($stream.ToArray()) }
    $stream.Dispose()
    $bitmap.Dispose()
    $icon.Dispose()
  } catch { }
}

$payload = @{ type = 'icons'; icons = @($results) } | ConvertTo-Json -Compress -Depth 4
$builder = New-Object System.Text.StringBuilder
foreach ($character in $payload.ToCharArray()) {
  $code = [int]$character
  if ($code -lt 128) { [void]$builder.Append($character) }
  else { [void]$builder.AppendFormat('\u{0:x4}', $code) }
}
[Console]::Out.WriteLine($builder.ToString())
[Console]::Out.Flush()
`

/** Round to one decimal without ever producing `-0`. */
function round1(value) {
  const rounded = Math.round(value * 10) / 10
  return rounded === 0 ? 0 : rounded
}

/**
 * Round to two decimals. One process usually holds a small share of a many-core
 * machine, and the client sums these per application — rounding to a tenth here
 * would erase every contribution of a browser's twenty helper processes.
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

/** Clamp a percentage into `[0, 100]`. */
function percent(value) {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 100 ? 100 : value
}

/** Percentage of a whole, guarding a zero denominator. */
function ratio(part, whole) {
  return whole > 0 ? percent((part / whole) * 100) : 0
}

/** Keep a bounded trailing window of samples. */
function push(list, value, limit = SERIES_LIMIT) {
  list.push(value)
  if (list.length > limit) list.splice(0, list.length - limit)
}

/**
 * Reduce a series to a fixed number of points, always keeping the newest one.
 * A thirty-minute window costs the same payload as a one-minute window.
 * @param points - samples in ascending time order.
 * @param target - the point budget.
 * @returns the reduced series, or the original when it already fits.
 */
function downsample(points, target = WINDOW_POINTS) {
  if (points.length <= target) return points
  const step = points.length / target
  const out = []
  for (let index = 0; index < points.length; index += step) {
    out.push(points[Math.floor(index)])
  }
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** Clamp a requested window to one of the offered sizes. */
export function resolveWindow(raw) {
  const value = Number(raw)
  // No request means the shortest window. A request beyond what is retained gets
  // everything there is. Anything in between is honoured as asked — a custom
  // range has to mean what it says, or the control is a lie.
  if (!Number.isFinite(value)) return WINDOWS[0]
  return Math.min(SERIES_LIMIT, Math.max(WINDOWS[0], Math.round(value)))
}

/**
 * Where the rolling on-disk history lives.
 *
 * One file per day, so a directory listing reads as a calendar and retention is
 * a date comparison rather than a bookkeeping problem.
 */
function historyDir() {
  return join(os.homedir(), '.dsh-system-monitor', 'history')
}

/** The file one day's samples belong in. */
function historyPathFor(date) {
  return join(historyDir(), `${date.toISOString().slice(0, 10)}.ndjson`)
}

/** How long a sample waits in memory before it is written. */
const HISTORY_FLUSH_MS = 30000

/**
 * Where the session extremes are kept between runs.
 *
 * A monitoring plugin that forgets everything on restart cannot answer "has it
 * been like this all week". The file holds only the extremes, the alert log and
 * a downsampled tail of the chart — a few kilobytes, written at most once a
 * minute and only when something actually changed.
 */
function statePath() {
  return join(os.homedir(), '.dsh-system-monitor', 'state.json')
}

/** Host-side collector owning every timer and the live PowerShell child. */
export class SystemSampler {
  /** @param options - optional `logger` and the loader row's `config`. */
  constructor(options = {}) {
    const cpus = os.cpus()
    this.logger = options.logger
    /** Optional `(level, previous, reasons) => void` invoked on every transition. */
    this.onAlert = options.onAlert ?? null
    this.config = resolveConfig(options.config)
    this.hostname = os.hostname()
    this.platform = process.platform
    this.osLabel = this.platform === 'win32' ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`
    this.cpuModel = (cpus[0]?.model ?? 'CPU').trim()
    this.cpuSpeedMhz = cpus[0]?.speed ?? 0
    this.coreCount = cpus.length
    this.prevTimes = cpus.map((cpu) => ({ ...cpu.times }))
    this.cpuUsage = 0
    this.perCore = new Array(this.coreCount).fill(0)
    this.cpuHistory = []
    this.memHistory = []
    this.gpuHistory = []
    /**
     * One aligned sample per tick, so the client can draw CPU, memory and GPU on
     * a single timeline instead of three separately-started sparklines.
     */
    this.series = []
    /** Per-core history, one row per logical core, for the heatmap. */
    this.coreHistory = []
    /** Total physical-disk throughput over time. */
    this.ioHistory = []
    /** Worst-disk latency and queue over time, the pair that shows contention. */
    this.latencyHistory = []
    /** Worst physical disk right now: latency, queue depth, transfer rate. */
    this.storage = { latencySec: null, latencyDisk: null, queue: null, transfers: 0 }
    /** Highest clock seen this session, for the throttle comparison. */
    this.peakMhz = 0
    /** Alert-level transitions, oldest first. */
    this.alertLog = []
    this.lastAlertLevel = 'none'
    /**
     * Per-application memory baselines, one every {@link APP_MEMORY_INTERVAL_MS}.
     * Absolute memory says who is big; only the delta says who is *growing*,
     * which is what a leak looks like.
     */
    this.appMemory = []
    this.appMemoryAt = 0
    /** Free bytes per volume, sampled slowly: the basis of the "fills up in…" projection. */
    this.freeSpace = []
    /** Committed bytes, sampled slowly: the basis of the exhaustion projection. */
    this.commitSeries = []
    this.forecastAt = 0
    /** Battery state from CIM; absent on desktops and on locked-down machines. */
    this.battery = { state: 'unknown', percent: null, minutes: null, charging: null }
    /**
     * Extremes since the sampler started, with whoever was to blame at the time.
     * A live reading answers "what now"; this answers "how bad has it been".
     */
    this.peaks = {
      cpu: { value: 0, t: 0, label: null },
      memory: { value: 0, t: 0, label: null },
      gpu: { value: 0, t: 0, label: null },
      latencyMs: { value: 0, t: 0, disk: null },
      cpuSum: 0,
      memorySum: 0,
      samples: 0,
    }
    /** When the persisted extremes were first accumulated, if they were restored. */
    this.peaksSince = null
    this.persistAt = 0
    this.persistDirty = false
    /**
     * Loop multiplier the sampler runs at when nobody has looked for a while;
     * 0 keeps the old behaviour of stopping the child outright.
     */
    this.coldRate = Math.max(0, Math.round(Number(this.config.idleSamplingSeconds) || 0))
    /** The rate last handed to the child, so it is only rewritten on change. */
    this.rateWritten = 0
    /** Per-process rate handshake, unique so two instances cannot collide. */
    this.ratePath = join(os.tmpdir(), `dsh-system-monitor-rate-${process.pid}`)
    /** Where the PowerShell sampler is written before each spawn. */
    this.scriptPath = join(os.tmpdir(), `dsh-system-monitor-sampler-${process.pid}.ps1`)
    /** Where the short-lived icon extractor is written. */
    this.iconScriptPath = join(os.tmpdir(), `dsh-system-monitor-icons-${process.pid}.ps1`)
    this.memory = { total: os.totalmem(), free: os.freemem(), used: 0, usage: 0 }
    /** Machine-level counters: clock speed and the memory composition. */
    this.system = {}
    /** When each resource first crossed its threshold, for the sustain window. */
    this.alertSince = { cpu: null, memory: null, gpu: null, disk: null }
    this.disks = []
    this.mounts = []
    this.diskBusy = false
    this.lastMountScan = 0

    this.gpu = {
      status: 'idle',
      util: null,
      dedicated: null,
      shared: null,
      engines: null,
      adapters: [],
      /**
       * Why the GPU reading is not live, as a machine-readable code plus any raw
       * text. The Host never composes UI copy: the Client localizes the code, so
       * the plugin can ship in any language.
       */
      reason: null,
      updatedAt: 0,
    }
    /** True when the GPU counters proved unusable; the child keeps running. */
    this.gpuUnsupported = false
    /** True when the live sampler cannot run at all, so processes are gone too. */
    this.samplerFailed = false
    /** A fault of the collector itself, surfaced through the alert channel. */
    this.samplerFault = null
    /** Buffered history lines, written in batches rather than one append a second. */
    /** Previous cumulative per-process disk counters, the basis for every rate. */
    this.diskIoSeen = new Map()
    this.diskIoRates = new Map()
    this.diskIoAt = 0
    this.historyBuffer = []
    // Seeded at construction, so the first sample is buffered rather than writing
    // a one-line file the instant the plugin loads.
    this.historyAt = Date.now()
    /** Physical-disk throughput rows, keyed by counter instance name. */
    this.physicalDisks = []
    /** Latest per-process rows, already carrying a computed CPU percentage. */
    this.processes = []
    this.processSampleAt = 0
    this.previousProcCpu = new Map()
    this.previousProcAt = 0
    /** One row per application label, refreshed with every process sample. */
    this.appTotals = new Map()
    /** Application label -> executable path, as reported by the live sampler. */
    this.appPaths = {}
    /** Content key -> PNG bytes of one application icon. */
    this.icons = new Map()
    /** Application label -> content key, for the payload the client reads. */
    this.iconKeys = new Map()
    /** Labels already handed to an extraction batch, so none is requested twice. */
    this.iconRequested = new Set()
    this.iconChild = null
    this.iconAttemptAt = 0
    this.iconInterpreter = 0

    this.child = null
    this.childBuffer = ''
    this.childStderr = ''
    this.childStartedAt = 0
    this.childFirstMessageAt = 0
    this.touchedAt = 0
    this.interpreter = 0
    this.attempts = 0
    this.restartTimer = null
    this.disposed = false
    this.persistTimer = null
    this.startedAt = Date.now()
    /** Bounded evidence about the live sampler, surfaced for troubleshooting. */
    this.diagnostics = { executable: null, spawnError: null, stderr: null, init: null, iconError: null }

    this.onTick = this.onTick.bind(this)
    this.tick = setInterval(this.onTick, SAMPLE_MS)
    this.tick.unref?.()
    this.watchdog = setInterval(() => this.reapChild(), 4000)
    this.watchdog.unref?.()
    this.restore()
    void this.refreshMounts()
  }

  /** Mark that a browser is watching, which keeps the live sampler alive. */
  touch() {
    this.touchedAt = Date.now()
  }

  /** Release every timer and stop the live sampler. */
  dispose() {
    this.disposed = true
    clearInterval(this.tick)
    clearInterval(this.watchdog)
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.save()
    this.flushHistory()
    this.killChild()
    for (const path of [this.scriptPath, this.iconScriptPath, this.ratePath]) {
      try { rmSync(path, { force: true }) } catch { }
    }
    this.killIconChild()
  }

  /** Terminate a running icon-extraction batch. */
  killIconChild() {
    const child = this.iconChild
    this.iconChild = null
    if (child === null) return
    child.removeAllListeners('exit')
    child.removeAllListeners('error')
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  /** One sampling tick: Node-native metrics now, disk refresh off the loop. */
  onTick() {
    if (this.disposed) return
    this.readCpu()
    this.readMemory()
    this.recordForecast(Date.now())
    this.recordHistory(Date.now())
    // Evaluated on the sampler's own cadence rather than only when something
    // polls, so a sustained threshold is noticed with no browser open at all.
    this.alerts()
    push(this.series, {
      t: Date.now(),
      cpu: this.cpuUsage,
      mem: this.memory.usage,
      gpu: this.gpu.status === 'live' && Number.isFinite(this.gpu.util) ? this.gpu.util : null,
    })
    this.notePeaks()
    const now = Date.now()
    if (now - this.lastMountScan > MOUNT_RESCAN_MS) {
      this.lastMountScan = now
      void this.refreshMounts().then(() => this.refreshDisks())
    } else {
      void this.refreshDisks()
    }
  }

  /** Fold `os.cpus()` deltas into overall and per-core utilisation. */
  readCpu() {
    const cpus = os.cpus()
    let idleDelta = 0
    let totalDelta = 0
    const perCore = []
    for (let index = 0; index < cpus.length; index += 1) {
      const now = cpus[index].times
      const before = this.prevTimes[index] ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
      const idle = now.idle - before.idle
      const total =
        now.user - before.user +
        now.nice - before.nice +
        now.sys - before.sys +
        now.idle - before.idle +
        now.irq - before.irq
      idleDelta += idle
      totalDelta += total
      perCore.push(total > 0 ? round1(percent(100 * (1 - idle / total))) : 0)
      this.prevTimes[index] = { ...now }
    }
    if (totalDelta > 0) this.cpuUsage = round1(percent(100 * (1 - idleDelta / totalDelta)))
    this.perCore = perCore
    push(this.cpuHistory, this.cpuUsage, SPARK_LIMIT)
    if (this.coreHistory.length !== perCore.length) {
      this.coreHistory = perCore.map(() => [])
    }
    for (let index = 0; index < perCore.length; index += 1) {
      push(this.coreHistory[index], perCore[index], CORE_LIMIT)
    }
  }

  /** Read physical memory and append the utilisation history point. */
  readMemory() {
    const total = os.totalmem()
    const free = os.freemem()
    const used = Math.max(0, total - free)
    this.memory = { total, free, used, usage: round1(ratio(used, total)) }
    push(this.memHistory, this.memory.usage, SPARK_LIMIT)
  }

  /** Enumerate the volumes worth reporting (fixed and removable letters on Windows). */
  async refreshMounts() {
    if (this.platform !== 'win32') {
      this.mounts = ['/']
      return
    }
    const letters = []
    for (let code = 67; code <= 90; code += 1) letters.push(`${String.fromCharCode(code)}:`)
    const found = []
    await Promise.all(letters.map(async (mount) => {
      try {
        const stats = await fsp.statfs(`${mount}\\`)
        if (stats.blocks > 0) found.push(mount)
      } catch {
        // Absent or unreadable drive letter: simply not a volume.
      }
    }))
    found.sort()
    this.mounts = found
  }

  /** Refresh used/free bytes for every known mount, one pass at a time. */
  async refreshDisks() {
    if (this.diskBusy || this.mounts.length === 0) return
    this.diskBusy = true
    try {
      const rows = []
      for (const mount of this.mounts) {
        const target = this.platform === 'win32' ? `${mount}\\` : mount
        try {
          const stats = await fsp.statfs(target)
          const total = stats.blocks * stats.bsize
          if (total <= 0) continue
          const free = stats.bavail * stats.bsize
          const used = Math.max(0, total - free)
          rows.push({ mount, total, used, free, usage: round1(ratio(used, total)) })
        } catch {
          // The volume vanished between scans; it disappears from the next list.
        }
      }
      this.disks = rows
    } finally {
      this.diskBusy = false
    }
  }

  /** The ordered interpreter candidates, wrapped so the index never overflows. */
  interpreterCandidates() {
    return GPU_INTERPRETERS.length > 0
      ? GPU_INTERPRETERS
      : ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
  }

  /**
   * How many loop iterations the sampler should skip, by how recently a client
   * looked.
   *
   * Slowing down beats stopping: the retrospective views are only worth having
   * if the history has no holes, and the holes used to land exactly when nobody
   * was watching — which is when a problem is most likely to go unnoticed.
   * @returns the iteration multiplier for the sampler loop.
   */
  samplingRate() {
    const idleFor = Date.now() - this.touchedAt
    if (idleFor < RATE_ACTIVE_MS) return RATE_ACTIVE
    if (idleFor < RATE_WARM_MS) return RATE_WARM
    return this.coldRate
  }

  /** Keep the sampler child informed of the rate it should run at. */
  syncRate() {
    if (this.child === null) return
    const rate = this.samplingRate()
    if (rate === this.rateWritten) return
    this.rateWritten = rate
    try {
      writeFileSync(this.ratePath, String(rate))
    } catch {
      // The child keeps its previous cadence; sampling is never blocked by this.
    }
  }

  /** Start the live sampler when a viewer is present and nothing is running. */
  reapChild() {
    if (this.disposed) return
    const touched = Date.now() - this.touchedAt < RATE_ACTIVE_MS
    this.syncRate()
    if (this.child === null && this.restartTimer === null && (touched || this.coldRate > 0)) {
      this.startChild()
      return
    }
    // Only the explicit opt-out actually stops the sampler.
    if (!touched && this.coldRate === 0 && this.child !== null) {
      this.killChild()
      this.gpu.status = 'idle'
      this.gpu.reason = null
      this.gpu.engines = null
      return
    }
    const silent = this.child !== null && this.childFirstMessageAt === 0 &&
      Date.now() - this.childStartedAt > LIVE_FIRST_MESSAGE_MS
    if (silent) {
      this.gpu.reason = { code: 'sampler-silent' }
      this.killChild()
      this.scheduleRestart()
    }
  }

  /** Spawn the PowerShell live sampler, cycling interpreters across restarts. */
  startChild() {
    if (this.platform !== 'win32') {
      this.samplerFailed = true
      this.gpuUnsupported = true
      this.gpu.status = 'unavailable'
      this.gpu.reason = { code: 'windows-only' }
      return
    }
    const candidates = this.interpreterCandidates()
    const executable = candidates[this.interpreter % candidates.length]
    this.interpreter += 1
    this.attempts += 1
    if (this.attempts > LIVE_MAX_ATTEMPTS) {
      this.samplerFailed = true
      this.gpuUnsupported = true
      this.gpu.status = 'unavailable'
      this.gpu.reason ??= { code: 'sampler-gave-up', detail: `${LIVE_MAX_ATTEMPTS}` }
      this.noteSamplerFault(this.gpu.reason.code)
      return
    }
    this.diagnostics.executable = executable
    this.diagnostics.spawnError = null
    let child
    try {
      // The cadence is handed over as a file the child re-reads each loop, so the
      // rate can change without paying for a restart and a fresh first sample.
      this.rateWritten = 0
      try {
        writeFileSync(this.ratePath, String(this.samplingRate()))
      } catch {
        // No rate file: the child stays at its default cadence.
      }
      // The script goes through a file rather than the command line: the
      // command-line form had a 12 KB ceiling that failed silently and was
      // already being crossed. See writeScript.
      try {
        writeScript(this.scriptPath, LIVE_SCRIPT)
      } catch (error) {
        this.diagnostics.spawnError = `script write failed: ${error.message}`
        this.failChild({ code: 'spawn-failed', detail: this.scriptPath })
        return
      }
      child = spawn(
        executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DSM_RATE_FILE: this.ratePath },
        },
      )
    } catch (error) {
      this.diagnostics.spawnError = error.message
      this.failChild({ code: 'spawn-failed', detail: `${executable}: ${error.message}` })
      return
    }
    this.child = child
    this.childBuffer = ''
    this.childStderr = ''
    this.childStartedAt = Date.now()
    this.childFirstMessageAt = 0
    if (!this.gpuUnsupported) {
      this.gpu.status = 'starting'
      this.gpu.reason = null
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.consumeOutput(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.childStderr = `${this.childStderr}${chunk}`.slice(-2000)
      this.diagnostics.stderr = this.childStderr.trim()
    })
    child.on('error', (error) => {
      this.diagnostics.spawnError = error.message
      this.onChildExit(`进程错误: ${error.message}`)
    })
    child.on('exit', (code) => {
      this.onChildExit(this.childStderr.trim() !== '' ? this.childStderr.trim() : `PowerShell 退出码 ${String(code)}`)
    })
  }

  /** Parse one chunk of the child's newline-delimited JSON stream. */
  consumeOutput(chunk) {
    this.childBuffer += chunk
    let index = this.childBuffer.indexOf('\n')
    while (index !== -1) {
      const line = this.childBuffer.slice(0, index).trim()
      this.childBuffer = this.childBuffer.slice(index + 1)
      if (line !== '') this.handleMessage(line)
      index = this.childBuffer.indexOf('\n')
    }
    if (this.childBuffer.length > 262144) this.childBuffer = ''
  }

  /** Apply one decoded sampler message to the cached state. */
  handleMessage(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (this.childFirstMessageAt === 0) this.childFirstMessageAt = Date.now()

    if (message.type === 'init') {
      this.gpu.adapters = Array.isArray(message.adapters) ? message.adapters : []
      this.diagnostics.init = {
        pid: message.pid ?? null,
        psVersion: message.psVersion ?? null,
        hasEngine: message.hasEngine === true,
        hasPhysical: message.hasPhysical === true,
        hasLatency: message.hasLatency === true,
            guessed: message.guessed === true,
        pathCount: typeof message.pathCount === 'number' ? message.pathCount : null,
        memCounters: Array.isArray(message.memCounters) ? message.memCounters : [],
      }
      if (message.hasEngine !== true) {
        this.gpuUnsupported = true
        if (this.gpu.updatedAt === 0) {
          this.gpu.status = 'unavailable'
          this.gpu.reason = { code: 'no-gpu-counters' }
        }
      }
      return
    }

    if (message.type === 'counters-off') {
      this.gpuUnsupported = true
      this.gpu.status = 'unavailable'
      this.gpu.reason = { code: 'counters-failed' }
      this.physicalDisks = []
      return
    }

    if (message.type === 'error') {
      if (!this.gpuUnsupported) {
        this.gpu.status = this.gpu.updatedAt > 0 ? 'degraded' : 'unavailable'
        this.gpu.reason = { code: 'counters-error', detail: String(message.message ?? '') }
      }
      return
    }

    if (message.type === 'sample') {
      const now = typeof message.t === 'number' ? message.t : Date.now()
      if (!this.gpuUnsupported && typeof message.util === 'number') {
        this.attempts = 0
        this.gpu.status = 'live'
        this.gpu.reason = null
        this.gpu.util = round1(percent(message.util))
        this.gpu.dedicated = typeof message.dedicated === 'number' ? message.dedicated : null
        this.gpu.shared = typeof message.shared === 'number' ? message.shared : null
        this.gpu.engines = message.engines ?? null
        this.gpu.updatedAt = now
        push(this.gpuHistory, this.gpu.util, SPARK_LIMIT)
      }
      this.physicalDisks = Array.isArray(message.physical)
        ? message.physical
          .filter((row) => row && typeof row.name === 'string')
          .map((row) => ({
            // The counter reports drive letters lower-cased; present them as users write them.
            name: row.name.replace(/\b([a-z]):/g, (_, letter) => `${letter.toUpperCase()}:`),
            read: Number(row.read) || 0,
            write: Number(row.write) || 0,
            latencySec: row.hasLatency === true ? Number(row.latency) || 0 : null,
            queue: Number(row.queue) || 0,
            transfers: Number(row.transfers) || 0,
          }))
          .sort((a, b) => (b.read + b.write) - (a.read + a.write))
        : []
      this.updateStorage(now)
      push(this.ioHistory, {
        t: now,
        read: this.physicalDisks.reduce((sum, disk) => sum + disk.read, 0),
        write: this.physicalDisks.reduce((sum, disk) => sum + disk.write, 0),
      }, IO_LIMIT)
      if (message.appPaths && typeof message.appPaths === 'object') this.appPaths = message.appPaths
      if (message.diskIo && typeof message.diskIo === 'object') this.updateDiskIo(message.diskIo, now)
      if (message.system && typeof message.system === 'object') this.system = message.system
      if (message.batteryState === 'present' || message.batteryState === 'absent') {
        const cell = message.battery
        this.battery = message.batteryState === 'present' && cell
          ? {
            state: 'present',
            percent: Number.isFinite(Number(cell.percent)) ? Number(cell.percent) : null,
            minutes: Number(cell.minutes) > 0 && Number(cell.minutes) < 6000 ? Number(cell.minutes) : null,
            // Win32_Battery: 1 is "discharging on battery", 2 is "on AC".
            charging: Number(cell.status) !== 1,
          }
          : { state: 'absent', percent: null, minutes: null, charging: null }
      }
      this.clearSamplerFault()
      this.ingestProcesses(message.procs, message.gpuByPid, now)
    }
  }

  /** Current real clock speed in MHz, derived from the turbo ratio. */
  actualMhz() {
    const performance = Number(this.system.cpuPerformancePct)
    const nominal = Number(this.system.cpuNominalMhz) || this.cpuSpeedMhz
    if (!Number.isFinite(performance) || !(nominal > 0)) return null
    return Math.round((nominal * performance) / 100)
  }

  /**
   * The worst physical disk's latency, queue and transfer rate.
   *
   * Capacity says how full a volume is; only latency and queue length say
   * whether the disk is struggling right now.
   * @param now - the sample timestamp.
   */
  updateStorage(now) {
    let worst = null
    let transfers = 0
    for (const disk of this.physicalDisks) {
      transfers += disk.transfers
      if (disk.latencySec === null) continue
      if (worst === null || disk.latencySec > worst.latencySec) worst = disk
    }
    this.storage = {
      latencySec: worst ? worst.latencySec : null,
      latencyDisk: worst ? worst.name : null,
      queue: worst ? worst.queue : null,
      transfers,
    }
    push(this.latencyHistory, {
      t: now,
      latencyMs: worst ? Math.round(worst.latencySec * 100000) / 100 : null,
      queue: worst ? worst.queue : null,
    }, IO_LIMIT)
  }

  /**
   * Clock state, including whether the CPU looks throttled.
   *
   * A part can only be throttled while it is busy, so low clock at idle is just
   * power management; this only raises the flag under real load.
   * @returns the clock reading plus the session peak and a throttle verdict.
   */
  clock() {
    const actual = this.actualMhz()
    const nominal = Number(this.system.cpuNominalMhz) || this.cpuSpeedMhz || null
    if (actual !== null) this.peakMhz = Math.max(this.peakMhz, actual)
    const ratio = actual !== null && nominal ? actual / nominal : null
    const busy = this.cpuUsage >= THROTTLE_MIN_LOAD
    const throttled = ratio !== null && busy && ratio < THROTTLE_RATIO
    return {
      actualMhz: actual,
      nominalMhz: nominal,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      peakMhz: this.peakMhz > 0 ? this.peakMhz : null,
      throttled,
      busy,
    }
  }

  /**
   * Which resource is the current limiting factor, as a 0..1 pressure ratio
   * against what counts as saturated for that resource. Capacity is deliberately
   * not pressure: a 90 % full disk is not slow.
   * @returns the worst resource and every ratio, or null when nothing is loaded.
   */
  bottleneck() {
    const gpuLive = this.gpu.status === 'live' && Number.isFinite(this.gpu.util)
    const latency = this.storage.latencySec
    const queue = this.storage.queue
    const pressures = {
      cpu: this.cpuUsage / SATURATION.cpu,
      memory: this.memory.usage / SATURATION.memory,
      gpu: gpuLive ? this.gpu.util / SATURATION.gpu : 0,
      disk: Math.max(
        latency === null ? 0 : latency / SATURATION.latencySec,
        queue === null ? 0 : queue / SATURATION.queue,
      ),
    }
    let resource = null
    let pressure = 0
    for (const key of Object.keys(pressures)) {
      const value = Math.max(0, Math.min(1.5, pressures[key]))
      pressures[key] = Math.round(value * 100) / 100
      if (value > pressure) {
        pressure = value
        resource = key
      }
    }
    if (resource === null || pressure < BOTTLENECK_FLOOR) return null
    return {
      resource,
      pressure: Math.round(pressure * 100) / 100,
      pressures,
      detail: resource === 'disk' ? this.storage.latencyDisk : null,
    }
  }

  /** Capture the slow series the forecasts are built from, once a minute. */
  recordForecast(now) {
    if (now - this.forecastAt < FORECAST_INTERVAL_MS) return
    this.forecastAt = now
    const free = new Map()
    for (const disk of this.disks) free.set(disk.mount, disk.free)
    if (free.size > 0) {
      this.freeSpace.push({ t: now, free })
      if (this.freeSpace.length > FORECAST_SAMPLES) this.freeSpace.shift()
    }
    const committed = Number(this.system.committedBytes)
    if (committed > 0) {
      this.commitSeries.push({ t: now, y: committed })
      if (this.commitSeries.length > FORECAST_SAMPLES) this.commitSeries.shift()
    }
  }

  /**
   * Project the two things that actually run out: free disk space and commit
   * charge.
   *
   * Both are reported with the window they were measured over and their raw
   * slope, so a flat trend reads as "measured, going nowhere" rather than
   * looking like the feature is broken. A projection is only stated when the
   * trend is genuinely in the bad direction and the baseline is long enough for
   * the slope to mean anything.
   * @returns per-volume disk projections, the memory projection, and the battery.
   */
  forecast() {
    const now = Date.now()
    const result = { disk: null, memory: null, battery: this.battery }

    if (this.freeSpace.length >= 2) {
      const newest = this.freeSpace[this.freeSpace.length - 1]
      const oldest = this.freeSpace[0]
      const windowSec = Math.round((newest.t - oldest.t) / 1000)
      const mounts = []
      for (const [mount, free] of newest.free) {
        const points = []
        for (const entry of this.freeSpace) {
          const value = entry.free.get(mount)
          if (value !== undefined) points.push({ t: entry.t, y: value })
        }
        const slope = slopePerSecond(points)
        const spanMs = points.length > 1 ? points[points.length - 1].t - points[0].t : 0
        let daysLeft = null
        if (spanMs >= DISK_FORECAST_MIN_MS && slope < 0) {
          const days = free / -slope / 86400
          if (Number.isFinite(days) && days <= FORECAST_MAX_DAYS) daysLeft = Math.round(days * 10) / 10
        }
        mounts.push({ mount, free, bytesPerDay: Math.round(slope * 86400), daysLeft })
      }
      mounts.sort((left, right) => (left.daysLeft ?? Infinity) - (right.daysLeft ?? Infinity))
      result.disk = { windowSec, mounts }
    }

    if (this.commitSeries.length >= 2) {
      const first = this.commitSeries[0]
      const last = this.commitSeries[this.commitSeries.length - 1]
      const windowSec = Math.round((last.t - first.t) / 1000)
      const spanMs = last.t - first.t
      const slope = slopePerSecond(this.commitSeries)
      const limit = Number(this.system.commitLimitBytes) || 0
      const headroom = limit > 0 ? limit - last.y : null
      let secondsLeft = null
      if (spanMs >= MEMORY_FORECAST_MIN_MS && slope > 0 && headroom !== null && headroom > 0) {
        const seconds = headroom / slope
        if (Number.isFinite(seconds)) secondsLeft = Math.round(seconds)
      }
      result.memory = {
        windowSec,
        committed: last.y,
        limit: limit > 0 ? limit : null,
        bytesPerDay: Math.round(slope * 86400),
        secondsLeft,
      }
    }

    return result
  }

  /** Load the extremes left by the previous run, if any. Never fatal. */
  restore() {
    if (!this.config.persist) return
    try {
      const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
      const peaks = raw?.peaks
      if (peaks && typeof peaks === 'object') {
        for (const key of ['cpu', 'memory', 'gpu', 'latencyMs']) {
          const saved = peaks[key]
          if (saved && Number.isFinite(Number(saved.value)) && Number(saved.value) > this.peaks[key].value) {
            this.peaks[key] = { ...this.peaks[key], ...saved }
          }
        }
        this.peaksSince = Number(raw.since) || null
      }
      if (Array.isArray(raw?.alertLog)) {
        this.alertLog = raw.alertLog.slice(-ALERT_LOG_LIMIT)
        this.lastAlertLevel = this.alertLog.at(-1)?.level ?? 'none'
      }
      if (Array.isArray(raw?.series)) this.series = raw.series.slice(-WINDOW_POINTS)
    } catch {
      // No saved state, or it is unreadable: starting fresh is always correct.
    }
  }

  /** Ask for a save, throttled so a moving peak cannot thrash the disk. */
  persistSoon() {
    if (!this.config.persist) return
    if (this.persistDirty) return
    if (Date.now() - this.persistAt < PERSIST_INTERVAL_MS) return
    this.persistDirty = true
    this.persistTimer = setTimeout(() => {
      this.persistDirty = false
      this.save()
    }, PERSIST_INTERVAL_MS)
    this.persistTimer.unref?.()
  }

  /** Write the extremes, the alert log and the chart tail. Never fatal. */
  save() {
    if (!this.config.persist || this.disposed) return
    try {
      const path = statePath()
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify({
        version: 1,
        since: this.peaksSince ?? this.startedAt,
        peaks: this.peaks,
        alertLog: this.alertLog,
        series: downsample(this.series, WINDOW_POINTS),
      }))
      this.persistAt = Date.now()
    } catch {
      // A read-only home directory is a valid environment, not an error.
    }
  }

  /**
   * Append one line to the on-disk history, buffered.
   *
   * The buffer is the point: at one sample a second, writing straight through
   * would be 86,400 file appends a day for a monitor nobody is watching. Thirty
   * seconds of buffering cuts that by thirty, and the most a crash can cost is
   * the last half-minute — the right trade for this data.
   * @param now - the sample timestamp.
   */
  recordHistory(now) {
    if (this.config.historyDays <= 0) return
    const newest = this.series[this.series.length - 1]
    if (newest === undefined) return
    const io = this.ioHistory[this.ioHistory.length - 1]
    const latency = this.latencyHistory[this.latencyHistory.length - 1]
    this.historyBuffer.push(JSON.stringify({
      t: newest.t,
      cpu: newest.cpu,
      mem: newest.mem,
      gpu: newest.gpu,
      diskRead: io && io.t === newest.t ? io.read : undefined,
      diskWrite: io && io.t === newest.t ? io.write : undefined,
      latencyMs: latency && latency.t === newest.t ? latency.latencyMs : undefined,
      queue: latency && latency.t === newest.t ? latency.queue : undefined,
    }))
    if (now - this.historyAt < HISTORY_FLUSH_MS) return
    this.historyAt = now
    this.flushHistory()
  }

  /**
   * Write the buffer out, then enforce retention.
   *
   * Retention is not optional. A monitor that silently fills a disk is a worse
   * bug than one with no history at all, so the prune runs on every flush rather
   * than on a schedule that might not survive a restart.
   */
  flushHistory() {
    if (this.historyBuffer.length === 0) return
    const lines = `${this.historyBuffer.join('\n')}\n`
    this.historyBuffer = []
    try {
      mkdirSync(historyDir(), { recursive: true })
      appendFileSync(historyPathFor(new Date()), lines)
      this.pruneHistory()
    } catch {
      // A read-only home directory is a valid environment. History is a nicety;
      // sampling is not, and must not be disturbed by this failing.
    }
  }

  /**
   * Delete day files older than the retention window.
   * @returns the names that were removed.
   */
  pruneHistory() {
    const keep = Math.max(1, this.config.historyDays)
    const cutoff = Date.now() - keep * 86400000
    const removed = []
    let names
    try {
      names = readdirSync(historyDir())
    } catch {
      return removed
    }
    for (const name of names) {
      const stamp = /^(\d{4})-(\d{2})-(\d{2})\.ndjson$/.exec(name)
      if (stamp === null) continue
      // Parsed as UTC midnight, matching how the file was named.
      const when = Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T00:00:00Z`)
      if (!Number.isFinite(when) || when >= cutoff) continue
      try {
        rmSync(join(historyDir(), name), { force: true })
        removed.push(name)
      } catch {
        // Left behind rather than fatal; the next flush tries again.
      }
    }
    return removed
  }

  /** Fold this tick into the session extremes and running averages. */
  notePeaks() {    const now = Date.now()
    const peaks = this.peaks
    peaks.cpuSum += this.cpuUsage
    peaks.memorySum += this.memory.usage
    peaks.samples += 1
    const topBy = (field) => {
      let best = null
      for (const entry of this.appTotals.values()) {
        if (best === null || entry[field] > best[field]) best = entry
      }
      return best && best[field] > 0 ? best.label : null
    }
    if (this.cpuUsage > peaks.cpu.value) {
      peaks.cpu = { value: round1(this.cpuUsage), t: now, label: topBy('cpu') }
      this.persistSoon()
    }
    if (this.memory.usage > peaks.memory.value) {
      peaks.memory = { value: round1(this.memory.usage), t: now, label: topBy('memory') }
      this.persistSoon()
    }
    const gpuLive = this.gpu.status === 'live' && Number.isFinite(this.gpu.util)
    if (gpuLive && this.gpu.util > peaks.gpu.value) {
      peaks.gpu = { value: round1(this.gpu.util), t: now, label: topBy('gpu') }
      this.persistSoon()
    }
    const latencyMs = this.storage.latencySec === null ? null : this.storage.latencySec * 1000
    if (latencyMs !== null && latencyMs > peaks.latencyMs.value) {
      peaks.latencyMs = { value: Math.round(latencyMs * 100) / 100, t: now, disk: this.storage.latencyDisk }
      this.persistSoon()
    }
  }

  /** The session summary: extremes, averages, and how long the sampler has run. */
  summary() {    const peaks = this.peaks
    const samples = peaks.samples || 1
    return {
      startedAt: this.startedAt,
      since: this.peaksSince ?? this.startedAt,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      samples: peaks.samples,
      cpu: peaks.cpu,
      memory: peaks.memory,
      gpu: peaks.gpu,
      latencyMs: peaks.latencyMs,
      cpuAvg: round1(peaks.cpuSum / samples),
      memoryAvg: round1(peaks.memorySum / samples),
    }
  }

  /**
   * The per-application table as it stands right now.
   *
   * This is the one thing the sample series cannot answer: *who* was using the
   * machine. It is point-in-time, not a window average, because per-application
   * history is not retained — only the current aggregate and the memory growth
   * baseline are. The growth columns are the exception: they genuinely describe
   * a span, and they carry the span they measured.
   * @returns `{ columns, rows }`.
   */
  exportApps() {
    const growth = new Map()
    for (const row of this.appGrowth().rows) growth.set(row.label, row)
    const rows = []
    for (const entry of this.appTotals.values()) {
      const moved = growth.get(entry.label)
      const path = this.appPaths[entry.label]
      rows.push({
        app: entry.label,
        processes: entry.count,
        cpuPct: round1(entry.cpu),
        memoryBytes: entry.memory,
        gpuPct: round1(entry.gpu),
        diskReadBps: Math.round(entry.diskRead ?? 0),
        diskWriteBps: Math.round(entry.diskWrite ?? 0),
        growthBytes: moved ? moved.delta : 0,
        growthWindowSec: moved && !moved.fresh ? this.appGrowth().windowSec : 0,
        newlyStarted: moved ? moved.fresh : false,
        executablePath: path ?? null,
      })
    }
    rows.sort((left, right) => right.memoryBytes - left.memoryBytes)
    return {
      columns: [
        'app', 'processes', 'cpuPct', 'memoryBytes', 'gpuPct', 'diskReadBps', 'diskWriteBps',
        'growthBytes', 'growthWindowSec', 'newlyStarted', 'executablePath',
      ],
      rows,
    }
  }

  /**
   * Everything the plugin knows, for an archive or a bug report.
   *
   * Deliberately not a sample table: the point is that one file is enough to
   * reproduce a reading of the machine without asking follow-up questions.
   * @param options - `{ window }` in seconds, and `{ detail }` for the apps.
   * @returns one object, safe to serialise.
   */
  exportBundle(options = {}) {
    const snapshot = this.snapshot({ window: options.window, detail: options.detail })
    const bundle = {
      bundle: 'dsh-system-monitor',
      generatedAt: Date.now(),
      generatedAtIso: new Date().toISOString(),
      revision: SAMPLER_REVISION,
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      host: snapshot.host,
      windowSec: snapshot.windowSec,
      config: snapshot.config,
      capabilities: snapshot.capabilities,
      health: snapshot.health,
      alerts: snapshot.alerts,
      alertLog: snapshot.alertLog,
      summary: snapshot.summary,
      forecast: snapshot.forecast,
      clock: snapshot.clock,
      bottleneck: snapshot.bottleneck,
      storage: snapshot.storage,
      cpu: { model: snapshot.cpu.model, cores: snapshot.cpu.cores, usage: snapshot.cpu.usage, actualMhz: snapshot.cpu.actualMhz },
      memory: {
        total: snapshot.memory.total,
        used: snapshot.memory.used,
        usage: snapshot.memory.usage,
        committed: snapshot.memory.committed,
        commitLimit: snapshot.memory.commitLimit,
      },
      gpu: { status: snapshot.gpu.status, util: snapshot.gpu.util, engines: snapshot.gpu.engines, diagnostics: snapshot.gpu.diagnostics },
      disks: snapshot.disks,
      series: snapshot.series,
    }
    if (options.detail) bundle.apps = this.exportApps().rows
    return bundle
  }

  /**
   * One flat table of every series, for export.
   *
   * Each row is a sample time and whatever was measured then; series sampled at
   * different rates simply leave gaps rather than being resampled into fiction.
   * @param windowSec - how far back to include.
   * @returns `{ columns, rows }`.
   */
  exportTable(windowSec = WINDOWS[2]) {
    const cutoff = Date.now() - resolveWindow(windowSec) * 1000
    const rows = []
    for (const point of this.series) {
      if (point.t < cutoff) continue
      rows.push({
        t: point.t,
        // Rendered per row rather than by the CSV writer. That writer iterates
        // the declared columns, so a column with no matching field exports as a
        // silently empty column — which is exactly what `iso` did until a test
        // checked values rather than only keys.
        iso: point.t ? new Date(point.t).toISOString() : '',
        cpu: point.cpu,
        mem: point.mem,
        gpu: point.gpu,
      })
    }
    const io = new Map()
    for (const point of this.ioHistory) {
      if (point.t < cutoff) continue
      io.set(point.t, point)
    }
    const latency = new Map()
    for (const point of this.latencyHistory) {
      if (point.t < cutoff) continue
      latency.set(point.t, point)
    }
    for (const point of [...io.values(), ...latency.values()]) {
      rows.push({
        t: point.t,
        diskRead: point.read,
        diskWrite: point.write,
        latencyMs: point.latencyMs,
        queue: point.queue,
      })
    }
    rows.sort((left, right) => left.t - right.t)
    const columns = ['t', 'iso', 'cpu', 'mem', 'gpu', 'diskRead', 'diskWrite', 'latencyMs', 'queue']
    return { columns, rows }
  }

  /**
   * One line to the Harness log.
   *
   * This is the only alert channel that survives having no browser open, so it
   * must never be the thing that breaks: a logger that is absent, shaped
   * differently, or throwing is swallowed rather than propagated.
   * @param level - `info` or `warn`.
   * @param message - the line to record.
   */
  log(level, message) {
    const logger = this.logger
    if (!logger) return
    try {
      const sink = typeof logger[level] === 'function' ? logger[level] : logger.info
      if (typeof sink === 'function') sink.call(logger, message)
    } catch {
      // Logging is best-effort by definition.
    }
  }

  /**
   * Raise a fault about the collector itself.
   *
   * A sampler that cannot start is not a resource reading — but it is the most
   * important thing this plugin can tell anyone, because every counter-backed
   * panel silently loses its data when it happens. So it goes through the same
   * alert channel as a threshold breach: the log line, the toast and the badge
   * all already work, and none of them needed to learn about a second mechanism.
   * @param code - the reason code from the sampler diagnostics.
   */
  noteSamplerFault(code) {
    this.samplerFault = { code, at: Date.now() }
    this.samplerFaultAnnounced = false
  }

  /** Forget a sampler fault once a sample actually arrives. */
  clearSamplerFault() {
    if (this.samplerFault === null) return
    this.samplerFault = null
    this.samplerFaultAnnounced = false
  }

  /**
   * Record one alert-level transition. A monitor that only shows "now" cannot
   * answer "when did this start", which is the first question anyone asks.
   * @param level - the level just computed.
   * @param reasons - the reasons behind it.
   */
  noteAlerts(level, reasons) {
    if (level === this.lastAlertLevel) return
    const previous = this.lastAlertLevel
    this.lastAlertLevel = level
    // Told before the early return below, so a clear is reported even when the
    // panel is closed and the log is empty.
    if (this.onAlert) {
      try {
        this.onAlert(level, previous, reasons)
      } catch {
        // A listener must never be able to stop the sampler from sampling.
      }
    }
    if (level === 'none' && this.alertLog.length === 0) return
    this.alertLog.push({
      t: Date.now(),
      level,
      reasons: reasons.map((reason) => ({
        key: reason.key,
        value: reason.value,
        detail: reason.detail ?? null,
      })),
    })
    if (this.alertLog.length > ALERT_LOG_LIMIT) {
      this.alertLog.splice(0, this.alertLog.length - ALERT_LOG_LIMIT)
    }
  }

  /**
   * Evaluate the sustained-load thresholds, updating each resource's start time.
   * @returns the badge state: `level` plus one entry per tripped resource.
   */
  alerts() {
    const now = Date.now()
    let worstDisk = null
    for (const disk of this.disks) {
      if (worstDisk === null || disk.usage > worstDisk.usage) worstDisk = disk
    }
    const readings = {
      cpu: { value: this.cpuUsage, detail: null },
      memory: { value: this.memory.usage, detail: null },
      gpu: {
        value: this.gpu.status === 'live' && Number.isFinite(this.gpu.util) ? this.gpu.util : null,
        detail: null,
      },
      disk: { value: worstDisk ? worstDisk.usage : null, detail: worstDisk ? worstDisk.mount : null },
    }

    const reasons = []
    // The collector being down outranks any reading: it is the reason the
    // readings are missing. `value: null` marks it as not-a-percentage, and the
    // renderers leave the unit off when they see that.
    if (this.samplerFault !== null && !this.samplerFaultAnnounced) {
      reasons.push({ key: 'sampler', value: null, detail: this.samplerFault.code, high: false })
    }
    const thresholds = {
      cpu: this.config.alertCpu,
      memory: this.config.alertMemory,
      gpu: this.config.alertGpu,
      disk: this.config.alertDisk,
    }
    const sustainMs = this.config.alertSustainSeconds * 1000
    for (const key of Object.keys(thresholds)) {
      const threshold = thresholds[key]
      const value = readings[key].value
      if (value === null || !Number.isFinite(value) || value < threshold) {
        this.alertSince[key] = null
        continue
      }
      if (this.alertSince[key] === null) this.alertSince[key] = now
      if (now - this.alertSince[key] < sustainMs) continue
      reasons.push({
        key,
        value: round1(value),
        threshold,
        detail: readings[key].detail,
        high: value >= threshold + ALERT_HIGH_MARGIN,
      })
    }

    let level = 'none'
    if (reasons.length > 0) level = reasons.some((reason) => reason.high) ? 'high' : 'warn'
    if (this.samplerFault !== null) this.samplerFaultAnnounced = true
    this.noteAlerts(level, reasons)
    return { ts: now, level, reasons }
  }

  /** The PNG bytes cached under one icon key, or undefined. */
  icon(key) {
    return this.icons.get(key)
  }

  /**
   * What this machine can actually measure, so the Client can hide a panel
   * instead of showing an empty one. Each entry carries a reason *code* the
   * Client localizes — the Host never composes UI copy.
   * @returns one entry per monitored capability.
   */
  capabilities() {
    const windows = this.platform === 'win32'
    const sampler = windows && !this.samplerFailed
    const init = this.diagnostics.init ?? {}
    const gpuBlocked = !sampler || this.gpuUnsupported
    return {
      cpu: { available: true },
      memory: { available: true },
      diskCapacity: { available: this.disks.length > 0 },
      clockSpeed: {
        available: this.actualMhz() !== null,
        reason: windows ? { code: 'needs-cpu-counters' } : { code: 'windows-only' },
      },
      memoryDetail: {
        available: Number(this.system.committedBytes) > 0,
        reason: windows ? { code: 'needs-memory-counters' } : { code: 'windows-only' },
      },
      gpu: {
        available: this.config.showGpu && !gpuBlocked,
        reason: gpuBlocked ? (this.gpu.reason ?? { code: windows ? 'needs-gpu-counters' : 'windows-only' }) : null,
      },
      processGpu: { available: this.config.showGpu && !gpuBlocked && init.hasEngine === true },
      processes: {
        available: this.config.showProcesses && sampler,
        reason: sampler ? null : { code: windows ? 'sampler-unavailable' : 'windows-only' },
      },
      diskThroughput: {
        available: this.config.showDiskThroughput && sampler && init.hasPhysical === true,
        reason: windows ? { code: 'needs-disk-counters' } : { code: 'windows-only' },
      },
      diskLatency: {
        available: sampler && init.hasLatency === true,
        reason: windows ? { code: 'needs-disk-counters' } : { code: 'windows-only' },
      },
      forecast: {
        available: sampler && (this.freeSpace.length >= 2 || this.commitSeries.length >= 2),
        reason: { code: 'needs-history' },
      },
      battery: {
        available: this.battery.state === 'present',
        reason: this.battery.state === 'absent' ? { code: 'no-battery' } : { code: 'needs-history' },
      },
      icons: {
        available: this.config.showIcons && windows,
        reason: windows ? { code: 'needs-executable-path' } : { code: 'windows-only' },
      },
    }
  }

  /**
   * The one-line verdict: how close each resource is to its own threshold, which
   * one is worst, and — when the process table is available — the application
   * responsible. The Client turns this into a sentence.
   * @returns level, the blamed resource, its reading, per-resource ratios, culprit.
   */
  health() {
    const alerts = this.alerts()
    let worstDisk = null
    for (const disk of this.disks) {
      if (worstDisk === null || disk.usage > worstDisk.usage) worstDisk = disk
    }
    const gpuLive = this.gpu.status === 'live' && Number.isFinite(this.gpu.util)
    const readings = {
      cpu: this.cpuUsage,
      memory: this.memory.usage,
      gpu: gpuLive ? this.gpu.util : null,
      disk: worstDisk ? worstDisk.usage : null,
    }
    const thresholds = {
      cpu: this.config.alertCpu,
      memory: this.config.alertMemory,
      gpu: this.config.alertGpu,
      disk: this.config.alertDisk,
    }
    const ratios = {}
    let resource = null
    let ratio = 0
    for (const key of Object.keys(readings)) {
      const value = readings[key]
      const use = value === null ? 0 : value / thresholds[key]
      ratios[key] = Math.round(use * 100) / 100
      if (use > ratio) {
        ratio = use
        resource = value === null ? resource : key
      }
    }

    const tripped = alerts.reasons
    let level = 'ok'
    if (tripped.length > 0) {
      level = alerts.level
      resource = tripped.reduce((worst, reason) =>
        (readings[reason.key] ?? 0) / thresholds[reason.key] > (readings[worst] ?? 0) / thresholds[worst]
          ? reason.key : worst, tripped[0].key)
    } else if (ratio >= BUSY_RATIO) {
      level = 'busy'
    }

    let culprit = null
    if (resource !== null && this.appTotals.size > 0) {
      const field = resource === 'memory' ? 'memory' : resource === 'gpu' ? 'gpu' : 'cpu'
      for (const entry of this.appTotals.values()) {
        if (culprit === null || entry[field] > culprit.value) {
          culprit = { label: entry.label, field, value: entry[field], count: entry.count }
        }
      }
      if (culprit !== null && !(culprit.value > 0)) culprit = null
    }

    return {
      level,
      resource,
      value: resource === null ? null : round1(readings[resource] ?? 0),
      disk: resource === 'disk' && worstDisk ? worstDisk.mount : null,
      ratios,
      culprit,
    }
  }

  /**
   * Start one extraction batch for every application still missing an icon.
   * Called only while a client is reading the detail payload, so a machine that
   * never opens the breakdown pays nothing for icons.
   */
  ensureIcons() {
    if (this.iconChild !== null || this.disposed) return
    if (Date.now() - this.iconAttemptAt < ICON_RETRY_MS) return
    const pending = []
    for (const [label, path] of Object.entries(this.appPaths)) {
      if (typeof path !== 'string' || path === '') continue
      if (this.iconKeys.has(label) || this.iconRequested.has(label)) continue
      pending.push({ label, path })
      if (pending.length >= ICON_MAX_APPS) break
    }
    if (pending.length === 0) return
    this.iconAttemptAt = Date.now()
    for (const item of pending) this.iconRequested.add(item.label)
    this.startIconChild(pending)
  }

  /** Spawn the short-lived icon extractor and feed it the batch on stdin. */
  startIconChild(items) {
    const candidates = this.interpreterCandidates()
    const executable = candidates[this.iconInterpreter % candidates.length]
    this.iconInterpreter += 1
    let child
    try {
      // Same reason as the sampler: a file has no command-line ceiling, and the
      // extractor shares the process's stdin for its batch.
      writeScript(this.iconScriptPath, ICON_SCRIPT)
      child = spawn(
        executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.iconScriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      )
    } catch (error) {
      this.diagnostics.iconError = error.message
      return
    }
    this.iconChild = child
    let buffer = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }, ICON_TIMEOUT_MS)
    timer.unref?.()
    const settle = () => {
      clearTimeout(timer)
      if (this.iconChild === child) this.iconChild = null
      this.ingestIcons(buffer)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
    })
    child.on('error', (error) => {
      this.diagnostics.iconError = error.message
      settle()
    })
    child.on('exit', settle)
    child.stdin.on('error', () => {
      // The child may exit before reading its input; nothing to recover.
    })
    const encoded = items
      .map((item) => [
        Buffer.from(item.label, 'utf8').toString('base64'),
        Buffer.from(item.path, 'utf8').toString('base64'),
      ].join('\t'))
      .join('\n')
    child.stdin.end(Buffer.from(encoded, 'utf8').toString('base64'))
  }

  /** Cache the PNGs one extraction batch returned, keyed by content. */
  ingestIcons(text) {
    const trimmed = text.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    const list = Array.isArray(message?.icons) ? message.icons : message?.icons ? [message.icons] : []
    for (const item of list) {
      if (!item || typeof item.label !== 'string' || typeof item.data !== 'string') continue
      if (this.iconKeys.has(item.label)) continue
      let bytes
      try {
        bytes = Buffer.from(item.data, 'base64')
      } catch {
        continue
      }
      if (bytes.length === 0 || bytes.length > 262144) continue
      const key = createHash('sha1').update(item.label).update('\0').update(bytes).digest('hex').slice(0, 16)
      this.icons.set(key, bytes)
      this.iconKeys.set(item.label, key)
    }
  }

  /** Turn cumulative processor seconds into a CPU percentage per process. */
  ingestProcesses(list, gpuByPid, sampledAt) {
    if (!Array.isArray(list)) return
    const gpu = gpuByPid && typeof gpuByPid === 'object' ? gpuByPid : {}
    const elapsed = this.previousProcAt > 0 ? (sampledAt - this.previousProcAt) / 1000 : 0
    const usable = elapsed > 0.2 && this.coreCount > 0
    const next = new Map()
    const rows = []
    for (const item of list) {
      if (!item || typeof item.pid !== 'number') continue
      const cpuSeconds = Number(item.cpu) || 0
      const before = this.previousProcCpu.get(item.pid)
      next.set(item.pid, cpuSeconds)
      let usage = 0
      if (usable && before !== undefined) {
        usage = round2(percent(((cpuSeconds - before) / elapsed / this.coreCount) * 100))
      }
      const label = typeof item.desc === 'string' && item.desc !== '' ? item.desc : String(item.name ?? `pid ${item.pid}`)
      rows.push({
        pid: item.pid,
        name: String(item.name ?? ''),
        label,
        cpu: usage,
        memory: Number(item.ws) || 0,
        gpu: round1(percent(Number(gpu[String(item.pid)]) || 0)),
        start: Number(item.start) > 0 ? Number(item.start) : null,
        // Per-process disk is only known when the throttled sample has landed,
        // and it is keyed by process name because that is what PDH instances are.
        diskRead: round1(this.diskIoRates.get(String(item.name))?.read ?? 0),
        diskWrite: round1(this.diskIoRates.get(String(item.name))?.write ?? 0),
      })
    }
    this.previousProcCpu = next
    this.previousProcAt = sampledAt
    this.processes = rows
    this.processSampleAt = sampledAt
    this.aggregateApps(rows)
  }

  /**
   * Fold the process rows into one entry per application label. The overview
   * payload needs only the leaders (for the health sentence), while a detail
   * request ships the raw rows and lets the Client group them.
   */
  aggregateApps(rows) {
    const totals = new Map()
    for (const row of rows) {
      const label = row.label || row.name || `pid ${row.pid}`
      let entry = totals.get(label)
      if (entry === undefined) {
        entry = { label, count: 0, cpu: 0, memory: 0, gpu: 0, diskRead: 0, diskWrite: 0 }
        totals.set(label, entry)
      }
      entry.count += 1
      entry.cpu += row.cpu
      entry.memory += row.memory
      if (row.gpu > entry.gpu) entry.gpu = row.gpu
      entry.diskRead += row.diskRead ?? 0
      entry.diskWrite += row.diskWrite ?? 0
    }
    this.appTotals = totals
    this.recordAppMemory(Date.now())
  }

  /**
   * Fold one per-process disk reading into rates.
   *
   * Cumulative bytes in, bytes-per-second out, differenced against the previous
   * reading — the same shape as the network source, and for the same reason: the
   * sampler only visits this every thirty seconds, and a rate sampled that rarely
   * would describe one second out of thirty.
   * @param sample - `{ name: { read, write } }` cumulative byte counts.
   * @param now - the sample timestamp.
   */
  updateDiskIo(sample, now) {
    const seconds = this.diskIoAt > 0 ? (now - this.diskIoAt) / 1000 : 0
    const rates = new Map()
    for (const [name, value] of Object.entries(sample ?? {})) {
      const read = Number(value?.read)
      const write = Number(value?.write)
      if (!Number.isFinite(read) || !Number.isFinite(write)) continue
      const before = this.diskIoSeen.get(name)
      let deltaRead = 0
      let deltaWrite = 0
      if (before !== undefined && seconds > 0) {
        deltaRead = read - before.read
        deltaWrite = write - before.write
        // A negative delta is a recycled PID or a restarted process, not
        // negative traffic.
        if (deltaRead < 0 || deltaWrite < 0) {
          deltaRead = 0
          deltaWrite = 0
        }
      }
      this.diskIoSeen.set(name, { read, write })
      rates.set(name, {
        read: seconds > 0 ? deltaRead / seconds : 0,
        write: seconds > 0 ? deltaWrite / seconds : 0,
      })
    }
    // Processes that have exited keep no rate; drop them so the map does not
    // grow without bound over a long session.
    for (const name of [...this.diskIoSeen.keys()]) {
      if (!(name in (sample ?? {}))) this.diskIoSeen.delete(name)
    }
    this.diskIoRates = rates
    this.diskIoAt = now
  }

  /** Capture one per-application memory baseline, rate-limited to the interval. */
  recordAppMemory(now) {
    if (now - this.appMemoryAt < APP_MEMORY_INTERVAL_MS) return
    this.appMemoryAt = now
    const snapshot = new Map()
    for (const [label, entry] of this.appTotals) snapshot.set(label, entry.memory)
    this.appMemory.push({ t: now, mem: snapshot })
    if (this.appMemory.length > APP_MEMORY_SAMPLES) this.appMemory.shift()
  }

  /**
   * Per-application memory movement over the longest window available, so a
   * slowly leaking process rises to the top instead of hiding under whatever
   * happens to be largest right now.
   * @returns the measured window and the biggest movers, largest first.
   */
  appGrowth() {
    const history = this.appMemory
    if (history.length < 2) return { windowSec: 0, rows: [] }
    const newest = history[history.length - 1]
    const target = newest.t - APP_GROWTH_WINDOW_MS
    let baseline = history[0]
    for (const entry of history) {
      if (entry.t <= target) baseline = entry
    }
    const windowSec = Math.round((newest.t - baseline.t) / 1000)
    if (windowSec < 60) return { windowSec, rows: [] }
    const rows = []
    for (const [label, memory] of newest.mem) {
      const before = baseline.mem.get(label)
      if (before === undefined) {
        rows.push({ label, delta: memory, current: memory, fresh: true, count: this.appTotals.get(label)?.count ?? 0 })
        continue
      }
      const delta = memory - before
      if (Math.abs(delta) < APP_GROWTH_FLOOR) continue
      rows.push({ label, delta, current: memory, fresh: false, count: this.appTotals.get(label)?.count ?? 0 })
    }
    rows.sort((left, right) => right.delta - left.delta)
    return { windowSec, rows: rows.slice(0, APP_GROWTH_ROWS) }
  }

  /** Record a spawn-level failure and try the next interpreter straight away. */
  failChild(reason) {
    this.gpu.status = 'unavailable'
    this.gpu.reason = reason
    this.scheduleRestart(true)
  }

  /** React to the child ending, distinguishing a deliberate stop from failure. */
  onChildExit(detail) {
    if (this.child === null) return
    this.child = null
    if (this.disposed) return
    // Only an explicit idle stop should read as "idle" rather than a fault.
    if (this.coldRate === 0 && Date.now() - this.touchedAt >= RATE_ACTIVE_MS) {
      this.gpu.status = this.gpuUnsupported ? 'unavailable' : 'idle'
      this.gpu.reason = null
      this.gpu.engines = null
      return
    }
    if (!this.gpuUnsupported) {
      this.gpu.status = this.gpu.updatedAt > 0 ? 'degraded' : 'unavailable'
      this.gpu.reason = { code: 'sampler-stopped', detail: detail || null }
    }
    // An interpreter that never started is a PATH problem, not a crash: moving
    // to the next candidate immediately is what makes the fallback chain work.
    this.scheduleRestart(this.diagnostics.spawnError !== null)
  }

  /** Retry the child, after a delay or immediately when the interpreter is missing. */
  scheduleRestart(immediate = false) {
    if (this.restartTimer !== null || this.disposed || this.attempts > LIVE_MAX_ATTEMPTS) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.disposed) return
      if (this.coldRate > 0 || Date.now() - this.touchedAt < RATE_ACTIVE_MS) this.startChild()
    }, immediate ? 0 : LIVE_RESTART_MS)
    this.restartTimer.unref?.()
  }

  /** Terminate the child without triggering the restart path. */
  killChild() {
    const child = this.child
    this.child = null
    if (child === null) return
    child.stdout?.removeAllListeners()
    child.stderr?.removeAllListeners()
    child.removeAllListeners('exit')
    child.removeAllListeners('error')
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  /** The immutable payload the client polls for. */
  snapshot(options = {}) {
    const now = Date.now()
    const windowSec = resolveWindow(options.window)
    const cutoff = now - windowSec * 1000
    const within = (points) => points.filter((point) => point.t >= cutoff)
    const payload = {
      ts: now,
      revision: SAMPLER_REVISION,
      protocol: SAMPLER_PROTOCOL,
      intervalMs: SAMPLE_MS,
      host: {
        hostname: this.hostname,
        os: this.osLabel,
        uptimeSec: Math.round(os.uptime()),
        samplerUptimeSec: Math.round((now - this.startedAt) / 1000),
      },
      cpu: {
        model: this.cpuModel,
        cores: this.coreCount,
        speedMhz: this.cpuSpeedMhz,
        actualMhz: this.actualMhz(),
        nominalMhz: Number(this.system.cpuNominalMhz) || this.cpuSpeedMhz,
        usage: this.cpuUsage,
        perCore: this.perCore,
        history: this.cpuHistory,
        timeline: this.coreHistory.map((row) => row.slice(-CORE_COLUMNS)),      },      memory: {
        total: this.memory.total,
        used: this.memory.used,
        free: this.memory.free,
        usage: this.memory.usage,
        committed: Number(this.system.committedBytes) || null,
        commitLimit: Number(this.system.commitLimitBytes) || null,
        cached: Number(this.system.standbyBytes) || null,
        pageFilePct: Number.isFinite(Number(this.system.pageFilePct)) && this.system.pageFilePct !== undefined
          ? round1(Number(this.system.pageFilePct))
          : null,
        history: this.memHistory,
      },
      gpu: {
        status: this.gpu.status,
        reason: this.gpu.reason,
        util: this.gpu.util,
        dedicated: this.gpu.dedicated,
        shared: this.gpu.shared,
        engines: this.gpu.engines,
        adapters: this.gpu.adapters,
        updatedAt: this.gpu.updatedAt,
        history: this.gpuHistory,
        diagnostics: { ...this.diagnostics },
      },
      disks: this.disks,
      windowSec,
      series: downsample(within(this.series)),
      io: downsample(within(this.ioHistory)),
      latency: downsample(within(this.latencyHistory)),
      storage: this.storage,
      clock: this.clock(),
      bottleneck: this.bottleneck(),
      alertLog: this.alertLog,
      summary: this.summary(),
      forecast: this.forecast(),
      alerts: this.alerts(),
      health: this.health(),
      capabilities: this.capabilities(),
      config: this.config,
    }
    if (options.detail === true) {
      this.ensureIcons()
      payload.detail = {
        sampledAt: this.processSampleAt,
        processes: this.processes,
        physicalDisks: this.physicalDisks,
        appIcons: Object.fromEntries(this.iconKeys),
        appPaths: this.appPaths,
        growth: this.appGrowth(),
      }
    }
    return payload
  }
}
