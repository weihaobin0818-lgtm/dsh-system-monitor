# dsh-system-monitor

A DSH bundle that puts a live hardware monitor in the Harness sidebar: **CPU, GPU,
memory and disk** on one page, refreshed once a second, with a per-application
breakdown — including each application's own icon — behind every gauge.

---

## 中文说明

在 DSH 侧栏放一个实时硬件监控面板。**CPU、GPU、内存、磁盘**一页看完，每秒刷新，
每个读数都能下钻到具体是哪个应用占的（带应用自己的图标）。

### 它和任务管理器的区别

任务管理器告诉你 CPU 是 80%，但不会告诉你**是谁**占的、**还会涨多久**、**什么时候会满**。
这个插件把这三件事一起答了。

### 平台要求

| | |
|---|---|
| **系统** | **Windows 10 / 11 —— 完整功能需要** |
| DSH | 带 Web 界面的 profile（`dsh web`） |
| Node | 20 或更高（Harness 运行时已满足） |
| 权限 | **不需要管理员**，全部读取当前用户自己会话内的数据 |

**Linux 和 macOS 上仍可安装运行**，但会降级为 Node 原生读数：CPU、内存和根卷。
GPU、按进程归因、图标、磁盘吞吐和电池都会报告为不可用 —— 对应的面板会**隐藏而不是显示为空**。

### 主要功能

- **概览** —— 三个环形仪表（CPU / 内存 / GPU）+ 趋势图 + 核心热力图 + 磁盘列表
- **按应用归因** —— 点任意读数进入明细，看是哪些进程、占多少、可展开到单个进程
- **预测** —— 磁盘写满时间、内存耗尽时间，基于实测斜率而不是线性外推
- **告警** —— 超过阈值时弹提示、写入告警历史、侧栏图标显示徽标
- **导出** —— CSV / JSON / NDJSON，走系统「另存为」对话框，可自选目录和文件名
- **历史** —— 滚动写 NDJSON 到磁盘，默认保留 7 天，上限一年
- **自定义时间范围** —— 预设 1 / 5 / 30 分钟，也可输入任意分钟数（最多 3 小时，即内存保留上限）

### 安装

```bash
dsh plugin install dsh-system-monitor
```

或者开发时用 `link:` 指向本地目录，详见下方 [Installing it](#installing-it)。

### 关于本文档

以下正文为英文。中文只覆盖到这里 —— 接口、配置项和实现细节请往下读。
配置项的含义在 [Configuration](#configuration) 一节，每个都有说明。

---

## Requirements

| | |
|---|---|
| **Platform** | **Windows 10 / 11 for the full feature set** |
| DSH | a profile with the web surface (`dsh web`) |
| Node | 20 or newer — the Harness runtime already qualifies |
| Privileges | none; everything is read from the current user's own session |

On Linux and macOS the bundle still installs and runs, but degrades to the
Node-native readings only: CPU, memory and the root volume. GPU, per-process
attribution, icons, disk throughput and battery all report as unavailable, and
their panels are **hidden rather than shown empty**.

### When the two halves disagree

The Client is rebuilt and reserved every time the page loads. **The Host module
is not** — it lives in the DSH process until DSH is restarted. So during
development the two drift apart constantly, and a mismatch used to present itself
as whatever it happened to break: a panel that vanished, an export that blanked
the window, data that was quietly empty. Nothing pointed at the version.

So the Host declares a **protocol** number, and the Client refuses to pretend:

| | |
|---|---|
| `SAMPLER_PROTOCOL` in `metrics.js` | The wire contract. Bumped only when the payload's *shape* changes incompatibly — a renamed field, a changed unit, a removed key. Not for a bug fix. |
| `REQUIRED_PROTOCOL` in `client.js` | What this Client was written against. |
| Mismatch | A banner at the top of the panel naming both numbers, saying to restart DSH. |

A Host reporting no protocol at all is treated as protocol 0, not as compatible —
reading a missing field as "fine" would silence the warning in exactly the case it
exists for.

### When the collector itself fails

A sampler that cannot start is not a resource reading, but it is the most
important thing this plugin can report: every counter-backed panel loses its data
when it happens. It rides the **existing alert channel** rather than a second
mechanism of its own, so the log line, the toast and the sidebar badge all pick it
up for free.

It is announced **once**, not every tick — a repeating alert is noise, and noise
is how a real alert gets ignored. It carries a code and no value, and the
renderers leave the unit off rather than printing `sampler null%`. A sample
arriving clears it.

### Per-application disk throughput

Ranked separately from CPU, memory and GPU, and sampled on its own slower clock —
a `PerformanceCounter` per process name is not free, and disk attribution changes
on a scale of minutes. Measured at about 11 ms for eight names.

The reading is the counter's **RawValue**, which is cumulative bytes, differenced
in Node. This matters: `IO Read Bytes/sec` is a *rate*, and a rate sampled once
every thirty seconds describes the one second it was sampled in, not the thirty.
Cumulative counters are correct at any cadence — the same lesson the network
source taught before it was removed.

A counter that goes backwards (a recycled PID, a restarted process) yields no
rate rather than negative traffic, and exited processes are dropped so the
baseline map does not grow without bound over a long session.

### Security model, stated plainly

**This plugin is for a single-user machine and its routes are not authenticated.**

Its four HTTP endpoints bind to loopback, and anything that can reach
`127.0.0.1` on this machine can read them. What they expose is not trivial: the
name and full executable path of every running process, the list of volumes, and
the machine's hostname. On a shared or multi-user host that is an information
disclosure, and no amount of care inside the plugin changes it.

The choice was deliberate rather than an oversight. An authenticated channel
would mean a token the user has to manage, or an RPC surface that ties the plugin
to one Harness transport — costs paid by every user to defend against a threat
that only exists on a machine they share. So the honest thing is to say what this
is, and let the reader decide:

- **Single-user machine** — fine as it is.
- **Shared machine, terminal server, or anything with other logged-in users** —
  do not run this. Loopback is not a security boundary between users on the same
  host.

Nothing is written outside `~/.dsh-system-monitor/`, nothing is sent anywhere,
and no elevated privileges are requested.

## What it adds

| Where | What |
|---|---|
| `sidebar.panellist` (id `system-monitor`) | The gauge icon in the left rail; its label is the panel title and the accessible name |
| `main` (key `system-monitor`) | The page that icon opens |

The overview shows ring gauges with 60-second sparklines for CPU, memory and GPU,
a per-logical-core column chart, and a used/free bar per volume. Colour follows
the theme: brand below 70 %, warn from 70 %, error from 90 %.

Each card answers more than "how much":

- **CPU** reports the *real* clock speed, derived from the turbo ratio the
  processor is actually running at, next to the nominal one.
- **Memory** is broken out of its single percentage: free, standby cache, and the
  committed/limit pair. That last one is the useful one on Windows — a machine can
  read 80 % physical while the commit charge has already passed RAM and the page
  file is doing the work.
- **GPU** carries the per-engine-type breakdown, shown on its detail tab.

A badge on the sidebar icon turns amber, then red, when a resource stays above
its threshold — so a problem is visible without opening the panel at all.

## Visualisations

| Element | What it shows |
|---|---|
| Ring gauges | Current CPU, memory and GPU, each with a 60-second sparkline and a ▲/▼ against ten seconds ago |
| **Trend chart** | CPU, memory and GPU on one shared timeline. Hovering locks a crosshair and reports all three series at that moment, which is what makes a spike attributable |
| Per-core columns | Instant load of every logical core |
| **Core heatmap** | The same cores across 40 seconds, newest column at the right — a single pegged core stands out here in a way a bar chart misses |
| **Memory composition** | A stacked bar of the top six applications by working set, then everything else and free memory, with an icon legend (memory tab) |
| **Disk throughput** | Read and write history on one shared scale, above the per-volume and per-physical-disk rows (disk tab) |
| GPU engines | Busiest engine first — 3d, copy, video decode, compute (GPU tab) |
| Application tables | Per-application bars, scaled to the largest row shown |

Chart colours (the heat ramp and the composition palette) are deliberately not
theme tokens: a heat ramp needs fixed hues per severity bucket, and a categorical
palette needs evenly separated hues. Both use one fixed lightness and saturation
so they stay legible in light and dark themes. Everything else is `--dsw-alias-*`.

### Look and feel

The page follows the Harness design language rather than inventing one: flat
cards with a `.5px` hairline border on `--dsw-alias-bg-layer-1`, `--dsw-radius-xl`
corners, a `20-21px/600` page title over `14px/600` card titles, `tabular-nums`
on every figure, and focus rings built from `--dsw-focus-ring-*`. Depth comes
from layered backgrounds (layer-1 card, layer-2 detail surface, layer-3 wells and
tracks) instead of drop shadows, which is how the shipped pages do it.

Each gauge card carries a faint radial tint and a resource glyph in its own state
colour, so the three cards are distinguishable before any text is read. The live
indicator pulses only while readings are arriving, and every transition is
disabled under `prefers-reduced-motion`.

The stylesheet uses 27 `--dsw-*` tokens, all of them ones the shipped Harness
pages already reference — no token name is guessed, so a rename degrades
appearance rather than breaking rendering.

Clicking a gauge — or its title button — opens **占用明细 / Usage details** for that
resource, which answers "which application is using it?":

| Tab | Rows |
|---|---|
| CPU | Applications ranked by CPU share of the whole machine, with memory beside |
| 内存 | Memory composition bar, then applications ranked by working set with CPU beside |
| GPU | Engine-type breakdown, then applications ranked by GPU utilisation |
| 磁盘 | Throughput history, volumes with used/total/free, then per-physical-disk rates |

The three application tabs also carry a **按占用 / 按增长** switch: usage ranks by
the tab's resource, growth ranks by memory movement over the last few minutes.
Selecting a row expands it into that application's own processes.

Rows are grouped by application, so twelve `msedge` processes appear once with a
process count and one icon. Bars scale to the largest row shown; the exact value
is always in the number column.

## Attribution

The detail tables answer "who is using it". Two things go further, because
absolute numbers hide the two cases people actually care about.

**Growth ranking.** The Host captures a per-application memory baseline every
30 s and keeps ten minutes of them. The **按增长 / By growth** switch ranks
applications by memory *movement* over the longest window available, so a
process leaking slowly rises to the top instead of hiding underneath whatever
happens to be largest right now. Applications that did not exist in the baseline
are tagged as new rather than reported as growth, movement under 8 MB is treated
as noise, and the row states the window it actually measured. In a 62-second
observed window the largest movers were a chat client at +42.7 MB, a shell at
+41.2 MB, and the Harness itself at **−191.0 MB** — the last one being memory it
had just released, which no absolute reading would ever show.

**Single application detail.** Selecting any row expands it to that
application's own processes — PID, CPU, memory, GPU and start time — plus the
executable path it was resolved from. This is where "which of Chrome's nine
processes is the problem" gets answered, and it is why the tables group by
application in the first place.

Start times come from `Process.StartTime`, which throws for protected processes;
about 141 of 260 processes on the development machine expose one, and the rest
show a dash.

## History, export and persistence

**Time range.** The Host keeps thirty minutes of aligned samples and the header
offers **1 / 5 / 30 分钟**. Whatever the window, the payload is reduced to 180
points, so a thirty-minute view costs the same ~9 KB as a one-minute one, and an
out-of-range request is clamped to the nearest offered window rather than
trusted.

**Session summary.** Extremes since the peaks were first accumulated — CPU,
memory, GPU and disk latency — each with the moment it happened and *which
application was to blame at that time*, plus the running averages. A live
reading answers "what now"; this answers "how bad has it been".

**Export.** `GET …/export?format=csv|json|ndjson&scope=series|apps|full&window=…`
answers three different questions, each with the formats that suit it:

| Scope | What it is | Formats |
|---|---|---|
| `series` | One row per sample: CPU, memory, GPU, disk read/write, latency, queue | CSV · JSON · **NDJSON** |
| `apps` | Per application **now**: processes, CPU, memory, GPU, growth, executable path | CSV · **NDJSON** |
| `full` | One bundle with every reading, capability, the config, alert history and session peaks | JSON |

All carry `content-disposition: attachment`, so the Status tab links to them
directly. Series sampled at different rates leave gaps in each other's rows
rather than being resampled into numbers that were never measured.

`apps` is point-in-time, not a window average, because per-application history is
not retained — only the current aggregate and the memory-growth baseline. The
growth columns are the exception: they describe a real span and carry the span
they measured.

### Why NDJSON is the format to standardise on

`format=ndjson` writes one complete JSON object per line. It is the format a
sampler *would* log to, and it beats CSV on the three properties that matter for
a log that grows while you watch it:

| | CSV | NDJSON |
|---|---|---|
| **Append** | Safe, but the header defines the schema | Safe, and each line is self-describing |
| **Adding a field** | Invalidates every existing file — old rows now have the wrong shape | Old rows stay valid; they simply lack the field |
| **Torn write** | A partial flush corrupts the row, and often the parse of everything after it | Costs exactly one line |
| **Nesting** | Impossible — the app's executable path is fine, a nested object is not | Native |
| **Reading it** | Every spreadsheet | `jq`, `pandas.read_json(lines=True)`, DuckDB `read_ndjson_auto()` |

The last row is the practical argument. DuckDB turns a month of NDJSON into SQL
or Parquet in one statement, with no import step:

```sql
-- query it directly
SELECT date_trunc('minute', to_timestamp(t / 1000)) AS minute, avg(cpu), max(mem)
FROM read_ndjson_auto('system-monitor-series-*.ndjson')
GROUP BY 1 ORDER BY 1;

-- or convert the archive to a columnar file
COPY (SELECT * FROM read_ndjson_auto('system-monitor-*.ndjson'))
TO 'monitor.parquet' (FORMAT PARQUET);
```

CSV remains the default for the same reason it always was: it is what people open
in Excel. JSON remains for the case where one document is wanted rather than rows.

**Long-term history.** One NDJSON file per day under `~/.dsh-system-monitor/history/`,
appended in thirty-second batches — writing straight through at one sample a
second would be 86,400 file appends a day for a monitor nobody is watching.

Retention is **bounded on purpose**. `historyDays` defaults to 7 and is clamped
to a year, and the prune runs on every flush rather than on a schedule that might
not survive a restart. A monitor that silently fills a disk is a worse bug than
one with no history at all, so this is not configurable into a problem:

| `historyDays` | Effect |
|---|---|
| `7` (default) | One week of per-second samples, about 60 MB |
| `0` or negative | History off entirely; nothing is buffered, let alone written |
| `99999` | Clamped to 365 |

At roughly 100 bytes a line, a day costs about 8 MB. The files are the same
NDJSON the export writes, so a month of them is one DuckDB query.

**Persistence.** Extremes, the alert log and a downsampled chart tail are written
to `~/.dsh-system-monitor/state.json` — at most once a minute, and only when a
peak or an alert actually changed. On the next start they are restored, so the
plugin can still answer "has it been like this all week" after a restart:

```
startedAt : 2026-10-11T14:56:38Z   (this process)
since     : 2026-10-11T14:55:14Z   (peaks accumulated since — restored)
cpu peak  : 18.2%  at 14:55:52  label=DeepSeek Harness
series    : 35 points already there before the first sample
```

Set `persist: false` to disable it. Every read and write is wrapped: a read-only
home directory is a valid environment, not an error, and a failed save is
silently skipped rather than surfaced as a plugin fault.

## Forecasts

Two things actually run out, so two things are projected: free disk space and
commit charge. Both are sampled once a minute into an hour-long series, and both
are fitted with a least-squares slope.

The design rule is **never state a projection the data does not support**:

- A volume is only projected when its trend is genuinely downward, the baseline
  spans at least ten minutes, and the answer is under ten years.
- Memory is only projected when the commit charge is genuinely rising and the
  baseline spans at least five minutes.
- The raw slope and the measured window are always reported, so a flat trend
  reads as *"measured, going nowhere"* rather than looking broken. The card says
  `按最近 12 分钟的速度，容量基本不变` instead of showing nothing.

| Case | Result |
|---|---|
| 50 GiB free, losing exactly 1 GiB/day, 10 min window | `daysLeft: 50` |
| Same volume, flat | slope 0, `daysLeft: null` |
| Same volume, 4 min window | slope measured, `daysLeft: null` |
| Volume *gaining* space | `daysLeft: null` — never projects a fill-up |
| Commit +1 GiB over 25 min, 9 GiB headroom | `secondsLeft: 13500` (exact) |
| Commit shrinking | `secondsLeft: null` |

**Battery** comes from `Get-CimInstance Win32_Battery`, polled every twelfth
sample because it is a slow query and battery state changes on a scale of
minutes. It is probed *inside* the loop rather than at startup so a machine where
CIM is unavailable cannot delay the first reading. Note that the
`Battery Status` performance counter set does not exist on Windows at all — CIM
is the only route — and `EstimatedRunTime` is reported as zero while charging, so
implausible values are dropped rather than shown as "0 minutes left".

## Dashboard layout

The panel is built for a wall display as much as for a laptop.

**Density.** **舒适 / Compact** switches every size that matters — ring gauge
104→84 px, trend chart 168→108 px, per-core bars 60→36 px, plus tighter padding
and card gaps. Compact fits the whole dashboard on a 1080p screen; the page still
scrolls if it has to, so nothing can become unreachable. The choice is kept in
`localStorage` and survives a reload.

**Responsive columns.** The page is capped at 1560 px, the three gauges reflow at
240–276 px, and the core grid and disk card sit in one `auto-fit` region: stacked
on a narrow window, side by side on a wide one. Previously they were always
stacked, which wasted most of a wide screen.

**Trend chart.** It is the centrepiece, so it carries more:

- a **time axis** — clock times for long windows, `−30s`-style offsets for short
  ones, whichever the reader is actually asking for;
- **alert spans** rather than single markers. A transition sets the level until
  the next one, and that interval is shaded, so you can see *how long* something
  stayed bad instead of only when it tripped;
- a **peak marker** per series, so a spike that has already passed is still
  readable rather than looking like a quiet stretch.

Every one of these is measured in the render suite rather than assumed: the
harness counts axis ticks, shaded spans and peak dots, and asserts the ring,
chart and core-bar sizes for both densities.

## Diagnostics


Four checks run on every sample and answer "is something actually wrong", not
just "what are the numbers".

**Resource pressure.** Each resource is scored 0–1 against what counts as
*saturated* for it — CPU 90 %, memory 95 %, GPU 95 %, disk 50 ms latency or a
queue of 4 — and the worst one is named as the bottleneck in the header line.
Capacity is deliberately excluded: a 90 % full disk is not a slow disk. The
Status tab draws all four as bars, with the bottleneck highlighted.

**CPU throttling.** Live clock ÷ nominal, but only while the CPU is above 45 %.
A low clock at idle is power management, not throttling, and flagging it would
make the chip meaningless. Above the load floor, a ratio under 0.85 raises a
chip on the CPU card and the session peak clock stays visible for comparison —
on the development machine that is 2.0 GHz nominal against a 4.07 GHz peak.

**Disk contention.** `Avg. Disk sec/Transfer` and `Current Disk Queue Length`
sit alongside throughput on the disk card, in the disk tab and in a latency
history. Throughput alone cannot distinguish a busy disk from an idle one moving
the same bytes; latency and queue depth can.

**Alert history.** Every alert-level transition is recorded with its reasons, so
"when did this start" has an answer. Transitions appear as vertical markers on
the trend chart, aligned with whatever the chart was doing at that moment, and
as a list on the Status tab. Only *changes* are recorded, and the log is bounded,
so a flapping resource cannot grow it without limit.

## How the numbers are collected

Everything runs in the Host half, which keeps one sampling cadence regardless of
how many pages are open.

- **CPU** — `os.cpus()` time deltas per logical core, aggregated and per-core.
- **Memory** — `os.totalmem()` / `os.freemem()`.
- **Disk** — `fs.statfs` over the mounted drive letters, re-scanned every 20 s.
- **GPU, clock speed, memory composition, processes, disk throughput and latency**
  — one long-lived PowerShell child. It reads the WDDM performance counters
  `\GPU Engine(*)\Utilization Percentage`, `\GPU Adapter Memory(*)\{Dedicated,Shared} Usage`,
  `\PhysicalDisk(*)\{Disk Read Bytes/sec,Disk Write Bytes/sec,Avg. Disk sec/Transfer,Current Disk Queue Length,Disk Transfers/sec}`,
  the single-instance `\Processor Information(_Total)\% Processor Performance` and `Processor Frequency`,
  `\Memory\{Available MBytes,Committed Bytes,Commit Limit,Standby Cache Normal Priority Bytes}`
  and `\Paging File(_Total)\% Usage`, plus the process table through `Get-Process`,
  and streams one compact JSON line per sample.

Every counter is probed for existence at startup and simply omitted when absent,
so a machine without GPU or page-file counters degrades instead of failing.

Two deliberate choices there:

- GPU utilisation is the busiest engine type, matching Task Manager's reading.
  Per-process GPU comes free from the same counters, whose instance names carry
  the owning `pid`.
- `Get-Process` is used for the process table because it costs ~15 ms, whereas
  the `\Process(*)\IO * Bytes/sec` counters that would give **per-process** disk
  I/O cost ~1.3 s of CPU per sample. That price is not worth paying in a monitor,
  so the disk tab reports per-volume and per-physical-disk throughput instead.

Process CPU is reported as cumulative processor seconds and converted to a
percentage in Node, which is the only half that knows the wall-clock delta. It is
kept to two decimals: one process usually holds a small share of a many-core
machine, and the client sums those shares per application.

The child is **demand-driven**: it starts when a browser first polls and stops
after 20 s without a request, so an unopened panel costs nothing. Failure is
reported rather than hidden — the panel says why (counters missing, sampler
stopped, and so on) and `gpu.diagnostics` carries the interpreter, its PowerShell
version and the last stderr line. Interpreters are tried in order (`pwsh`,
`powershell`, then absolute fallback paths) and a missing one advances the chain
immediately rather than waiting for the retry timer.

## Application icons

The detail tables show each application's real icon, taken from its executable.

- The live sampler reports one executable per application label, choosing the
  largest process behind that label because launchers and crash handlers often
  share an image name.
- When a detail view opens, the Host starts one short-lived PowerShell child that
  calls `System.Drawing.Icon.ExtractAssociatedIcon` for every application still
  missing an icon and answers with base64 PNGs. Results are cached by content and
  served from `GET /dsh-system-monitor/icon?key=…` with a one-day cache header.
- Input crosses the process boundary as base64 text, never JSON or a raw path:
  Windows PowerShell 5.1 parses a JSON array differently from 7, and a path
  outside the console code page would arrive corrupted. The extractor therefore
  behaves identically on both.
- The route only serves keys the sampler itself cached, so it can never be turned
  into an arbitrary file read — unknown keys, traversal attempts and other paths
  all answer 404.
- An application whose executable is not readable (elevated and system processes
  mostly) gets a coloured initial instead, so every row is identifiable.

## Sidebar alert badge

`ALERT_THRESHOLDS` in `metrics.js` holds one threshold per resource — CPU 85 %,
memory 92 %, GPU 95 %, the busiest volume 92 %. A reading must stay above its
threshold for `ALERT_SUSTAIN_MS` (5 s) before the badge lights, so a single spike
never does; it turns red once the reading passes the threshold by
`ALERT_HIGH_MARGIN`. The memory threshold is deliberately above the point where
Windows' own caching would raise a false alarm.

The icon polls `GET /dsh-system-monitor/alerts` every 5 s. That route
deliberately does **not** keep the live PowerShell child alive: the badge is
always mounted, so waking the sampler for it would cost CPU around the clock. It
reports the always-sampled CPU, memory and disk readings, and GPU only joins in
while a panel already has the child running. The panel shows the same state as a
banner above the gauges.

## Transport

The Host registers one loopback HTTP prefix, `/dsh-system-monitor`, with three
endpoints, all answering instantly from a cached snapshot:

| Endpoint | Purpose |
|---|---|
| `GET …/metrics` | The overview payload: current readings, history and the aligned series |
| `GET …/metrics?detail=1` | The same plus per-application rows and their icons |
| `GET …/metrics?window=60\|300\|1800` | Windowed history, always reduced to 180 points |
| `GET …/icon?key=…` | One cached application PNG |
| `GET …/alerts` | The sustained-load badge state |
| `GET …/export?format=csv\|json\|ndjson&scope=series\|apps\|full&window=…` | Samples, per-application rows, or one full bundle |

The Client half polls them with `fetch` resolved against `document.baseURI`, so it
follows whatever host, port and mount the Web UI is served from without
configuration.

## Configuration

Every tunable is read from the loader row's `config`. Override it in the
profile's `cordis.patch.yml` — that layer survives plugin upgrades, unlike the
bundle's own patch:

```yaml
- id: dsh-system-monitor
  config:
    alertMemory: 95
    showGpu: false
```

Two details matter here, and both cost real debugging time:

- **The id is the row id**, not the package name. It is the `id` the bundle's
  `cordis.patch.yml` inserts.
- **Omit `name`.** A patch entry with both an `id` and a `name` re-declares the
  row, and the Loader will not re-apply an `insert` for an id it already knows —
  so the override is silently dropped. An id alone is an override; an id plus a
  name is an insert.

| Key | Default | Meaning |
|---|---|---|
| `alertCpu` / `alertMemory` / `alertGpu` / `alertDisk` | 85 / 92 / 95 / 92 | Percent at which the sidebar badge lights |
| `alertSustainSeconds` | 5 | How long a reading must stay above its threshold first |
| `showGpu` | true | Hide the GPU card and series on machines where the counters misbehave |
| `showClock` | true | Show live CPU clock instead of the nominal one |
| `showDiskThroughput` | true | Show the disk throughput chart |
| `showIcons` | true | Extract and show application icons |
| `showProcesses` | true | Ship the per-application breakdown at all |
| `persist` | true | Keep extremes and the alert log in `~/.dsh-system-monitor/state.json` across restarts |
| `idleSamplingSeconds` | 20 | Cadence with no viewer for 10 min; `0` stops the sampler instead |
| `historyDays` | 7 | Days of rolling NDJSON history kept on disk; `0` disables it |

Forecasts are always computed; they surface on the memory and disk cards and on
the Status tab.

Numbers are clamped and wrong types fall back to the default, so a typo can make
a threshold odd but can never disable the sampler or wedge the page. The
effective values are shown on the Status tab, so what actually took effect is
never a guess.

A `Config` schema is exported when `@deepseek-ai/schemastery` resolves — which it
does for a published npm install, giving the Plugin Manager a real settings form
and validation at activation. It does **not** resolve from a linked development
bundle, so the import is guarded and the plugin stays correct either way; the
defaults live in `resolveConfig` rather than only in the schema.

## Capabilities and the Status tab

Not every machine exposes every counter. Rather than showing an empty panel, the
plugin asks each capability and hides what it cannot measure:

```
cpu available · memory available · diskCapacity available · clockSpeed available
memoryDetail available · gpu available · processGpu available · processes available
diskThroughput available · icons available
```

The **Status** tab lists all ten with a reason for any that are unavailable, and
shows the effective config. Reasons cross the wire as codes (`no-gpu-counters`,
`spawn-failed`, `windows-only`, …) that the Client localizes, so the Host never
composes UI copy and the plugin can ship in any language. A header strip carries
the one-line verdict — `All normal`, or `Above threshold · Memory 94.2% · Top
cause Google Chrome` — computed by the Host from the same thresholds that drive
the badge.

## Alerts that leave the panel

A monitor whose only output is a panel is a monitor nobody reads. Transitions are
delivered three ways, in decreasing order of how much is running:

| Channel | Reaches you when |
|---|---|
| **Toast** in `shell.overlay` | DSH is open, but you are looking at something else — chat, another panel |
| **Log line** via `ctx.logger` | DSH is running at all; this is the only channel that survives having no browser open |
| **Sidebar badge** | The sidebar is visible |

The toast is a list slot in the frame-wide overlay, so it floats above every
column and is not tied to this plugin's panel. Transitions are *detected* by
polling `alerts` rather than pushed, which keeps the Host free of any
client-facing RPC surface; the first poll only establishes a baseline, so opening
a page never produces a toast for a condition that was already true. Toasts carry
their own stylesheet, because the panel's is not mounted when they appear.

Alerts are also evaluated on the sampler's own tick, not only when something
polls — otherwise a threshold crossed with no browser open would go unnoticed,
which is exactly the case the log channel exists for.

## Sampling cadence

The sampler used to stop after twenty idle seconds, which quietly contradicted
the whole retrospective half of the plugin: the history developed holes precisely
when nobody was watching, and an unattended machine is where problems start.

It now **slows down instead of stopping**:

| Idle for | Cadence |
|---|---|
| < 15 s | every pass (~1.7 s) |
| 15 s – 10 min | every 4th pass (~4.7 s) |
| > 10 min | `idleSamplingSeconds` (default 20 s) |

Set `idleSamplingSeconds: 0` to restore the old stop-when-idle behaviour; that is
the only setting under which the sampler child is ever killed for idleness.

The rate is handed over as a small file the child re-reads each pass, named per
Host process so two instances cannot fight over it. That avoids the alternative —
restarting the child to change its cadence — which would cost a fresh first
sample (and a visibly `starting` GPU) every time a panel opened.

Verified end to end by measuring the child's own sample timestamps through
`export`, which is the one endpoint that does not count as a viewer: the gaps run
at ~1.8 s while a panel polls, then switch to ~4.4 s exactly 15 s after the last
one.

## Tests

```sh
npm test              # 95 assertions across four suites
npm run test:mutate   # prove the suite can still fail
```

Plain Node, no framework and no dependencies, because a suite that needs setting
up is a suite that stops being run.

| Suite | Covers |
|---|---|
| `manifest.test.mjs` | Export targets and published files exist; the loader row, the Client module id and the package name all agree |
| `client.test.mjs` | Every render path including the first one, all five tabs, chart features, both densities, and the alert toasts |
| `host.test.mjs` | Config clamping, the forecast regressions, the alert log, the pressure verdict, the sampling cadence and alert delivery |

The Client half is exercised without a browser through a fake module loader and a
fake React. The React stand-in is deliberately faithful in one specific way: when
its hook queue is empty, `useState` returns the initial value the component
passed, exactly as React does. An earlier version did not, which made "what does
this do before any interaction" untestable — and that is precisely the path that
shipped a white-screen bug.

`test/mutate.mjs` exists because a green suite proves nothing until it has been
seen to go red. It reintroduces six real bugs — an unguarded `data.health`, a
Client id that drifts from the package name, a chart that loses its time axis, a
trusted partial payload, a forecast that ignores its minimum baseline, an
unbounded alert log — and asserts the suite names each one. All six are caught.

One assertion was rewritten because of it: the time-axis check matched
`cls.includes('dsm-chartTicks')`, which still matched `dsm-chartTicksDisabled`.
Substring matching on class names produces a test that cannot fail; those checks
are exact matches now.

The mutation runner reports through a file rather than a pipe, because a confined
environment can refuse to give a child process a pipe — and that failure mode is
silent, turning every result into a false "missed".

## Files

| File | Role |
|---|---|
| `monitor.js` | Bundle entry / Host plugin: owns the sampler and the four routes |
| `metrics.js` | Metric collection, the PowerShell live sampler and the icon extractor |
| `client.js` | Sidebar icon, overview page, detail tables and the alert toasts |
| `cordis.patch.yml` | The loader row this bundle inserts |
| `icon.svg` | Plugin-manager card artwork. The card's text lives in `package.json`'s `meta` block. |

## Installing it

```sh
dsh plugin install dsh-system-monitor        # once published
```

For local development the bundle is linked instead, which is what
`plugin_manager` does with a `link:` spec:

```yaml
# ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-system-monitor": "link:/path/to/system-monitor" }
```

### Two Loader behaviours worth knowing

Both cost real debugging time, and neither is obvious from the outside.

**A row id is inserted once.** If the Loader already knows an entry id, an
`insert` for that id is *not* re-applied — so editing the `name` in
`cordis.patch.yml` and reinstalling silently leaves the entry bound to the old
module. Renaming the package means renaming the row id too.

**A failed import is remembered.** After an entry fails to import once, that
module name stays poisoned for the life of the process: later installs of a
package with the same name keep reporting `failed to import` even when the
package resolves correctly from the profile directory. Fixing whatever was
actually wrong is therefore not enough — the name has to change, or the
application has to restart.

The Client half has neither problem: it is served under a content revision and
its watcher picks up edits, so a page reload is enough there.

## Renaming, and releasing

The name is not load-bearing, but it appears in exactly **three** places, and two
of them are silent when they disagree:

| # | File | What |
|---|---|---|
| 1 | `package.json` | `name` |
| 2 | `cordis.patch.yml` | the row `id` **and** its `name` |
| 3 | `client.js` | the `id` in `window.__ModuleLoader__.load({ … })` |

`npm test` fails on any disagreement: `manifest.test.mjs` asserts that the package
name, the loader row name and the Client module id are all the same string. That
is not decoration — a drifted Client id means the sidebar icon and the panel never
register, with no error anywhere.

Renaming in an already-running Harness additionally needs a restart, because the
Loader remembers a failed import for the life of the process.

Before pushing:

```sh
npm test              # assertions across four suites
npm run test:mutate   # injected bugs, all must be caught
npm run release:check # blocks on missing attribution, stray files, private data
```

`release:check` is a separate command rather than part of `npm test` because it
is *expected* to fail until the release metadata is decided. It currently reports
two blocking items: the placeholder copyright holder in `LICENSE`, and the absent
`repository` field. It also scans every tracked file for machine-specific paths
and personal data — that check exists because an early draft of this README quoted
the author's own running applications by name.

