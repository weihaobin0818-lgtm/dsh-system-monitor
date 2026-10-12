/**
 * Client half of the system-monitor bundle.
 *
 * It contributes one sidebar panel entry (`sidebar.panellist`) and the page that
 * entry opens (`main`, same id). The page polls the Host's cached metrics
 * snapshot once a second and draws it as ring gauges, sparklines, a per-core
 * grid and disk bars. Clicking a gauge opens the per-application breakdown for
 * that resource, which switches the poll to the detail payload.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, and the stylesheet rides inside
 * the component so unmounting removes it.
 */
window.__ModuleLoader__.load({
  // Must match the bundle's package name: the boot graph keys this module by it,
  // so a stale id here means the client half silently never registers.
  id: 'dsh-system-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'systemMonitor'
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'system-monitor'
    /** Poll cadence; the Host samples on the same 1s beat. */
    const POLL_MS = 1000
    /** Sidebar-badge poll cadence; slower because it only watches thresholds. */
    const ALERT_POLL_MS = 5000
    /** How long an alert toast stays on screen before dismissing itself. */
    const TOAST_MS = 12000
    /** At most this many toasts stack up at once. */
    const TOAST_MAX = 3
    /** Where the display density preference is remembered between visits. */
    const DENSITY_KEY = 'dsh-system-monitor:density'
    /** Layout sizes that differ between the two densities. */
    const DENSITY = {
      comfortable: { ring: 104, ringStroke: 9, spark: 42, chart: 168, coreTrack: 60 },
      compact: { ring: 84, ringStroke: 7, spark: 26, chart: 108, coreTrack: 36 },
    }

    /** Read the saved density, falling back to comfortable. */
    function readDensity() {
      try {
        const saved = window.localStorage?.getItem(DENSITY_KEY)
        return saved === 'compact' ? 'compact' : 'comfortable'
      } catch {
        return 'comfortable'
      }
    }

    /** Remember the density; a browser with storage disabled simply forgets. */
    function writeDensity(value) {
      try {
        window.localStorage?.setItem(DENSITY_KEY, value)
      } catch {
        // Private mode or a blocked storage API: the session still works.
      }
    }
    /** Default ring box size; the density modes scale it and derive the rest. */
    const RING_SIZE = 104
    /** Resources that can be drilled into, in tab order. */
    const RESOURCES = ['cpu', 'memory', 'gpu', 'disk']
    /**
     * Reasons that mean "this is broken", not "this machine cannot".
     *
     * Only these keep their panel while unavailable; everything else is hidden,
     * because a capability a machine genuinely lacks should not occupy space.
     */
    const TRANSIENT_REASONS = new Set([
      'spawn-failed', 'sampler-silent', 'sampler-gave-up', 'counters-off', 'powershell-missing',
    ])

    /**
     * The wire contract this Client was written against.
     *
     * A Host that reports a lower protocol predates this build, and the honest
     * thing to do is say so. The alternative — which this session produced three
     * times over — is a panel that vanishes, an export that blanks the window, or
     * data that is silently empty, with nothing anywhere pointing at the version
     * mismatch that caused it.
     */
    const REQUIRED_PROTOCOL = 1

    /**
     * The longest range the Host retains. Mirrors SERIES_LIMIT in metrics.js: it
     * is a display constant, and the Host clamps regardless of what is asked.
     */
    const MAX_WINDOW = 10800

    /** How long a save result stays on screen. */
    const SAVE_TOAST_MS = 8000

    /** How many application rows a detail table shows. */
    const DETAIL_ROWS = 24
    /** History windows the header offers, in seconds. */
    const WINDOW_OPTIONS = [60, 300, 1800]

    const ZH = {
      panel: '系统监控',
      subtitle: '本机实时硬件状态',
      cpu: 'CPU 使用率',
      memory: '内存',
      gpu: 'GPU 使用率',
      disks: '磁盘',
      cores: '核心占用',
      cores_hint: '每个逻辑核心的当前占用',
      used: '已用',
      free: '空闲',
      total: '总量',
      uptime: '已运行',
      sample_rate: '每秒刷新',
      last_update: '最后更新',
      live: '实时',
      stale: '数据延迟',
      loading: '正在读取硬件状态…',
      unreachable: '主机无响应，显示的是最后一次成功的数据',
      core_short: '核',
      vram: '专用显存',
      shared: '共享显存',
      gpu_live: '实时',
      gpu_starting: '正在启动 GPU 采样…',
      gpu_idle: 'GPU 采样待机中',
      gpu_degraded: 'GPU 采样异常',
      gpu_unavailable: 'GPU 计数器不可用',
      no_disks: '未检测到磁盘卷',
      history: '最近 60 秒',
      freq_now: '当前',
      nominal: '标称',
      cached: '缓存',
      committed: '已提交',
      page_file: '页面文件',
      engines: 'GPU 引擎占用',
      alert_title: '负载告警',
      alert_cpu: 'CPU',
      alert_memory: '内存',
      alert_gpu: 'GPU',
      alert_disk: '磁盘',
      alert_sampler: '采样器',
      trend: '趋势总览',
      trend_hint: '最近 60 秒 · 悬停查看某一时刻',
      cores_heat: '核心热力图（右为最新）',
      memory_share: '内存去向',
      others: '其他',
      disk_io: '磁盘吞吐',
      io_read: '读取',
      io_write: '写入',
      health_ok: '运行正常',
      health_busy: '接近阈值',
      health_over: '超过阈值',
      health_culprit: '主因',
      health_disk_of: '卷',
      status: '诊断',
      status_caps: '本机监控能力',
      status_config: '当前配置',
      status_available: '可用',
      status_unavailable: '不可用',
      status_hint: '不可用的项目已从界面隐藏，而不是显示空面板',
      cap_cpu: 'CPU 与每核心占用',
      cap_memory: '内存占用',
      cap_diskCapacity: '磁盘容量',
      cap_clockSpeed: 'CPU 实时频率',
      cap_memoryDetail: '内存提交量与缓存',
      cap_gpu: 'GPU 利用率与显存',
      cap_processGpu: '按进程 GPU 占用',
      cap_processes: '按应用进程明细',
      cap_diskThroughput: '磁盘读写吞吐',
      cap_icons: '应用图标',
      cap_diskLatency: '磁盘延迟与队列',
      cap_forecast: '容量与内存预测',
      cap_battery: '电池状态',
      reason_windows_only: '仅 Windows 提供该计数器',
      reason_needs_cpu_counters: '需要处理器性能计数器',
      reason_needs_memory_counters: '需要内存性能计数器',
      reason_needs_gpu_counters: '需要 WDDM GPU 性能计数器',
      reason_needs_disk_counters: '需要 PhysicalDisk 性能计数器',
      reason_needs_exe_path: '需要读取进程可执行文件路径',
      reason_no_gpu_counters: '系统未提供 GPU 性能计数器',
      reason_counters_failed: '性能计数器连续读取失败',
      reason_counters_error: '性能计数器读取报错',
      reason_sampler_unavailable: '采样进程无法启动',
      reason_sampler_gave_up: '采样进程连续启动失败，已停止重试',
      reason_sampler_silent: '采样进程无响应',
      reason_sampler_stopped: '采样进程已停止',
      reason_spawn_failed: '无法启动采样进程',
      reason_no_battery: '本机没有可读的电池',
      reason_needs_history: '需要先积累一段历史',
      toast_title: '系统监控告警',
      toast_open: '查看',
      level_ok: '正常',
      level_warn: '警告',
      level_high: '严重',
      toast_body: '{r} 持续超过阈值',
      reason_needs_net_counters: '本机没有可读的网络计数器',
      reason_unknown: '不可用',
      config_alert: '告警阈值',
      config_display: '显示项',
      bottleneck: '最接近上限的是',
      pressure: '资源压力',
      pressure_hint: '相对「饱和」的程度，不是使用率',
      throttle: '频率受限',
      peak_clock: '峰值',
      disk_latency: '延迟',
      disk_queue: '队列',
      disk_transfers: 'IOPS',
      alert_log: '告警历史',
      alert_log_empty: '本次会话没有触发告警',
      alert_cleared: '已恢复',
      alert_raised: '触发',
      sort_usage: '按占用',
      sort_growth: '按增长',
      sort_disk: '按磁盘',
      sort_disk_hint: '每 30 秒采样一次的读写吞吐；磁盘占用变化很慢，不需要更快',
      disk_none: '这 30 秒内没有应用读写磁盘',
      disk_read: '读',
      disk_write: '写',
      growth_window: '近 {n} 分钟增长',
      growth_none: '增长数据还在积累，约一分钟后可用',
      growth_fresh: '新启动',
      growth_delta: '增长',
      current: '当前',
      started: '启动于',
      path_label: '路径',
      pid_label: 'PID',
      expand_hint: '点击应用行可展开它的进程',
      forecast: '预测',
      forecast_disk_days: '按最近 {w} 分钟的速度，约 {d} 天后写满',
      forecast_disk_flat: '按最近 {w} 分钟的速度，容量基本不变',
      forecast_memory_eta: '按最近 {w} 分钟的速度，约 {d} 后触及提交上限',
      forecast_memory_flat: '按最近 {w} 分钟的速度，提交量基本不变',
      forecast_wait: '预测需要积累几分钟历史',
      battery: '电池',
      battery_charging: '充电中',
      battery_discharging: '放电中',
      battery_left: '剩余约 {d}',
      duration_days: '{n} 天',
      duration_hours: '{n} 小时',
      duration_minutes: '{n} 分钟',
      window: '时间范围',
      window_1m: '1 分钟',
      window_5m: '5 分钟',
      window_30m: '30 分钟',
      window_custom: '自定义',
      window_custom_hint: '输入分钟数，最多 {n} 分钟（宿主保留上限）',
      window_minutes: '分钟',
      window_apply: '应用',
      summary: '本次会话',
      summary_peak: '峰值',
      summary_avg: '均值',
      summary_at: '发生于',
      summary_none: '还没有足够的样本',
      summary_uptime: '已观测 {d}',
      export: '导出数据',
      export_csv: 'CSV',
      export_json: 'JSON',
      export_hint: '导出为文件；采样数据用 1/5/30 分钟窗口，应用与快照为当前时刻',
      export_series: '采样数据',
      export_series_hint: '每秒一行的时序表：CPU、内存、GPU、磁盘读写、延迟与队列',
      export_apps: '应用占用',
      export_apps_hint: '当前各应用的进程数、CPU、内存、GPU、增长与可执行文件路径',
      export_full: '完整快照',
      export_full_hint: '一个文件包含全部读数、能力、配置、告警历史与会话峰值，适合存档或报错',
      export_note_empty: '暂时没有可导出的数据',
      export_note_unreachable: '无法连接采样服务',
      export_note_unreadable: '响应无法读取',
      export_note_unwritable: '无法写入文件',
      stale_host: '宿主是旧版本（协议 {host}，本界面需要 {want}）。请完全退出并重新打开 DSH —— 刷新页面不会加载宿主侧的新代码。',
      export_saved: '保存成功，文件路径',
      export_csv: 'CSV',
      export_json: 'JSON',
      export_ndjson: 'NDJSON',
      export_note_write_failed: '写入文件失败',
      density: '显示密度',
      density_comfortable: '舒适',
      density_compact: '紧凑',
      peak: '峰值',
      detail: '占用明细',
      detail_hint: '按应用汇总 · 条形按列表最大值缩放',
      app: '应用',
      proc_count: '进程数',
      proc_unit: '个',
      close: '关闭',
      updated: '更新于',
      none: '暂无数据，正在采集…',
      waiting: '正在启动采样进程…',
      no_gpu_process: '当前没有进程在占用 GPU',
      volumes: '磁盘卷',
      physical: '物理磁盘吞吐',
      read_rate: '读取',
      write_rate: '写入',
      open_detail: '查看占用明细',
    }
    const EN = {
      panel: 'System Monitor',
      subtitle: 'Live hardware status of this machine',
      cpu: 'CPU usage',
      memory: 'Memory',
      gpu: 'GPU usage',
      disks: 'Disks',
      cores: 'Per-core usage',
      cores_hint: 'Current load of each logical core',
      used: 'Used',
      free: 'Free',
      total: 'Total',
      uptime: 'Uptime',
      sample_rate: 'Refreshed every second',
      last_update: 'Updated',
      live: 'Live',
      stale: 'Stale reading',
      loading: 'Reading hardware status…',
      unreachable: 'Host unreachable — showing the last successful reading',
      core_short: 'cores',
      vram: 'Dedicated VRAM',
      shared: 'Shared memory',
      gpu_live: 'Live',
      gpu_starting: 'Starting GPU sampler…',
      gpu_idle: 'GPU sampler idle',
      gpu_degraded: 'GPU sampler degraded',
      gpu_unavailable: 'GPU counters unavailable',
      no_disks: 'No disk volume detected',
      history: 'Last 60 seconds',
      freq_now: 'now',
      nominal: 'nominal',
      cached: 'Cached',
      committed: 'Committed',
      page_file: 'Page file',
      engines: 'GPU engine usage',
      alert_title: 'Load alert',
      alert_cpu: 'CPU',
      alert_memory: 'Memory',
      alert_gpu: 'GPU',
      alert_disk: 'Disk',
      alert_sampler: 'Sampler',
      trend: 'Trend',
      trend_hint: 'Last 60 seconds · hover for one moment',
      cores_heat: 'Per-core heatmap (newest at right)',
      memory_share: 'Where memory went',
      others: 'Others',
      disk_io: 'Disk throughput',
      io_read: 'Read',
      io_write: 'Write',
      health_ok: 'All normal',
      health_busy: 'Near threshold',
      health_over: 'Above threshold',
      health_culprit: 'Top cause',
      health_disk_of: 'volume',
      status: 'Status',
      status_caps: 'Monitoring available on this machine',
      status_config: 'Effective configuration',
      status_available: 'Available',
      status_unavailable: 'Unavailable',
      status_hint: 'Unavailable items are hidden from the page rather than shown empty',
      cap_cpu: 'CPU and per-core load',
      cap_memory: 'Memory usage',
      cap_diskCapacity: 'Disk capacity',
      cap_clockSpeed: 'Live CPU clock',
      cap_memoryDetail: 'Committed memory and cache',
      cap_gpu: 'GPU utilisation and VRAM',
      cap_processGpu: 'Per-process GPU',
      cap_processes: 'Per-application processes',
      cap_diskThroughput: 'Disk read/write throughput',
      cap_icons: 'Application icons',
      cap_diskLatency: 'Disk latency and queue',
      cap_forecast: 'Capacity and memory forecast',
      cap_battery: 'Battery state',
      reason_windows_only: 'Only Windows exposes these counters',
      reason_needs_cpu_counters: 'Needs the processor performance counters',
      reason_needs_memory_counters: 'Needs the memory performance counters',
      reason_needs_gpu_counters: 'Needs the WDDM GPU performance counters',
      reason_needs_disk_counters: 'Needs the PhysicalDisk performance counters',
      reason_needs_exe_path: 'Needs read access to process executables',
      reason_no_gpu_counters: 'This system exposes no GPU performance counters',
      reason_counters_failed: 'Performance counters kept failing to read',
      reason_counters_error: 'Performance counters reported an error',
      reason_sampler_unavailable: 'The sampler process cannot start',
      reason_sampler_gave_up: 'The sampler failed to start repeatedly and was given up on',
      reason_sampler_silent: 'The sampler stopped responding',
      reason_sampler_stopped: 'The sampler stopped',
      reason_spawn_failed: 'The sampler process could not be launched',
      reason_no_battery: 'This machine exposes no readable battery',
      reason_needs_history: 'Needs a few minutes of history first',
      toast_title: 'System monitor alert',
      toast_open: 'View',
      level_ok: 'Normal',
      level_warn: 'Warning',
      level_high: 'Critical',
      toast_body: '{r} is over its threshold',
      reason_unknown: 'Unavailable',
      config_alert: 'Alert thresholds',
      config_display: 'Display',
      bottleneck: 'closest to its limit:',
      pressure: 'Resource pressure',
      pressure_hint: 'Distance from saturation, not utilisation',
      throttle: 'Clock limited',
      peak_clock: 'Peak',
      disk_latency: 'Latency',
      disk_queue: 'Queue',
      disk_transfers: 'IOPS',
      alert_log: 'Alert history',
      alert_log_empty: 'No alert has fired in this session',
      alert_cleared: 'Cleared',
      alert_raised: 'Raised',
      sort_usage: 'By usage',
      sort_growth: 'By growth',
      sort_disk: 'By disk',
      sort_disk_hint: 'Read/write throughput, sampled every 30 seconds — disk attribution changes slowly',
      disk_none: 'No application touched the disk in the last 30 seconds',
      disk_read: 'Read',
      disk_write: 'Write',
      growth_window: 'Growth over {n} min',
      growth_none: 'Growth needs about a minute of history',
      growth_fresh: 'Started recently',
      growth_delta: 'Growth',
      current: 'Now',
      started: 'Started',
      path_label: 'Path',
      pid_label: 'PID',
      expand_hint: 'Select an application row to expand its processes',
      forecast: 'Forecast',
      forecast_disk_days: 'At the last {w} min, full in about {d}',
      forecast_disk_flat: 'At the last {w} min, capacity is holding steady',
      forecast_memory_eta: 'At the last {w} min, the commit limit is about {d} away',
      forecast_memory_flat: 'At the last {w} min, the commit charge is holding steady',
      forecast_wait: 'A forecast needs a few minutes of history',
      battery: 'Battery',
      battery_charging: 'Charging',
      battery_discharging: 'On battery',
      battery_left: 'about {d} left',
      duration_days: '{n}d',
      duration_hours: '{n}h',
      duration_minutes: '{n}m',
      window: 'Time range',
      window_1m: '1 min',
      window_5m: '5 min',
      window_30m: '30 min',
      window_custom: 'Custom',
      window_custom_hint: 'Minutes, up to {n} — the Host keeps no more',
      window_minutes: 'min',
      window_apply: 'Apply',
      summary: 'This session',
      summary_peak: 'Peak',
      summary_avg: 'Average',
      summary_at: 'at',
      summary_none: 'Not enough samples yet',
      summary_uptime: 'Watched for {d}',
      export: 'Export data',
      export_csv: 'CSV',
      export_json: 'JSON',
      export_hint: 'Downloads a file; samples use the 1/5/30 min window, apps and bundle are as of now',
      export_series: 'Samples',
      export_series_hint: 'One row per second: CPU, memory, GPU, disk read/write, latency and queue',
      export_apps: 'Applications',
      export_apps_hint: 'Per application now: processes, CPU, memory, GPU, growth and executable path',
      export_full: 'Full bundle',
      export_full_hint: 'One file with every reading, capability, the config, the alert history and the session peaks — for archiving or a bug report',
      export_note_empty: 'There is nothing to export yet',
      export_note_unreachable: 'The sampler could not be reached',
      export_note_unreadable: 'The response could not be read',
      export_note_unwritable: 'The file could not be written',
      stale_host: 'The Host is older than this panel (protocol {host}, needs {want}). Quit DSH completely and reopen it — refreshing the page does not reload Host code.',
      export_saved: 'Saved successfully, file path',
      export_csv: 'CSV',
      export_json: 'JSON',
      export_ndjson: 'NDJSON',
      export_note_write_failed: 'The file could not be written',
      density: 'Density',
      density_comfortable: 'Comfortable',
      density_compact: 'Compact',
      peak: 'Peak',
      detail: 'Usage details',
      detail_hint: 'Grouped by application · bars scale to the largest row shown',
      app: 'Application',
      proc_count: 'Processes',
      proc_unit: '',
      close: 'Close',
      updated: 'Updated',
      none: 'No data yet — collecting…',
      waiting: 'Starting the sampler…',
      no_gpu_process: 'No process is using the GPU right now',
      volumes: 'Volumes',
      physical: 'Physical disk throughput',
      read_rate: 'Read',
      write_rate: 'Write',
      open_detail: 'Show usage details',
    }

    const CSS = `
.dsm-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;align-items:center;gap:16px;padding:0 clamp(18px,3vw,40px) 44px;display:flex;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}
.dsm-page>*{width:100%;max-width:1560px;}
.dsm-head{box-sizing:border-box;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding:28px 0 16px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l1);}
[data-platform=darwin] .dsm-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));}
.dsm-headMain{min-width:0;}
.dsm-titleRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dsm-titleGlyph{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary);}
.dsm-title{margin:0;font-size:21px;font-weight:600;line-height:28px;letter-spacing:-.01em;}
.dsm-live{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 10px 1px 8px;}
.dsm-liveDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}
.dsm-liveDot[data-state=live]{animation:dsm-pulse 2.6s ease-in-out infinite;}
@keyframes dsm-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.dsm-liveDot[data-state=stale]{background:var(--dsw-alias-state-warn-primary);}
.dsm-liveDot[data-state=down]{background:var(--dsw-alias-state-error-primary);}
.dsm-sub{margin:5px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.dsm-headSide{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:right;font-variant-numeric:tabular-nums;}
.dsm-notice{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary);margin:0;padding:9px 13px;font-size:12.5px;line-height:18px;}
.dsm-gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(276px,1fr));gap:16px;}
.dsm-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:16px;align-items:start;}
/* Compact density: the same dashboard, sized to sit on one screen. The page
   still scrolls if it must, so nothing can become unreachable. */
.dsm-page[data-density=compact]{gap:10px;padding-bottom:18px;}
.dsm-page[data-density=compact] .dsm-head{padding:14px 0 9px;}
.dsm-page[data-density=compact] .dsm-gauges{gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}
.dsm-page[data-density=compact] .dsm-panels{gap:10px;}
.dsm-page[data-density=compact] .dsm-card{padding:10px 13px;gap:9px;}
.dsm-page[data-density=compact] .dsm-gaugeRow{gap:13px;}
.dsm-page[data-density=compact] .dsm-ringNum{font-size:22px;line-height:25px;}
.dsm-page[data-density=compact] .dsm-coreTrack{height:36px;}
.dsm-page[data-density=compact] .dsm-lines{gap:2px;}
.dsm-page[data-density=compact] .dsm-line{font-size:11.5px;line-height:16px;}
.dsm-page[data-density=compact] .dsm-heat{gap:1px;}
.dsm-page[data-density=compact] .dsm-heatRow{height:6px;}
.dsm-page[data-density=compact] .dsm-heatStrip{height:5px;}
.dsm-page[data-density=compact] .dsm-health{padding:6px 12px;}
.dsm-page[data-density=compact] .dsm-disks{gap:10px;}
.dsm-chartAxisRow{display:flex;gap:10px;margin-top:2px;}
.dsm-chartAxisRow .dsm-chartGutter{width:32px;flex:none;}
.dsm-chartTicks{flex:1;min-width:0;display:flex;justify-content:space-between;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-card{box-sizing:border-box;position:relative;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:13px;padding:17px 19px;display:flex;min-width:0;}
.dsm-card>.dsm-cardTint{position:absolute;inset:0;z-index:0;border-radius:inherit;pointer-events:none;}
.dsm-card>*{position:relative;z-index:1;}
.dsm-card[data-openable=true]{cursor:pointer;transition:border-color .16s ease,background .16s ease;}
.dsm-card[data-openable=true]:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);}
.dsm-card[data-active=true]{border-color:var(--dsw-alias-brand-primary);}
.dsm-cardHead{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0;}
.dsm-cardTitleRow{display:flex;align-items:center;gap:9px;min-width:0;}
.dsm-cardGlyph{display:inline-flex;flex:none;}
.dsm-cardName{margin:0;font-size:14px;font-weight:600;line-height:22px;flex:none;letter-spacing:-.005em;}
.dsm-nameBtn{font:inherit;color:inherit;background:0 0;border:0;padding:0;cursor:pointer;align-items:center;gap:4px;display:inline-flex;}
.dsm-nameBtn:hover{color:var(--dsw-alias-brand-primary);}
.dsm-nameBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs);}
.dsm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s ease;}
.dsm-nameBtn:hover .dsm-chevron{color:var(--dsw-alias-brand-primary);transform:translateX(1px);}
.dsm-card[data-active=true] .dsm-chevron{color:var(--dsw-alias-brand-primary);}
.dsm-cardMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-variant-numeric:tabular-nums;}
.dsm-gaugeRow{display:flex;align-items:center;gap:18px;min-width:0;}
.dsm-ringWrap{position:relative;flex:none;width:104px;height:104px;}
.dsm-ringMid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;pointer-events:none;}
.dsm-ringNum{font-size:27px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;}
.dsm-ringUnit{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);}
.dsm-lines{flex-direction:column;gap:4px;display:flex;min-width:0;flex:1;}
.dsm-line{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsm-line[data-strong=true]{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:500;}
.dsm-spark{display:block;width:100%;}
.dsm-sparkEmpty{border-bottom:.5px dashed var(--dsw-alias-border-l2);}
.dsm-cores{display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-end;gap:6px;}
.dsm-core{flex:1 1 0;min-width:16px;max-width:44px;flex-direction:column;gap:5px;display:flex;}
.dsm-coreTrack{position:relative;height:60px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);overflow:hidden;}
.dsm-coreFill{position:absolute;left:0;right:0;bottom:0;border-radius:var(--dsw-radius-sm);transition:height .5s cubic-bezier(.4,0,.2,1),background .3s linear;}
.dsm-coreLabel{font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);text-align:center;font-variant-numeric:tabular-nums;}
.dsm-disks{flex-direction:column;gap:15px;display:flex;}
.dsm-disk{display:flex;align-items:center;gap:14px;min-width:0;}
.dsm-diskBadge{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);flex:none;min-width:46px;text-align:center;padding:4px 7px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.02em;}
.dsm-diskBody{flex:1;min-width:0;flex-direction:column;gap:5px;display:flex;}
.dsm-bar{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;}
.dsm-barFill{height:100%;border-radius:999px;transition:width .5s cubic-bezier(.4,0,.2,1),background .3s linear;}
.dsm-diskText{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsm-diskPct{flex:none;min-width:52px;text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;}
.dsm-empty{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.dsm-detail{background:var(--dsw-alias-bg-layer-2);}
.dsm-tabs{display:inline-flex;gap:2px;flex-wrap:wrap;align-items:center;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:2px;}
.dsm-tab{font:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);background:0 0;border:.5px solid transparent;border-radius:calc(var(--dsw-radius-md) - 2px);padding:3px 12px;cursor:pointer;transition:background .14s ease,color .14s ease;}
.dsm-tab:hover{color:var(--dsw-alias-label-primary);}
.dsm-tab[data-active=true]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:500;}
.dsm-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.dsm-detailSide{display:flex;align-items:center;gap:10px;flex:none;}
.dsm-iconBtn{width:26px;height:26px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:0 0;border:0;cursor:pointer;justify-content:center;align-items:center;display:inline-flex;padding:0;flex:none;transition:background .14s ease,color .14s ease;}
.dsm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dsm-iconBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.dsm-table{flex-direction:column;display:flex;min-width:0;}
.dsm-row{display:flex;align-items:center;gap:12px;margin:0 -8px;padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);min-width:0;transition:background .12s ease;}
.dsm-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dsm-row:last-child{border-bottom:0;}
.dsm-rowHead{border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;padding-bottom:5px;}
.dsm-rowHead:hover{background:0 0;}
.dsm-cName{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;}
.dsm-cNameText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsm-appIcon{width:18px;height:18px;border-radius:5px;flex:none;display:block;object-fit:contain;}
.dsm-appIconFallback{display:inline-flex;justify-content:center;align-items:center;color:#fff;font-size:10px;font-weight:600;line-height:1;text-transform:uppercase;}
.dsm-cCount{flex:none;width:68px;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-cBar{flex:none;width:150px;}
.dsm-cValue{flex:none;width:88px;text-align:right;font-size:12.5px;font-variant-numeric:tabular-nums;font-weight:600;}
.dsm-cSub{flex:none;width:92px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsm-groupLabel{margin:2px 0 0;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;text-transform:uppercase;}
.dsm-detailBody{flex-direction:column;gap:16px;display:flex;min-width:0;}
.dsm-health{display:flex;align-items:center;gap:9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:8px 13px;font-size:12.5px;line-height:18px;}
.dsm-health[data-level=busy]{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent);background:var(--dsw-alias-state-warn-tertiary);}
.dsm-health[data-level=warn]{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);background:var(--dsw-alias-state-warn-tertiary);}
.dsm-health[data-level=high]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);}
.dsm-healthDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary);}
.dsm-healthDot[data-level=busy],.dsm-healthDot[data-level=warn]{background:var(--dsw-alias-state-warn-primary);}
.dsm-healthDot[data-level=high]{background:var(--dsw-alias-state-error-primary);}
.dsm-healthText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsm-healthLink{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:0 0;border:0;padding:0;cursor:pointer;flex:none;text-underline-offset:3px;}
.dsm-healthLink:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline;}
.dsm-healthLink:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs);}
.dsm-statusDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary);}
.dsm-statusDotOff{background:var(--dsw-alias-label-tertiary);opacity:.5;}
.dsm-row[data-off=true] .dsm-cNameText{color:var(--dsw-alias-label-tertiary);}
.dsm-configGrid{display:flex;flex-wrap:wrap;gap:6px 10px;}
.dsm-configItem{display:inline-flex;align-items:baseline;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);padding:2px 8px;font-size:11.5px;line-height:18px;}
.dsm-configKey{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace);}
.dsm-configItem strong{font-variant-numeric:tabular-nums;}
.dsm-pressure{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px 18px;}
.dsm-pressureItem{display:flex;align-items:center;gap:8px;min-width:0;}
.dsm-pressureItem[data-blame=true] .dsm-pressureLabel{color:var(--dsw-alias-label-primary);font-weight:500;}
.dsm-pressureLabel{flex:none;width:42px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);}
.dsm-pressureTrack{flex:1;min-width:0;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;}
.dsm-pressureFill{height:100%;border-radius:999px;transition:width .5s cubic-bezier(.4,0,.2,1),background .3s linear;}
.dsm-pressureValue{flex:none;width:38px;text-align:right;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-chip{display:inline-flex;align-items:center;border-radius:999px;padding:1px 9px;font-size:11px;line-height:17px;flex:none;}
.dsm-chip[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);border:.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);}
.dsm-detailBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.dsm-tabsSmall{padding:1px;}
.dsm-tabsSmall .dsm-tab{font-size:11.5px;line-height:16px;padding:1px 9px;}
.dsm-rowOpen{cursor:pointer;}
.dsm-rowOpen[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);}
.dsm-cPid{flex:none;width:62px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-appDetail{margin:0 0 6px 26px;padding:8px 10px 4px;border-left:2px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);}
.dsm-appPath{display:flex;align-items:baseline;gap:8px;min-width:0;margin-bottom:4px;font-size:11.5px;line-height:17px;}
.dsm-appPathKey{color:var(--dsw-alias-label-tertiary);flex:none;}
.dsm-appPath code{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.dsm-appRow{padding:4px 8px;margin:0;}
.dsm-appRow:hover{background:0 0;}
.dsm-dim{color:var(--dsw-alias-label-tertiary);}
.dsm-tag{display:inline-flex;align-items:center;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);padding:0 7px;font-size:10.5px;line-height:16px;flex:none;}
.dsm-exportMenu{position:relative;}.dsm-exportTrigger{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:2px 10px;font-size:11.5px;line-height:18px;cursor:pointer;}.dsm-exportTrigger:hover,.dsm-exportTrigger[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}.dsm-exportPop{position:absolute;right:0;top:calc(100% + 6px);z-index:40;width:min(320px,80vw);display:flex;flex-direction:column;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.18);}.dsm-exportPopRow{display:flex;flex-direction:column;gap:5px;}.dsm-exportPopHead{display:flex;flex-direction:column;gap:1px;}.dsm-exportPopName{font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-primary);}.dsm-exportPopHint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);}.dsm-exportPopLinks{display:flex;gap:8px;flex-wrap:wrap;}.dsm-exportScope{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}.dsm-exportScopeName{flex:none;width:74px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:help;}.dsm-exportScopeLinks{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dsm-exportLink:disabled{opacity:.55;cursor:default;}.dsm-exportLink{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:3px 12px;font-size:12px;line-height:18px;text-decoration:none;cursor:pointer;font-family:inherit;transition:background .14s ease,border-color .14s ease;}
.dsm-stale{display:flex;align-items:center;gap:8px;padding:7px 12px;border:.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-state-warn-tertiary);}.dsm-staleText{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);}.dsm-customRange{display:inline-flex;align-items:center;gap:5px;padding:1px 2px;}.dsm-customInput{width:62px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;line-height:18px;padding:1px 6px;}.dsm-customInput:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-brand-primary);outline-offset:1px;}.dsm-customApply{border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff);font-family:inherit;font-size:11.5px;line-height:18px;padding:1px 10px;cursor:pointer;}.dsm-customMax{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}.dsm-saveToast{position:fixed;right:20px;bottom:20px;z-index:70;display:flex;align-items:flex-start;gap:10px;max-width:min(460px,calc(100vw - 40px));padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-success-primary);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgba(0,0,0,.16);animation:dsm-toastIn .22s cubic-bezier(.4,0,.2,1);}.dsm-saveToast[data-tone=error]{border-left-color:var(--dsw-alias-state-error-primary);}.dsm-saveToastText{flex:1;min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all;}.dsm-saveToastClose{flex:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 2px;cursor:pointer;}@media (prefers-reduced-motion:reduce){.dsm-saveToast{animation:none;}}
.dsm-exportLink:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dsm-exportLink:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;}
.dsm-headSide .dsm-tabs{margin-bottom:4px;}
.dsm-trend{font-style:normal;font-size:10px;margin-left:5px;}
.dsm-trend[data-dir="1"]{color:var(--dsw-alias-state-warn-primary);}
.dsm-trend[data-dir="-1"]{color:var(--dsw-alias-state-success-primary);}
.dsm-footNote{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.dsm-chartRow{display:flex;gap:10px;min-width:0;}
.dsm-chartAxis{flex-direction:column;justify-content:space-between;width:32px;flex:none;display:flex;font-size:10px;line-height:10px;color:var(--dsw-alias-label-tertiary);text-align:right;font-variant-numeric:tabular-nums;padding:2px 0;}
.dsm-chartPlot{position:relative;flex:1;min-width:0;cursor:crosshair;}
.dsm-chart{display:block;width:100%;height:168px;}
.dsm-chartEnd{position:absolute;right:0;width:7px;height:7px;border-radius:50%;transform:translate(50%,-50%);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1);pointer-events:none;}
.dsm-chartPeak{position:absolute;width:7px;height:7px;border-radius:50%;transform:translate(-50%,-50%);background:transparent;border:1.5px solid currentColor;pointer-events:auto;cursor:help;}
.dsm-chartTip{position:absolute;top:4px;z-index:2;pointer-events:none;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);padding:7px 10px;font-size:11.5px;line-height:17px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.dsm-chartTipTime{color:var(--dsw-alias-label-tertiary);margin-bottom:3px;}
.dsm-chartTipRow{display:flex;align-items:center;gap:6px;}
.dsm-chartTipRow strong{margin-left:auto;padding-left:12px;}
.dsm-legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dsm-legendWrap{margin-top:10px;}
.dsm-legendItem{display:inline-flex;align-items:center;gap:6px;min-width:0;}
.dsm-legendItem strong{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}
.dsm-legendName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;}
.dsm-legendDot{width:8px;height:8px;border-radius:2px;flex:none;}
.dsm-heat{flex-direction:column;gap:2px;display:flex;margin-top:6px;}
.dsm-heatRow{display:flex;align-items:center;gap:8px;height:9px;}
.dsm-heatLabel{width:15px;flex:none;text-align:right;font-size:9px;line-height:9px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-heatStrip{flex:1;min-width:0;height:7px;display:block;border-radius:2px;shape-rendering:crispEdges;}
.dsm-heatValue{width:32px;flex:none;text-align:right;font-size:9px;line-height:9px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dsm-compose{flex-direction:column;display:flex;min-width:0;}
.dsm-composeBar{display:flex;height:16px;border-radius:var(--dsw-radius-sm);overflow:hidden;background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1);}
.dsm-composeSeg{min-width:0;transition:flex-grow .5s cubic-bezier(.4,0,.2,1);}
/* ---------------------------------------------------------------------------
   Polish layer.

   Deliberately additive: it only restates rules declared above, so removing this
   block returns the panel to exactly its previous look. Every colour comes from a
   theme token, so it follows the light/dark switch without a second definition.

   The aims are narrow and, I hope, uncontroversial: give cards enough elevation
   to read as surfaces rather than rectangles, make the one line everyone actually
   reads — the health verdict — carry its state at a glance, and stop the active
   tab from looking sunk into its track.
   --------------------------------------------------------------------------- */
.dsm-card{
  /* A hairline shadow, not a drop shadow. Enough to separate the card from the
     page; not enough to notice as a shadow. */
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 1px 1px rgba(0,0,0,.03);
}
.dsm-card[data-openable=true]:hover{
  transform:translateY(-1px);
  box-shadow:0 3px 10px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.04);
}
.dsm-card[data-openable=true]{transition:border-color .16s ease,background .16s ease,box-shadow .18s ease,transform .18s ease;}
.dsm-card[data-active=true]{box-shadow:0 0 0 1px var(--dsw-alias-brand-primary),0 2px 10px rgba(0,0,0,.06);}

/* The health verdict is the one line worth reading at a glance, so it carries
   its state on the left edge as well as in the dot and the wording. Three cues
   for one fact is deliberate: this gets read in passing, not studied. */
.dsm-health{
  border-left-width:3px;
  padding:9px 14px;
  font-size:13px;
  box-shadow:0 1px 2px rgba(0,0,0,.03);
}
.dsm-health[data-level=ok]{border-left-color:var(--dsw-alias-state-success-primary);}
.dsm-health[data-level=busy],.dsm-health[data-level=warn]{border-left-color:var(--dsw-alias-state-warn-primary);}
.dsm-health[data-level=high]{border-left-color:var(--dsw-alias-state-error-primary);}
.dsm-healthDot{box-shadow:0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);}
.dsm-healthText{font-weight:500;letter-spacing:-.002em;}

/* The track is the raised surface and the active tab sits inside it, so without
   this the selected tab reads as a hole rather than a choice. */
.dsm-tab[data-active=true]{
  box-shadow:0 1px 2px rgba(0,0,0,.07),0 1px 1px rgba(0,0,0,.04);
  transition:background .14s ease,color .14s ease,box-shadow .16s ease;
}
.dsm-tab:hover:not([data-active=true]){background:var(--dsw-alias-interactive-bg-hover);}

/* --- dashboard direction ---------------------------------------------------
   A monitoring panel is read the way a dashboard is read: at a glance, from a
   little way back, with the numbers doing the talking. So values get larger and
   heavier, labels get smaller and quieter, and the chrome between them gets
   thinner. Density is the point — the space goes to data, not to margins.
   --------------------------------------------------------------------------- */

/* Values first. This is the single largest change: the readout is what the eye
   should land on, and everything else should get out of its way. */
.dsm-ringNum{font-size:33px;line-height:36px;font-weight:650;letter-spacing:-.035em;}
.dsm-ringUnit{font-size:10px;line-height:13px;letter-spacing:.05em;}

/* Labels second: quieter and wider-tracked, so a label never competes with the
   value sitting next to it. */
.dsm-cardName{font-size:13px;font-weight:600;letter-spacing:.005em;}
.dsm-cardMeta{font-size:11px;line-height:15px;}

/* Tighter chrome. A dashboard does not waste space between its instruments. */
.dsm-page{gap:13px;}
.dsm-head{padding:20px 0 12px;}
.dsm-card{padding:14px 16px;gap:11px;border-radius:var(--dsw-radius-lg);}
.dsm-gauges{gap:13px;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));}
.dsm-panels{gap:13px;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));}
.dsm-gaugeRow{gap:15px;}
.dsm-row{padding:6px 8px;}
.dsm-rowHead{padding-bottom:4px;}

/* The verdict line, sized to be read without leaning in. */
.dsm-health{padding:8px 13px;font-size:13px;}

/* Numbers that change every second should not change width while they do. */
.dsm-line,.dsm-cValue,.dsm-cSub,.dsm-cardMeta,.dsm-heatValue,.dsm-ringNum,.dsm-tab{font-variant-numeric:tabular-nums;}

@media (max-width:860px){.dsm-cBar{display:none;}.dsm-cSub{width:74px;}}
@media (prefers-reduced-motion:reduce){.dsm-coreFill,.dsm-barFill,.dsm-composeSeg{transition:none;}.dsm-card[data-openable=true],.dsm-tab,.dsm-row,.dsm-iconBtn{transition:none;}.dsm-liveDot[data-state=live]{animation:none;}.dsm-chevron{transition:none;}.dsm-card[data-openable=true]:hover{transform:none;}}
`

    /** Bound translate function, installed by the plugin's `apply`. */
    /** Styles the alert toasts need even when the panel itself is closed. */
    const TOAST_CSS = `.dsm-toasts{position:fixed;right:20px;bottom:20px;z-index:60;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 40px));pointer-events:none;}
.dsm-toast{position:relative;display:flex;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgba(0,0,0,.16);pointer-events:auto;animation:dsm-toastIn .22s cubic-bezier(.4,0,.2,1);}
@keyframes dsm-toastIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
.dsm-toastBar{flex:none;width:3px;background:var(--dsw-alias-state-warn-primary);}
.dsm-toast[data-level=high] .dsm-toastBar{background:var(--dsw-alias-state-error-primary);}
.dsm-toastBody{flex:1;min-width:0;padding:10px 12px;}
.dsm-toastHead{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);}
.dsm-toastTitle{font-size:11.5px;line-height:16px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsm-toast[data-level=high] .dsm-toastLevel{color:var(--dsw-alias-state-error-primary);}
.dsm-toastLevel{font-size:11.5px;line-height:16px;flex:none;color:var(--dsw-alias-state-warn-primary);}
.dsm-toastText{margin:3px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);}
.dsm-toastActions{display:flex;align-items:center;gap:8px;margin-top:8px;}
.dsm-toastOpen{border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse, #fff);font-size:12px;line-height:18px;padding:2px 12px;cursor:pointer;}
.dsm-toastClose{margin-left:auto;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:2px 4px;cursor:pointer;}
.dsm-toastOpen:focus-visible,.dsm-toastClose:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-brand-primary);outline-offset:1px;}
@media (prefers-reduced-motion:reduce){.dsm-toast{animation:none;}}`

    let t = (key) => key
    /**
     * Opens this plugin's panel from anywhere, including a toast. Set during
     * activation; a missing layout service degrades to a no-op rather than
     * making the plugin fail to load.
     */
    let openPanel = () => {}

    /** Percentage -> semantic colour: brand, warn, then error. */
    function levelColor(value) {
      if (!Number.isFinite(value)) return 'var(--dsw-alias-border-l2)'
      if (value >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (value >= 70) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    /** Human byte size with one decimal above megabytes. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const digits = unit >= 3 && value < 100 ? 1 : 0
      return `${value.toFixed(digits)} ${units[unit]}`
    }

    /** Byte-per-second throughput. */
    function formatRate(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024) {
        return `${Math.max(0, Math.round(bytesPerSecond || 0))} B/s`
      }
      return `${formatBytes(bytesPerSecond)}/s`
    }

    /** Compact uptime such as `3d 04h 12m`. */
    function formatUptime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
      return `${minutes}m`
    }

    /** Wall-clock time of one epoch-millisecond stamp. */
    function formatClock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':')
    }

    /** Absolute metrics endpoint, resolved against the document's own base. */
    function metricsUrl(detail, windowSec) {
      const base = typeof document !== 'undefined' && document.baseURI
        ? document.baseURI
        : typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/'
      let url
      try {
        url = new URL('dsh-system-monitor/metrics', base)
      } catch {
        url = new URL('/dsh-system-monitor/metrics', 'http://127.0.0.1/')
      }
      if (detail) url.searchParams.set('detail', '1')
      if (windowSec) url.searchParams.set('window', String(windowSec))
      return url.href
    }

    /** Absolute export URL for one scope, format and window. */
    function exportUrl(format, windowSec, scope = 'series') {
      const base = typeof document !== 'undefined' && document.baseURI
        ? document.baseURI
        : typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/'
      let url
      try {
        url = new URL('dsh-system-monitor/export', base)
      } catch {
        url = new URL('/dsh-system-monitor/export', 'http://127.0.0.1/')
      }
      url.searchParams.set('format', format)
      url.searchParams.set('scope', scope)
      url.searchParams.set('window', String(windowSec))
      return url.href
    }

    /** Media type and description per export format, for the save dialog. */
    const EXPORT_FORMATS = {
      csv: { mime: 'text/csv', description: 'CSV' },
      json: { mime: 'application/json', description: 'JSON' },
      ndjson: { mime: 'application/x-ndjson', description: 'NDJSON' },
    }

    /**
     * Save one export, through the system's Save As dialog when there is one.
     *
     * `showSaveFilePicker` is the only way a page can raise a real Save As dialog
     * — folder, filename, the lot. It has one limitation worth stating rather
     * than papering over: **the browser never reveals the chosen path**, only the
     * filename. So a save through the dialog reports a name, and only the
     * fallback below can report a real location.
     *
     * Cancelling is not a failure. It returns `cancelled`, the caller stays
     * silent, and nothing is fetched — asking for data the user just declined to
     * save would be rude and wasteful.
     *
     * Nothing here ever creates a link or a blob URL. An earlier version did, and
     * a host that does not implement downloads treats those as a *navigation*,
     * which replaces the whole single-page app with a blank window.
     * @param format - `csv`, `json` or `ndjson`.
     * @param windowSec - the window to export.
     * @returns `{ ok, name }`, `{ ok, path }`, `{ cancelled }`, or `{ ok: false, reason }`.
     */
    async function saveExport(format, windowSec) {
      const url = exportUrl(format, windowSec, 'series')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const suggested = `system-monitor-${stamp}.${format}`

      // 1. The system dialog, when the host provides one.
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        let handle = null
        try {
          const spec = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.csv
          handle = await window.showSaveFilePicker({
            suggestedName: suggested,
            types: [{ description: spec.description, accept: { [spec.mime]: [`.${format}`] } }],
          })
        } catch (error) {
          // AbortError is the user pressing Cancel. Anything else means the
          // dialog is unusable here, so fall through to the fallback rather than
          // reporting a failure the user cannot act on.
          if (error?.name === 'AbortError') return { cancelled: true }
          handle = null
        }
        if (handle) {
          try {
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) return { ok: false, reason: 'unreachable' }
            const blob = await response.blob()
            if (blob.size === 0) return { ok: false, reason: 'empty' }
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            return { ok: true, name: handle.name, bytes: blob.size }
          } catch (error) {
            if (error?.name === 'AbortError') return { cancelled: true }
            return { ok: false, reason: 'write-failed' }
          }
        }
      }

      // 2. No dialog available: the Host writes the file and names the path.
      let target
      try {
        target = new URL(url)
      } catch {
        return { ok: false, reason: 'unreachable' }
      }
      target.searchParams.set('save', '1')
      let payload
      try {
        const response = await fetch(target.href, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return { ok: false, reason: 'unreachable' }
        payload = await response.json()
      } catch {
        return { ok: false, reason: 'unreachable' }
      }
      // A header-only CSV or an empty NDJSON is a real answer — "there is nothing
      // to export yet" — and writing an empty file would hide that.
      if (payload?.ok === true) {
        return payload.bytes > 0 ? { ok: true, path: payload.path, bytes: payload.bytes } : { ok: false, reason: 'empty' }
      }
      if (payload?.reason === 'empty') return { ok: false, reason: 'empty' }
      return { ok: false, reason: payload?.reason === 'unwritable' ? 'unwritable' : 'unreachable' }
    }

    /** Absolute sidebar-badge endpoint, resolved against the document's own base. */
    function alertsUrl() {
      const base = typeof document !== 'undefined' && document.baseURI
        ? document.baseURI
        : typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/'
      try {
        return new URL('dsh-system-monitor/alerts', base).href
      } catch {
        return '/dsh-system-monitor/alerts'
      }
    }

    /** Poll the Host's sustained-load state for the sidebar badge. */
    function useAlerts() {
      const [state, setState] = React.useState({ level: 'none', reasons: [] })
      React.useEffect(() => {
        let alive = true
        let timer = null
        const pull = async () => {
          try {
            const response = await fetch(alertsUrl(), { cache: 'no-store', credentials: 'same-origin' })
            if (response.ok) {
              const json = await response.json()
              if (alive) setState(json)
            }
          } catch {
            // Keep the last known state; a missed poll is not an all-clear.
          }
          if (alive) timer = setTimeout(pull, ALERT_POLL_MS)
        }
        void pull()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      return state
    }

    /** Localized name of one alerting resource. */
    function alertLabel(key) {
      if (key === 'cpu') return t('alert_cpu')
      if (key === 'memory') return t('alert_memory')
      if (key === 'gpu') return t('alert_gpu')
      if (key === 'sampler') return t('alert_sampler')
      return t('alert_disk')
    }

    /**
     * Localized name of one alert level. Separate from {@link alertLabel},
     * whose fallback would silently render a level as "disk".
     */
    function levelLabel(level) {
      if (level === 'high') return t('level_high')
      if (level === 'warn') return t('level_warn')
      if (level === 'busy') return t('health_busy')
      return t('level_ok')
    }

    /** Localized text for one machine-readable capability or failure reason. */
    function reasonText(reason) {
      if (!reason || typeof reason.code !== 'string') return ''
      const key = `reason_${reason.code.replace(/-/g, '_')}`
      const text = t(key)
      // A missing dictionary entry renders as the raw key; fall back instead.
      const base = text === key ? t('reason_unknown') : text
      if (typeof reason.detail === 'string' && reason.detail !== '') {
        return `${base}（${reason.detail}）`
      }
      return base
    }

    /** Localized name of one capability row. */
    function capabilityLabel(key) {
      const text = t(`cap_${key}`)
      return text === `cap_${key}` ? key : text
    }

    /**
     * Turn the Host's structured verdict into one sentence, naming the current
     * bottleneck when one exists.
     * @param health - the snapshot's health object.
     * @param bottleneck - the snapshot's bottleneck object.
     * @returns the sentence and the tone to paint it with.
     */
    function healthSentence(health, bottleneck) {
      if (!health || health.level === undefined) return { text: '', level: 'ok' }
      const resource = alertLabel(health.resource ?? 'cpu')
      const where = health.resource === 'disk' && health.disk ? `${resource} ${health.disk}` : resource
      let text
      let level = health.level
      if (health.level === 'ok') {
        text = t('health_ok')
      } else {
        const head = health.level === 'busy' ? t('health_busy') : t('health_over')
        text = `${head} · ${where} ${health.value}%`
        if (health.culprit && health.culprit.label) {
          text += ` · ${t('health_culprit')} ${health.culprit.label}`
        }
      }
      // Said only when it is news. When the most-strained resource is the one the
      // sentence already named, repeating it adds words and no information.
      if (bottleneck && bottleneck.resource && bottleneck.resource !== health.resource) {
        const label = alertLabel(bottleneck.resource)
        const detail = bottleneck.detail ? ` ${bottleneck.detail}` : ''
        text += ` · ${t('bottleneck')} ${label}${detail}`
        if (level === 'ok') level = 'busy'
      }
      return { text, level }
    }

    /** Coarse duration for a forecast: the precision beyond this is false comfort. */
    function formatSpan(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '—'
      if (seconds >= 86400) return t('duration_days').replace('{n}', String(Math.round(seconds / 86400)))
      if (seconds >= 3600) return t('duration_hours').replace('{n}', String(Math.round(seconds / 3600)))
      return t('duration_minutes').replace('{n}', String(Math.max(1, Math.round(seconds / 60))))
    }

    /**
     * One sentence per forecast, or null when there is nothing useful to say.
     * A flat trend is reported as flat rather than hidden, so the reader can tell
     * "measured, going nowhere" from "not measured yet".
     * @param forecast - the snapshot's forecast object.
     * @returns `{ disk, memory, battery }` sentences, each possibly null.
     */
    function forecastNotes(forecast) {
      if (!forecast) return { disk: null, memory: null, battery: null }
      const minutes = (seconds) => String(Math.max(1, Math.round(seconds / 60)))
      let disk = null
      if (forecast.disk) {
        const soonest = (forecast.disk.mounts ?? []).find((entry) => entry.daysLeft !== null)
        if (soonest) {
          disk = t('forecast_disk_days')
            .replace('{w}', minutes(forecast.disk.windowSec))
            .replace('{d}', formatSpan(soonest.daysLeft * 86400)) + ` · ${soonest.mount}`
        } else if (forecast.disk.mounts?.length) {
          disk = t('forecast_disk_flat').replace('{w}', minutes(forecast.disk.windowSec))
        }
      }
      let memory = null
      if (forecast.memory) {
        memory = forecast.memory.secondsLeft !== null
          ? t('forecast_memory_eta')
            .replace('{w}', minutes(forecast.memory.windowSec))
            .replace('{d}', formatSpan(forecast.memory.secondsLeft))
          : t('forecast_memory_flat').replace('{w}', minutes(forecast.memory.windowSec))
      }
      let battery = null
      const cell = forecast.battery
      if (cell && cell.state === 'present') {
        const parts = [`${cell.percent ?? '—'}%`]
        parts.push(cell.charging ? t('battery_charging') : t('battery_discharging'))
        if (!cell.charging && Number.isFinite(cell.minutes)) {
          parts.push(t('battery_left').replace('{d}', formatSpan(cell.minutes * 60)))
        }
        battery = parts.join(' · ')
      }
      return { disk, memory, battery }
    }

    /** One bar per resource showing how close it is to saturation. */
    function PressureRow(props) {
      const pressures = props.pressures ?? {}
      const keys = ['cpu', 'memory', 'gpu', 'disk']
      if (keys.every((key) => props.pressures === undefined)) return null
      return h('div', { className: 'dsm-pressure' }, keys.map((key) => {
        const value = Math.max(0, Math.min(1.5, Number(pressures[key]) || 0))
        const color = value >= 1
          ? 'var(--dsw-alias-state-error-primary)'
          : value >= 0.85 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)'
        const blame = props.bottleneck === key
        return h('div', { key, className: 'dsm-pressureItem', 'data-blame': blame ? 'true' : 'false' },
          h('span', { className: 'dsm-pressureLabel' }, alertLabel(key)),
          h('div', { className: 'dsm-pressureTrack' },
            h('div', {
              className: 'dsm-pressureFill',
              style: { width: `${Math.min(100, value * 100)}%`, background: color },
            }),
          ),
          h('span', { className: 'dsm-pressureValue' }, `${Math.round(value * 100)}%`),
        )
      }))
    }

    /** Colour of one badge state. */
    function alertColor(level) {
      if (level === 'high') return 'var(--dsw-alias-state-error-primary)'
      if (level === 'warn') return 'var(--dsw-alias-state-warn-primary)'
      return null
    }

    /** Human summary of an alert state, used for the badge tooltip. */
    function alertSummary(alerts) {
      const reasons = alerts?.reasons ?? []
      if (reasons.length === 0) return ''
      return reasons.map((reason) => {
        const suffix = reason.detail ? ` ${reason.detail}` : ''
        // A reason without a value is not a percentage — a collector fault says
        // which fault it is and nothing more.
        if (reason.value === null || reason.value === undefined) return `${alertLabel(reason.key)}${suffix}`
        return `${alertLabel(reason.key)}${suffix} ${reason.value}%`
      }).join(' · ')
    }

    /** Root-relative URL of one cached application icon. */
    function iconUrl(key) {
      const base = typeof document !== 'undefined' && document.baseURI
        ? document.baseURI
        : typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/'
      try {
        const url = new URL('dsh-system-monitor/icon', base)
        url.searchParams.set('key', key)
        return url.href
      } catch {
        return `/dsh-system-monitor/icon?key=${encodeURIComponent(key)}`
      }
    }

    /** Stable avatar colour for an application that exposes no icon. */
    function avatarColor(label) {
      let hash = 0
      for (let index = 0; index < label.length; index += 1) {
        hash = (hash * 31 + label.charCodeAt(index)) | 0
      }
      return `hsl(${Math.abs(hash) % 360} 42% 42%)`
    }

    /** The application's own icon, or a coloured initial when it has none. */
    function AppIcon(props) {
      const key = props.icons?.[props.label]
      if (typeof key === 'string' && key !== '') {
        return h('img', {
          className: 'dsm-appIcon',
          src: iconUrl(key),
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          'aria-hidden': 'true',
        })
      }
      const initial = (props.label ?? '?').trim().charAt(0) || '?'
      return h('span', {
        className: 'dsm-appIcon dsm-appIconFallback',
        style: { background: avatarColor(props.label ?? '') },
        'aria-hidden': 'true',
      }, initial)
    }

    /** Fold the per-process rows into one row per application. */
    function aggregateByApp(processes) {
      const map = new Map()
      for (const item of processes) {
        const label = item.label || item.name || `pid ${item.pid}`
        let entry = map.get(label)
        if (entry === undefined) {
          entry = { label, count: 0, cpu: 0, memory: 0, gpu: 0, diskRead: 0, diskWrite: 0 }
          map.set(label, entry)
        }
        entry.count += 1
        entry.cpu += item.cpu
        entry.memory += item.memory
        if (item.gpu > entry.gpu) entry.gpu = item.gpu
        entry.diskRead += item.diskRead ?? 0
        entry.diskWrite += item.diskWrite ?? 0
      }
      const rows = [...map.values()]
      for (const row of rows) row.cpu = Math.round(row.cpu * 10) / 10
      return rows
    }

    /** Which column a resource sorts and scales its table by. */
    const PRIMARY = { cpu: 'cpu', memory: 'memory', gpu: 'gpu' }

    /**
     * Alert toasts, rendered into `shell.overlay` so they appear over whatever
     * the reader is actually looking at.
     *
     * A monitor whose only output is a panel is a monitor nobody reads: an alert
     * has to reach someone who is in the middle of something else. Transitions
     * are detected here rather than pushed, which keeps the Host free of any
     * client-facing RPC surface.
     */
    function AlertToaster() {
      const [toasts, setToasts] = React.useState([])
      const previous = React.useRef(null)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const pull = async () => {
          try {
            const response = await fetch(alertsUrl(), { cache: 'no-store', credentials: 'same-origin' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const state = await response.json()
            const level = state?.level ?? 'none'
            const was = previous.current
            previous.current = level
            // The first poll sets the baseline; only real transitions notify.
            if (was !== null && level !== was && level !== 'none') {
              setToasts((current) => [
                ...current.slice(-(TOAST_MAX - 1)),
                { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, level, reasons: state.reasons ?? [] },
              ])
            }
          } catch {
            // An unreachable Host is already reported in the panel itself.
          }
          if (alive) timer = setTimeout(pull, ALERT_POLL_MS)
        }
        void pull()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      // Each toast expires on its own clock, keyed by its own id.
      React.useEffect(() => {
        if (toasts.length === 0) return undefined
        const timers = toasts.map((toast) => setTimeout(() => {
          setToasts((current) => current.filter((entry) => entry.id !== toast.id))
        }, TOAST_MS))
        return () => { for (const timer of timers) clearTimeout(timer) }
      }, [toasts])
      if (toasts.length === 0) return null
      const dismiss = (id) => setToasts((current) => current.filter((entry) => entry.id !== id))
      return h('div', { className: 'dsm-toasts', role: 'status', 'aria-live': 'polite' },
        h('style', null, TOAST_CSS),
        toasts.map((toast) => h('div', { key: toast.id, className: 'dsm-toast', 'data-level': toast.level },
          h('i', { className: 'dsm-toastBar' }),
          h('div', { className: 'dsm-toastBody' },
            h('div', { className: 'dsm-toastHead' },
              h(ResourceGlyph, { kind: 'cpu', size: 13 }),
              h('span', { className: 'dsm-toastTitle' }, t('toast_title')),
              h('span', { className: 'dsm-toastLevel' }, levelLabel(toast.level)),
            ),
            h('p', { className: 'dsm-toastText' },
              t('toast_body').replace('{r}', toast.reasons.map((reason) => alertLabel(reason.key)).join(' · ') || levelLabel(toast.level)),
            ),
            h('div', { className: 'dsm-toastActions' },
              h('button', {
                type: 'button',
                className: 'dsm-toastOpen',
                onClick: () => {
                  dismiss(toast.id)
                  openPanel()
                },
              }, t('toast_open')),
              h('button', {
                type: 'button',
                className: 'dsm-toastClose',
                'aria-label': t('close'),
                onClick: () => dismiss(toast.id),
              }, '✕'),
            ),
          ),
        )),
      )
    }

    /** One horizontal bar scaled to the largest value in the list. */
    function ScaledBar(props) {
      const ratioValue = props.max > 0 ? Math.max(2, Math.min(100, (props.value / props.max) * 100)) : 0
      return h('div', { className: 'dsm-bar' },
        h('div', { className: 'dsm-barFill', style: { width: `${ratioValue}%`, background: props.color } }),
      )
    }

    /** Sparkline over the trailing history window. */
    function Spark(props) {
      const values = props.values ?? []
      const height = props.height ?? 42
      if (values.length < 2) {
        return h('div', {
          className: 'dsm-spark dsm-sparkEmpty',
          style: { height },
          'aria-hidden': 'true',
        })
      }
      const gradientId = `dsm-spark-${props.id ?? 'x'}`
      const last = values.length - 1
      const points = values.map((value, index) => {
        const x = (index / last) * 100
        const clamped = Math.max(0, Math.min(100, Number(value) || 0))
        const y = 30 - (clamped / 100) * 28
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      return h('svg', {
        className: 'dsm-spark',
        viewBox: '0 0 100 30',
        preserveAspectRatio: 'none',
        style: { height },
        'aria-hidden': 'true',
      },
        h('defs', null, h('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: '0%', stopColor: props.color, stopOpacity: 0.3 }),
          h('stop', { offset: '100%', stopColor: props.color, stopOpacity: 0 }),
        )),
        h('polygon', { points: `0,30 ${points.join(' ')} 100,30`, fill: `url(#${gradientId})` }),
        h('polyline', {
          points: points.join(' '),
          fill: 'none',
          stroke: props.color,
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }),
      )
    }

    /** Donut gauge with the reading in the middle and the window peak marked. */
    function Ring(props) {
      const size = props.size ?? RING_SIZE
      const stroke = props.stroke ?? 9
      const radius = size / 2 - stroke / 2 - 1.5
      const circumference = 2 * Math.PI * radius
      const value = Number.isFinite(props.value) ? Math.max(0, Math.min(100, props.value)) : 0
      const offset = circumference * (1 - value / 100)
      const peak = Array.isArray(props.history) && props.history.length > 2
        ? Math.max(...props.history.map((entry) => Number(entry) || 0))
        : 0
      const markPeak = peak > 4 && peak <= 100 && Math.abs(peak - value) > 1.5
      const angle = ((-90 + (peak / 100) * 360) * Math.PI) / 180
      return h('div', { className: 'dsm-ringWrap', style: { width: size, height: size } },
        h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
          h('defs', null, h('linearGradient', { id: `dsm-ring-${props.id ?? 'x'}`, x1: 0, y1: 0, x2: 1, y2: 1 },
            h('stop', { offset: '0%', stopColor: props.color, stopOpacity: 1 }),
            h('stop', { offset: '100%', stopColor: props.color, stopOpacity: 0.72 }),
          )),
          h('circle', {
            cx: size / 2, cy: size / 2, r: radius,
            fill: 'none', stroke: 'var(--dsw-alias-bg-layer-3)', strokeWidth: stroke,
          }),
          h('circle', {
            cx: size / 2, cy: size / 2, r: radius,
            fill: 'none', stroke: `url(#dsm-ring-${props.id ?? 'x'})`, strokeWidth: stroke, strokeLinecap: 'round',
            strokeDasharray: circumference, strokeDashoffset: offset,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
            style: { transition: 'stroke-dashoffset .7s cubic-bezier(.4,0,.2,1)' },
          }),
          markPeak ? h('circle', {
            cx: size / 2 + radius * Math.cos(angle),
            cy: size / 2 + radius * Math.sin(angle),
            r: 2.6, fill: 'var(--dsw-alias-bg-layer-1)', stroke: props.color, strokeWidth: 1.6,
          }) : null,
        ),
        h('div', { className: 'dsm-ringMid' },
          h('span', { className: 'dsm-ringNum' }, props.display),
          h('span', { className: 'dsm-ringUnit' }, props.unit ?? '%'),
        ),
      )
    }

    /** Chevron hinting that a card opens a detail view. */
    function Chevron() {
      return h('svg', {
        className: 'dsm-chevron', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M9 6l6 6-6 6' }))
    }

    /** Line glyph for one resource, so a card is identifiable before it is read. */
    function ResourceGlyph(props) {
      const size = props.size ?? 16
      const paths = {
        cpu: [
          h('rect', { key: 'a', x: 7, y: 7, width: 10, height: 10, rx: 2 }),
          h('path', { key: 'b', d: 'M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4' }),
        ],
        memory: [
          h('rect', { key: 'a', x: 2.5, y: 7, width: 19, height: 10, rx: 2 }),
          h('path', { key: 'b', d: 'M7 10v4M12 10v4M17 10v4' }),
        ],
        gpu: [
          h('rect', { key: 'a', x: 2.5, y: 6, width: 19, height: 12, rx: 2 }),
          h('circle', { key: 'b', cx: 9, cy: 12, r: 2.6 }),
          h('path', { key: 'c', d: 'M15 9.5h3.5M15 14.5h3.5' }),
        ],
        disk: [
          h('ellipse', { key: 'a', cx: 12, cy: 6.5, rx: 8, ry: 3.2 }),
          h('path', { key: 'b', d: 'M4 6.5v11a8 3.2 0 0 0 16 0v-11' }),
          h('path', { key: 'c', d: 'M4 12a8 3.2 0 0 0 16 0' }),
        ],
        download: [
          h('path', { key: 'a', d: 'M12 4v11' }),
          h('path', { key: 'b', d: 'M7.5 10.5L12 15l4.5-4.5' }),
          h('path', { key: 'c', d: 'M5 19h14' }),
        ],
        chart: [
          h('path', { key: 'a', d: 'M3 20h18' }),
          h('path', { key: 'b', d: 'M6 16l4-5 3.5 3L20 6' }),
          h('circle', { key: 'c', cx: 20, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        ],
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      }, paths[props.kind] ?? paths.chart)
    }

    /**
     * Categorical palette for share charts. Fixed lightness and saturation keep
     * the same hues legible on both themes; these are chart colours, not chrome.
     */
    function paletteColor(index) {
      return `hsl(${(index * 47) % 360} 52% 55%)`
    }

    /** Direction of a series over roughly the last ten seconds. */
    function trendOf(history) {
      if (!Array.isArray(history) || history.length < 12) return 0
      const delta = history[history.length - 1] - history[history.length - 11]
      if (Math.abs(delta) < 2) return 0
      return delta > 0 ? 1 : -1
    }

    /** Heat bucket for one core reading. */
    function heatFill(value) {
      if (value >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (value >= 75) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    /** Opacity completing the heat ramp, so idle cores recede. */
    function heatOpacity(value) {
      if (value < 2) return 0.06
      if (value < 25) return 0.3
      if (value < 50) return 0.55
      return 1
    }

    /**
     * One chart of CPU, memory and GPU on a shared timeline. Hovering locks a
     * vertical crosshair and reports every series at that moment, which is what
     * makes a spike attributable to a resource.
     */
    function TrendChart(props) {
      const series = props.series ?? []
      const [hover, setHover] = React.useState(null)
      /**
       * Alert transitions inside the drawn window become shaded *spans* rather
       * than single lines: how long something stayed bad matters more than the
       * instant it tripped, and a span is the only way to see that at a glance.
       */
      const spans = React.useMemo(() => {
        const log = props.alertLog ?? []
        if (log.length === 0 || series.length < 2) return []
        const from = series[0].t
        const to = series[series.length - 1].t
        if (!(to > from)) return []
        const out = []
        for (let index = 0; index < log.length; index += 1) {
          const entry = log[index]
          if (entry.level === 'none') continue
          const end = log[index + 1]?.t ?? to
          const start = Math.max(entry.t, from)
          const stop = Math.min(end, to)
          if (stop <= start) continue
          out.push({
            left: ((start - from) / (to - from)) * 100,
            width: ((stop - start) / (to - from)) * 100,
            level: entry.level,
          })
        }
        return out
      }, [props.alertLog, series])
      if (series.length < 2) {
        return h('section', { className: 'dsm-card' },
          h('h2', { className: 'dsm-cardName' }, t('trend')),
          h('p', { className: 'dsm-empty' }, t('none')),
        )
      }
      const last = series.length - 1
      // GPU only reports while its sampler runs; carry the last value forward
      // rather than drawing a cliff to zero.
      let carried = 0
      const gpuSeries = series.map((point) => {
        if (typeof point.gpu === 'number') carried = point.gpu
        return carried
      })
      const x = (index) => (index / last) * 100
      const y = (value) => 40 - (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * 37 - 1.5
      const paths = {
        cpu: series.map((point, index) => `${x(index).toFixed(2)},${y(point.cpu).toFixed(2)}`).join(' '),
        mem: series.map((point, index) => `${x(index).toFixed(2)},${y(point.mem).toFixed(2)}`).join(' '),
        gpu: gpuSeries.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' '),
      }
      const defs = [
        { key: 'cpu', color: 'var(--dsw-alias-brand-primary)', label: t('cpu') },
        { key: 'mem', color: 'var(--dsw-alias-state-success-primary)', label: t('memory') },
        ...(props.showGpu === false
          ? []
          : [{ key: 'gpu', color: 'var(--dsw-alias-state-warn-primary)', label: t('gpu') }]),
      ]
      // The hover index is a position in a series that keeps growing, so clamp
      // it rather than trusting it to still be in range on a later render.
      const at = hover === null || !Number.isFinite(hover)
        ? last
        : Math.min(last, Math.max(0, Math.round(hover)))
      const point = series[at] ?? series[last]
      const values = { cpu: point.cpu, mem: point.mem, gpu: gpuSeries[at] }
      /** The window peak of each series, positioned for an overlay marker. */
      const peaks = defs.map((definition) => {
        const source = definition.key === 'gpu' ? gpuSeries : series.map((entry) => Number(entry[definition.key]) || 0)
        let bestIndex = 0
        for (let index = 1; index < source.length; index += 1) {
          if (source[index] > source[bestIndex]) bestIndex = index
        }
        return {
          key: definition.key,
          color: definition.color,
          label: definition.label,
          value: Number(source[bestIndex]) || 0,
          t: series[bestIndex]?.t ?? 0,
          fraction: bestIndex / last,
        }
      })
      /**
       * Time-axis ticks. Long windows read better as clock times; short ones as
       * "how long ago", which is what the reader is actually asking.
       */
      const spanSec = (series[last].t - series[0].t) / 1000
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const index = Math.round(fraction * last)
        const stamp = series[index]?.t ?? 0
        const ago = (series[last].t - stamp) / 1000
        const label = spanSec >= 900 || ago < 2
          ? formatClock(stamp)
          : `−${formatSpan(ago)}`
        return { key: fraction, label }
      })
      const fraction = at / last
      const anchor = fraction < 0.15 ? '0' : fraction > 0.85 ? '-100%' : '-50%'

      return h('section', { className: 'dsm-card' },
        h('header', { className: 'dsm-cardHead' },
          h('div', { className: 'dsm-cardTitleRow' },
            h('span', { className: 'dsm-cardGlyph', style: { color: 'var(--dsw-alias-brand-primary)' } },
              h(ResourceGlyph, { kind: 'chart', size: 15 }),
            ),
            h('h2', { className: 'dsm-cardName' }, t('trend')),
          ),
          h('span', { className: 'dsm-cardMeta' },
            `${t('trend_hint')}${props.windowSec ? ` · ${formatSpan(props.windowSec)}` : ''}`),
        ),
        h('div', { className: 'dsm-chartRow' },
          h('div', { className: 'dsm-chartAxis' }, h('span', null, '100%'), h('span', null, '50%'), h('span', null, '0%')),
          h('div', {
            className: 'dsm-chartPlot',
            onMouseMove: (event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              if (rect.width <= 0) return
              const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
              setHover(Math.round(ratio * last))
            },
            onMouseLeave: () => setHover(null),
          },
            h('svg', {
              className: 'dsm-chart', viewBox: '0 0 100 40', preserveAspectRatio: 'none',
              style: props.height ? { height: props.height } : undefined,
              'aria-hidden': 'true',
            },
              h('defs', null, defs.map((definition) => h('linearGradient', {
                key: definition.key, id: `dsm-trend-${definition.key}`, x1: 0, y1: 0, x2: 0, y2: 1,
              },
                h('stop', { offset: '0%', stopColor: definition.color, stopOpacity: 0.26 }),
                h('stop', { offset: '100%', stopColor: definition.color, stopOpacity: 0 }),
              ))),
              [10, 20, 30].map((line) => h('line', {
                key: line, x1: 0, x2: 100, y1: line, y2: line,
                stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke',
              })),
              spans.map((span, index) => h('rect', {
                key: `span-${index}`,
                x: span.left, y: 0, width: Math.max(span.width, 0.25), height: 40,
                fill: alertColor(span.level) ?? 'var(--dsw-alias-state-warn-primary)',
                opacity: 0.13,
              })),
              spans.map((span, index) => h('line', {
                key: `spanEdge-${index}`,
                x1: span.left, x2: span.left, y1: 0, y2: 40,
                stroke: alertColor(span.level) ?? 'var(--dsw-alias-state-warn-primary)',
                strokeWidth: 1, opacity: 0.4, vectorEffect: 'non-scaling-stroke',
              })),
              defs.map((definition) => h('polygon', {
                key: `${definition.key}-area`,
                points: `0,40 ${paths[definition.key]} 100,40`,
                fill: `url(#dsm-trend-${definition.key})`,
              })),
              defs.map((definition) => h('polyline', {
                key: definition.key,
                points: paths[definition.key],
                fill: 'none', stroke: definition.color, strokeWidth: 1.8,
                strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
              })),
              hover === null ? null : h('line', {
                x1: x(hover), x2: x(hover), y1: 0, y2: 40,
                stroke: 'var(--dsw-alias-label-tertiary)', strokeWidth: 1,
                strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke',
              }),
            ),
            hover === null ? defs.map((definition) => h('span', {
              key: `${definition.key}-end`,
              className: 'dsm-chartEnd',
              style: { top: `${(y(values[definition.key]) / 40) * 100}%`, background: definition.color },
            })) : null,
            // The window's own peak, so a spike that has already passed is still
            // readable instead of looking like a quiet stretch.
            hover === null ? peaks.map((peak) => h('span', {
              key: `${peak.key}-peak`,
              className: 'dsm-chartPeak',
              title: `${peak.label} ${t('peak')} ${Math.round(peak.value)}% · ${formatClock(peak.t)}`,
              style: {
                left: `${peak.fraction * 100}%`,
                top: `${(y(peak.value) / 40) * 100}%`,
                borderColor: peak.color,
              },
            })) : null,
            hover === null ? null : h('div', {
              className: 'dsm-chartTip',
              style: { left: `${fraction * 100}%`, transform: `translateX(${anchor})` },
            },
              h('div', { className: 'dsm-chartTipTime' }, formatClock(point.t)),
              defs.map((definition) => h('div', { key: definition.key, className: 'dsm-chartTipRow' },
                h('i', { className: 'dsm-legendDot', style: { background: definition.color } }),
                h('span', null, definition.label),
                h('strong', null, `${Math.round(values[definition.key] ?? 0)}%`),
              )),
            ),
          ),
        ),
        h('div', { className: 'dsm-chartAxisRow' },
          h('div', { className: 'dsm-chartGutter' }),
          h('div', { className: 'dsm-chartTicks' }, ticks.map((tick) =>
            h('span', { key: tick.key }, tick.label))),
        ),
        h('div', { className: 'dsm-legend' }, defs.map((definition) => h('span', {
          key: definition.key, className: 'dsm-legendItem',
        },
          h('i', { className: 'dsm-legendDot', style: { background: definition.color } }),
          h('span', null, definition.label),
          h('strong', null, `${Math.round(values[definition.key] ?? 0)}%`),
        ))),
      )
    }

    /**
     * Per-core load over time: one row per logical core, newest column at the
     * right. A single pegged core is obvious here in a way a bar chart misses.
     */
    function CoreHeatmap(props) {
      const timeline = props.timeline ?? []
      const columns = timeline[0]?.length ?? 0
      if (timeline.length === 0 || columns < 2) return null
      return h('div', { className: 'dsm-heat' }, timeline.map((row, index) =>
        h('div', { key: index, className: 'dsm-heatRow' },
          h('span', { className: 'dsm-heatLabel' }, String(index)),
          h('svg', {
            className: 'dsm-heatStrip',
            viewBox: `0 0 ${columns} 1`,
            preserveAspectRatio: 'none',
            'aria-hidden': 'true',
          }, row.map((value, column) => h('rect', {
            key: column, x: column, y: 0, width: 1, height: 1,
            fill: heatFill(value), fillOpacity: heatOpacity(value),
          }))),
          h('span', { className: 'dsm-heatValue' }, `${Math.round(row[columns - 1] ?? 0)}%`),
        ),
      ))
    }

    /** One horizontal bar of application memory shares, largest first. */
    function CompositionBar(props) {
      const total = props.total
      if (!(total > 0)) return null
      const rows = aggregateByApp(props.processes).sort((left, right) => right.memory - left.memory)
      if (rows.length === 0) return null
      const used = rows.reduce((sum, row) => sum + row.memory, 0)
      const top = rows.slice(0, 6)
      const segments = top.map((row, index) => ({
        label: row.label,
        bytes: row.memory,
        color: paletteColor(index),
        app: true,
      }))
      const rest = rows.slice(6).reduce((sum, row) => sum + row.memory, 0)
      if (rest > 0) segments.push({ label: t('others'), bytes: rest, color: 'var(--dsw-alias-label-tertiary)', app: false })
      const free = Math.max(0, total - used)
      if (free > 0) segments.push({ label: t('free'), bytes: free, color: 'var(--dsw-alias-bg-layer-3)', app: false })

      return h('div', { className: 'dsm-compose' },
        h('p', { className: 'dsm-groupLabel' }, t('memory_share')),
        h('div', { className: 'dsm-composeBar' }, segments.map((segment, index) => h('div', {
          key: index,
          className: 'dsm-composeSeg',
          style: { flexGrow: Math.max(segment.bytes, 1), background: segment.color },
          title: `${segment.label} · ${formatBytes(segment.bytes)}`,
        }))),
        h('div', { className: 'dsm-legend dsm-legendWrap' }, segments.map((segment, index) =>
          h('span', { key: index, className: 'dsm-legendItem' },
            h('i', { className: 'dsm-legendDot', style: { background: segment.color } }),
            segment.app ? h(AppIcon, { label: segment.label, icons: props.appIcons }) : null,
            h('span', { className: 'dsm-legendName' }, segment.label),
            h('strong', null, formatBytes(segment.bytes)),
          ),
        )),
      )
    }

    /** Physical-disk read and write throughput on one shared scale. */
    function IoChart(props) {
      const points = props.points ?? []
      if (points.length < 2) return null
      const peak = Math.max(1024, ...points.map((point) => Math.max(point.read, point.write)))
      const last = points.length - 1
      const x = (index) => (index / last) * 100
      const y = (value) => 30 - (Math.max(0, value) / peak) * 28 - 1
      const paths = {
        read: points.map((point, index) => `${x(index).toFixed(2)},${y(point.read).toFixed(2)}`).join(' '),
        write: points.map((point, index) => `${x(index).toFixed(2)},${y(point.write).toFixed(2)}`).join(' '),
      }
      const defs = [
        { key: 'read', color: 'var(--dsw-alias-brand-primary)', label: t('io_read') },
        { key: 'write', color: 'var(--dsw-alias-state-warn-primary)', label: t('io_write') },
      ]
      const current = points[last]
      return h('div', { className: 'dsm-compose' },
        h('p', { className: 'dsm-groupLabel' }, `${t('disk_io')} · ${t('nominal')} ${formatRate(peak)}`),
        h('svg', { className: 'dsm-spark', viewBox: '0 0 100 30', preserveAspectRatio: 'none', style: { height: 54 }, 'aria-hidden': 'true' },
          h('defs', null, defs.map((definition) => h('linearGradient', {
            key: definition.key, id: `dsm-io-${definition.key}`, x1: 0, y1: 0, x2: 0, y2: 1,
          },
            h('stop', { offset: '0%', stopColor: definition.color, stopOpacity: 0.28 }),
            h('stop', { offset: '100%', stopColor: definition.color, stopOpacity: 0 }),
          ))),
          defs.map((definition) => h('polygon', {
            key: `${definition.key}-area`,
            points: `0,30 ${paths[definition.key]} 100,30`,
            fill: `url(#dsm-io-${definition.key})`,
          })),
          defs.map((definition) => h('polyline', {
            key: definition.key,
            points: paths[definition.key],
            fill: 'none', stroke: definition.color, strokeWidth: 1.6,
            strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
          })),
        ),
        h('div', { className: 'dsm-legend' }, defs.map((definition) => h('span', {
          key: definition.key, className: 'dsm-legendItem',
        },
          h('i', { className: 'dsm-legendDot', style: { background: definition.color } }),
          h('span', null, definition.label),
          h('strong', null, formatRate(current[definition.key])),
        ))),
      )
    }

    /** One resource card: gauge, reading lines and its own history. */
    function GaugeCard(props) {
      return h('section', {
        className: 'dsm-card',
        'data-openable': 'true',
        'data-active': props.active ? 'true' : 'false',
        onClick: props.onOpen,
      },
        h('span', {
          className: 'dsm-cardTint',
          style: {
            background: `radial-gradient(120% 90% at 12% 0%, color-mix(in srgb, ${props.color} 13%, transparent), transparent 62%)`,
          },
        }),
        h('header', { className: 'dsm-cardHead' },
          h('div', { className: 'dsm-cardTitleRow' },
            h('span', { className: 'dsm-cardGlyph', style: { color: props.color } },
              h(ResourceGlyph, { kind: props.kind, size: 15 }),
            ),
            h('h2', { className: 'dsm-cardName' },
              h('button', {
                type: 'button',
                className: 'dsm-nameBtn',
                title: t('open_detail'),
                onClick: (event) => {
                  event.stopPropagation()
                  props.onOpen()
                },
              }, props.title, h(Chevron)),
            ),
          ),
          h('span', { className: 'dsm-cardMeta', title: props.meta },
            props.meta,
            props.trend ? h('i', {
              className: 'dsm-trend', 'data-dir': String(props.trend),
              title: props.trend > 0 ? '↑' : '↓',
            }, props.trend > 0 ? '▲' : '▼') : null,
          ),
        ),
        props.chip ?? null,
        h('div', { className: 'dsm-gaugeRow' },
          h(Ring, {
            value: props.value, color: props.color, display: props.display, unit: props.unit,
            history: props.history, id: props.kind,
            size: props.ringSize, stroke: props.ringStroke,
          }),
          h('div', { className: 'dsm-lines' }, props.lines.map((line, index) =>
            h('div', { key: index, className: 'dsm-line', 'data-strong': index === 0 ? 'true' : 'false', title: line }, line),
          )),
        ),
        h(Spark, { values: props.history, color: props.color, height: props.sparkHeight ?? 42, id: props.kind }),
        props.note ? h('p', { className: 'dsm-footNote' }, props.note) : null,
      )
    }

    /** Per-logical-core column chart, then the same cores over time. */
    function CoreGrid(props) {
      return h('section', { className: 'dsm-card' },
        h('header', { className: 'dsm-cardHead' },
          h('div', { className: 'dsm-cardTitleRow' },
            h('span', { className: 'dsm-cardGlyph', style: { color: 'var(--dsw-alias-brand-primary)' } },
              h(ResourceGlyph, { kind: 'cpu', size: 15 }),
            ),
            h('h2', { className: 'dsm-cardName' }, t('cores')),
          ),
          h('span', { className: 'dsm-cardMeta' }, t('cores_hint')),
        ),
        h('div', { className: 'dsm-cores' }, props.perCore.map((value, index) =>
          h('div', { key: index, className: 'dsm-core', title: `#${index} · ${value}%` },
            h('div', {
              className: 'dsm-coreTrack',
              style: props.trackHeight ? { height: props.trackHeight } : undefined,
            },
              h('div', {
                className: 'dsm-coreFill',
                style: { height: `${Math.max(2, Math.min(100, value))}%`, background: levelColor(value) },
              }),
            ),
            h('span', { className: 'dsm-coreLabel' }, String(index)),
          ),
        )),
        h(CoreHeatmap, { timeline: props.timeline }),
        props.timeline && props.timeline.length > 0
          ? h('p', { className: 'dsm-footNote' }, t('cores_heat'))
          : null,
      )
    }

    /** Volume rows with used/total and free bytes. */
    function DiskRows(props) {
      const disks = props.disks ?? []
      if (disks.length === 0) return h('p', { className: 'dsm-empty' }, t('no_disks'))
      return h('div', { className: 'dsm-disks' }, disks.map((disk) => {
        const color = levelColor(disk.usage)
        return h('div', { key: disk.mount, className: 'dsm-disk' },
          h('span', { className: 'dsm-diskBadge' }, disk.mount),
          h('div', { className: 'dsm-diskBody' },
            h('div', { className: 'dsm-bar' },
              h('div', { className: 'dsm-barFill', style: { width: `${disk.usage}%`, background: color } }),
            ),
            h('div', { className: 'dsm-diskText' },
              h('span', null, `${t('used')} ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`),
              h('span', null, `${t('free')} ${formatBytes(disk.free)}`),
            ),
          ),
          h('span', { className: 'dsm-diskPct', style: { color } }, `${disk.usage}%`),
        )
      }))
    }

    /** Volume overview card. */
    function DiskList(props) {
      const disks = props.disks ?? []
      const storage = props.storage ?? {}
      const latencyMs = Number.isFinite(storage.latencySec) ? storage.latencySec * 1000 : null
      const meta = latencyMs === null
        ? (disks.length > 0 ? `${disks.length} ${t('total')}` : '')
        : `${t('disk_latency')} ${latencyMs < 1 ? latencyMs.toFixed(2) : latencyMs.toFixed(1)} ms` +
          (Number.isFinite(storage.queue) ? ` · ${t('disk_queue')} ${storage.queue.toFixed(1)}` : '')
      return h('section', { className: 'dsm-card' },
        h('header', { className: 'dsm-cardHead' },
          h('div', { className: 'dsm-cardTitleRow' },
            h('span', { className: 'dsm-cardGlyph', style: { color: 'var(--dsw-alias-label-secondary)' } },
              h(ResourceGlyph, { kind: 'disk', size: 15 }),
            ),
            h('h2', { className: 'dsm-cardName' }, t('disks')),
          ),
          h('span', { className: 'dsm-cardMeta' }, meta),
        ),
        h(DiskRows, { disks }),
        props.note ? h('p', { className: 'dsm-footNote' }, props.note) : null,
      )
    }

    /** A signed byte delta, coloured by direction. */
    function formatDelta(bytes) {
      const sign = bytes > 0 ? '+' : bytes < 0 ? '−' : ''
      return `${sign}${formatBytes(Math.abs(bytes))}`
    }

    /** Absolute time for one epoch-millisecond stamp. */
    function formatDateTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * The processes behind one application row, shown when that row is expanded.
     * This is where "which of Chrome's fifteen processes is the problem" is
     * answered.
     */
    function AppProcesses(props) {
      const rows = (props.processes ?? [])
        .filter((item) => (item.label || item.name) === props.label)
        .sort((left, right) => right.memory - left.memory)
      if (rows.length === 0) return null
      const path = props.paths?.[props.label]
      return h('div', { className: 'dsm-appDetail' },
        path ? h('div', { className: 'dsm-appPath', title: path },
          h('span', { className: 'dsm-appPathKey' }, t('path_label')),
          h('code', null, path),
        ) : null,
        h('div', { className: 'dsm-row dsm-rowHead dsm-appRow' },
          h('span', { className: 'dsm-cPid' }, t('pid_label')),
          h('span', { className: 'dsm-cName' }),
          h('span', { className: 'dsm-cSub', style: { width: 84 } }, t('cpu')),
          h('span', { className: 'dsm-cValue', style: { width: 84 } }, t('memory')),
          h('span', { className: 'dsm-cSub', style: { width: 64 } }, t('gpu')),
          h('span', { className: 'dsm-cSub', style: { width: 110 } }, t('started')),
        ),
        rows.map((item) => h('div', { key: item.pid, className: 'dsm-row dsm-appRow' },
          h('span', { className: 'dsm-cPid' }, String(item.pid)),
          h('span', { className: 'dsm-cName' },
            h('span', { className: 'dsm-cNameText dsm-dim' }, item.name || '—'),
          ),
          h('span', { className: 'dsm-cSub', style: { width: 84 } }, `${item.cpu}%`),
          h('span', { className: 'dsm-cValue', style: { width: 84 } }, formatBytes(item.memory)),
          h('span', { className: 'dsm-cSub', style: { width: 64 } }, item.gpu > 0 ? `${item.gpu}%` : '—'),
          h('span', { className: 'dsm-cSub', style: { width: 110 } }, formatDateTime(item.start)),
        )),
      )
    }

    /**
     * Application rows for one resource.
     *
     * `usage` ranks by the tab's resource, which answers "who is using it".
     * `growth` ranks by memory *movement* over the measured window, the only view
     * where a slow leak is visible at all. `disk` ranks by throughput, which is
     * the question neither of the others can answer: who is reading and writing
     * the disk right now.
     */
    function ProcessTable(props) {
      const aggregated = aggregateByApp(props.processes)
      const byLabel = new Map(aggregated.map((row) => [row.label, row]))
      const growing = props.mode === 'growth'
      const rowKey = (row) => row.label
      const toggle = (label) => props.onExpand(props.expanded === label ? null : label)

      if (props.mode === 'disk') {
        const active = aggregated
          .map((row) => ({ ...row, disk: (row.diskRead ?? 0) + (row.diskWrite ?? 0) }))
          .filter((row) => row.disk > 0)
          .sort((left, right) => right.disk - left.disk)
          .slice(0, DETAIL_ROWS)
        // Only applications that actually touched the disk are listed. A table of
        // zeroes would bury the two rows that matter.
        if (active.length === 0) return h('p', { className: 'dsm-empty' }, t('disk_none'))
        const peak = active[0].disk || 1
        return h('div', { className: 'dsm-table' },
          h('div', { className: 'dsm-row dsm-rowHead' },
            h('span', { className: 'dsm-cName' }, t('app')),
            h('span', { className: 'dsm-cCount' }, t('proc_count')),
            h('span', { className: 'dsm-cBar' }),
            h('span', { className: 'dsm-cValue' }, `${t('disk_read')} / ${t('disk_write')}`),
            h('span', { className: 'dsm-cSub' }, t('total')),
          ),
          active.map((row) => {
            const expanded = props.expanded === row.label
            return h('div', { key: rowKey(row) },
              h('div', {
                className: 'dsm-row dsm-rowOpen',
                'data-open': expanded ? 'true' : 'false',
                onClick: () => toggle(row.label),
                title: row.label,
              },
                h('span', { className: 'dsm-cName' },
                  h(AppIcon, { label: row.label, icons: props.appIcons }),
                  h('span', { className: 'dsm-cNameText' }, row.label),
                ),
                h('span', { className: 'dsm-cCount' }, `${row.count} ${t('proc_unit')}`.trim()),
                h('span', { className: 'dsm-cBar' },
                  h(ScaledBar, { value: row.disk, max: peak, color: 'var(--dsw-alias-brand-primary)' }),
                ),
                h('span', { className: 'dsm-cValue' },
                  `${formatRate(row.diskRead ?? 0)} / ${formatRate(row.diskWrite ?? 0)}`),
                h('span', { className: 'dsm-cSub' }, formatRate(row.disk)),
              ),
              expanded ? h(AppProcesses, {
                label: row.label,
                processes: props.processes,
                paths: props.paths,
              }) : null,
            )
          }),
        )
      }

      if (growing) {
        const entries = (props.growth?.rows ?? []).slice(0, DETAIL_ROWS)
        if (entries.length === 0) {
          return h('p', { className: 'dsm-empty' }, t('growth_none'))
        }
        const max = Math.max(...entries.map((entry) => Math.abs(entry.delta)), 1)
        return h('div', { className: 'dsm-table' },
          h('div', { className: 'dsm-row dsm-rowHead' },
            h('span', { className: 'dsm-cName' }, t('app')),
            h('span', { className: 'dsm-cCount' }, t('proc_count')),
            h('span', { className: 'dsm-cBar' }),
            h('span', { className: 'dsm-cValue' }, t('growth_delta')),
            h('span', { className: 'dsm-cSub' }, t('current')),
          ),
          entries.map((entry) => {
            const app = byLabel.get(entry.label)
            const expanded = props.expanded === entry.label
            const color = entry.delta >= 0
              ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-success-primary)'
            return h('div', { key: rowKey(entry) },
              h('div', {
                className: 'dsm-row dsm-rowOpen',
                'data-open': expanded ? 'true' : 'false',
                onClick: () => toggle(entry.label),
                title: entry.label,
              },
                h('span', { className: 'dsm-cName' },
                  h(AppIcon, { label: entry.label, icons: props.appIcons }),
                  h('span', { className: 'dsm-cNameText' }, entry.label),
                  entry.fresh ? h('span', { className: 'dsm-tag' }, t('growth_fresh')) : null,
                ),
                h('span', { className: 'dsm-cCount' }, `${app?.count ?? 0} ${t('proc_unit')}`.trim()),
                h('span', { className: 'dsm-cBar' },
                  h(ScaledBar, { value: Math.abs(entry.delta), max, color }),
                ),
                h('span', { className: 'dsm-cValue', style: { color } }, formatDelta(entry.delta)),
                h('span', { className: 'dsm-cSub' }, formatBytes(entry.current)),
              ),
              expanded ? h(AppProcesses, {
                label: entry.label,
                processes: props.processes,
                paths: props.paths,
              }) : null,
            )
          }),
        )
      }

      const metric = PRIMARY[props.resource]
      let rows = aggregated
      if (props.resource === 'gpu') rows = rows.filter((row) => row.gpu > 0)
      rows = rows.slice().sort((left, right) => right[metric] - left[metric]).slice(0, DETAIL_ROWS)

      if (rows.length === 0) {
        return h('p', { className: 'dsm-empty' }, props.resource === 'gpu' ? t('no_gpu_process') : t('none'))
      }
      const max = rows[0][metric] || 1
      const total = props.memoryTotal

      const primaryText = (row) => {
        if (props.resource === 'memory') return formatBytes(row.memory)
        if (props.resource === 'gpu') return `${row.gpu}%`
        return `${row.cpu}%`
      }
      const secondaryText = (row) => {
        if (props.resource === 'memory') return `${row.cpu}%`
        return formatBytes(row.memory)
      }

      return h('div', { className: 'dsm-table' },
        h('div', { className: 'dsm-row dsm-rowHead' },
          h('span', { className: 'dsm-cName' }, t('app')),
          h('span', { className: 'dsm-cCount' }, t('proc_count')),
          h('span', { className: 'dsm-cBar' }),
          h('span', { className: 'dsm-cValue' }, props.resource === 'memory' ? t('memory') : props.resource === 'gpu' ? t('gpu') : t('cpu')),
          h('span', { className: 'dsm-cSub' }, props.resource === 'memory' ? t('cpu') : t('memory')),
        ),
        rows.map((row) => {
          const expanded = props.expanded === row.label
          return h('div', { key: rowKey(row) },
            h('div', {
              className: 'dsm-row dsm-rowOpen',
              'data-open': expanded ? 'true' : 'false',
              onClick: () => toggle(row.label),
              title: row.label,
            },
              h('span', { className: 'dsm-cName' },
                h(AppIcon, { label: row.label, icons: props.appIcons }),
                h('span', { className: 'dsm-cNameText' }, row.label),
              ),
              h('span', { className: 'dsm-cCount' }, `${row.count} ${t('proc_unit')}`.trim()),
              h('span', { className: 'dsm-cBar' },
                h(ScaledBar, {
                  value: row[metric],
                  max,
                  color: levelColor(props.resource === 'memory' ? (row.memory / total) * 100 : row[metric]),
                }),
              ),
              h('span', { className: 'dsm-cValue' }, primaryText(row)),
              h('span', { className: 'dsm-cSub' }, secondaryText(row)),
            ),
            expanded ? h(AppProcesses, {
              label: row.label,
              processes: props.processes,
              paths: props.paths,
            }) : null,
          )
        }),
      )
    }

    /** One resource's GPU engine types, busiest first. */
    function EngineList(props) {
      const engines = props.engines ?? {}
      const rows = Object.entries(engines)
        .map(([name, value]) => ({ name, value: Number(value) || 0 }))
        .filter((row) => row.value > 0)
        .sort((left, right) => right.value - left.value)
      if (rows.length === 0) return null
      const max = rows[0].value || 1
      return h('div', { className: 'dsm-table' },
        h('p', { className: 'dsm-groupLabel' }, t('engines')),
        rows.map((row) => h('div', { key: row.name, className: 'dsm-row' },
          h('span', { className: 'dsm-cName' }, h('span', { className: 'dsm-cNameText' }, row.name)),
          h('span', { className: 'dsm-cBar' },
            h(ScaledBar, { value: row.value, max, color: levelColor(row.value) }),
          ),
          h('span', { className: 'dsm-cValue' }, `${row.value.toFixed(1)}%`),
          h('span', { className: 'dsm-cSub' }),
        )),
      )
    }

    /** Disk drill-down: throughput history, volumes, then per-disk rates. */
    function DiskDetail(props) {
      const physical = props.physicalDisks ?? []
      return h('div', { className: 'dsm-detailBody' },
        h(IoChart, { points: props.io }),
        h('p', { className: 'dsm-groupLabel' }, t('volumes')),
        h(DiskRows, { disks: props.disks }),
        physical.length > 0 ? h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('physical')) : null,
        physical.length > 0 ? h('div', { className: 'dsm-table' }, physical.map((disk) => {
          const busy = levelColor(Math.min(100, ((disk.read + disk.write) / (200 * 1024 * 1024)) * 100))
          return h('div', { key: disk.name, className: 'dsm-row' },
            h('span', { className: 'dsm-cName' }, disk.name),
            h('span', { className: 'dsm-cSub', style: { width: 130 } }, `${t('read_rate')} ${formatRate(disk.read)}`),
            h('span', { className: 'dsm-cValue' }, `${t('write_rate')} ${formatRate(disk.write)}`),
            h('span', { className: 'dsm-cBar' },
              h(ScaledBar, { value: disk.read + disk.write, max: 200 * 1024 * 1024, color: busy }),
            ),
          )
        })) : null,
      )
    }

    /** Tab label for one drill-down resource. */
    function resourceTabLabel(resource) {
      if (resource === 'disk') return t('disks')
      if (resource === 'cpu') return t('cpu')
      if (resource === 'memory') return t('memory')
      if (resource === 'gpu') return t('gpu')
      return t('status')
    }

    /** The Status tab: pressure, alert history, capabilities and config. */
    function StatusPanel(props) {
      const caps = props.capabilities ?? {}
      const config = props.config ?? {}
      const rows = Object.keys(caps)
      const alertKeys = ['alertCpu', 'alertMemory', 'alertGpu', 'alertDisk', 'alertSustainSeconds']
      const displayKeys = ['showGpu', 'showClock', 'showDiskThroughput', 'showIcons', 'showProcesses']
      const notes = forecastNotes(props.forecast)
      const log = (props.alertLog ?? []).slice().reverse().map((entry, index) => {
        const reasons = (entry.reasons ?? [])
          .map((reason) => {
            const detail = reason.detail ? ` ${reason.detail}` : ''
            if (reason.value === null || reason.value === undefined) return `${alertLabel(reason.key)}${detail}`
            return `${alertLabel(reason.key)}${detail} ${reason.value}%`
          })
          .join(' · ')
        return h('div', { key: index, className: 'dsm-row' },
          h('span', { className: 'dsm-cName' },
            h('span', {
              className: 'dsm-statusDot',
              style: { background: alertColor(entry.level) ?? 'var(--dsw-alias-state-success-primary)' },
            }),
            h('span', { className: 'dsm-cNameText' },
              `${entry.level === 'none' ? t('alert_cleared') : t('alert_raised')}${reasons ? ` · ${reasons}` : ''}`),
          ),
          h('span', { className: 'dsm-cSub', style: { width: 78, flex: 'none' } }, formatClock(entry.t)),
        )
      })
      return h('div', { className: 'dsm-detailBody' },
        h('p', { className: 'dsm-groupLabel' }, t('summary')),
        h('div', { className: 'dsm-table' },
          h('div', { className: 'dsm-row dsm-rowHead' },
            h('span', { className: 'dsm-cName' }, t('summary_uptime').replace('{d}', formatSpan(props.summary?.seconds ?? 0))),
            h('span', { className: 'dsm-cSub', style: { width: 92 } }, t('summary_peak')),
            h('span', { className: 'dsm-cSub', style: { width: 92 } }, t('summary_avg')),
            h('span', { className: 'dsm-cSub', style: { width: 120 } }, t('summary_at')),
          ),
          [['cpu', t('alert_cpu')], ['memory', t('alert_memory')], ['gpu', t('alert_gpu')]].map(([key, label]) => {
            const peak = props.summary?.[key]
            const avg = props.summary?.[`${key}Avg`]
            return h('div', { key, className: 'dsm-row' },
              h('span', { className: 'dsm-cName' },
                h('span', { className: 'dsm-cNameText' }, peak?.label ? `${label} · ${peak.label}` : label)),
              h('span', { className: 'dsm-cValue', style: { width: 92 } }, peak?.value ? `${peak.value}%` : '—'),
              h('span', { className: 'dsm-cSub', style: { width: 92 } }, Number.isFinite(avg) ? `${avg}%` : '—'),
              h('span', { className: 'dsm-cSub', style: { width: 120 } }, peak?.t ? formatDateTime(peak.t) : '—'),
            )
          }),
          props.summary?.latencyMs?.value
            ? h('div', { className: 'dsm-row' },
              h('span', { className: 'dsm-cName' },
                h('span', { className: 'dsm-cNameText' },
                  `${t('disk_latency')}${props.summary.latencyMs.disk ? ` · ${props.summary.latencyMs.disk}` : ''}`)),
              h('span', { className: 'dsm-cValue', style: { width: 92 } }, `${props.summary.latencyMs.value} ms`),
              h('span', { className: 'dsm-cSub', style: { width: 92 } }),
              h('span', { className: 'dsm-cSub', style: { width: 120 } }, formatDateTime(props.summary.latencyMs.t)),
            )
            : null,
        ),
        h('p', { className: 'dsm-footNote' }, t('export_hint')),
        h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('forecast')),
        notes.disk || notes.memory || notes.battery
          ? h('div', { className: 'dsm-table' }, [
            notes.memory ? h('div', { key: 'mem', className: 'dsm-row' },
              h('span', { className: 'dsm-cName' }, h('span', { className: 'dsm-cNameText' }, notes.memory))) : null,
            notes.disk ? h('div', { key: 'disk', className: 'dsm-row' },
              h('span', { className: 'dsm-cName' }, h('span', { className: 'dsm-cNameText' }, notes.disk))) : null,
            notes.battery ? h('div', { key: 'bat', className: 'dsm-row' },
              h('span', { className: 'dsm-cName' }, h('span', { className: 'dsm-cNameText' }, `${t('battery')} ${notes.battery}`))) : null,
          ].filter(Boolean))
          : h('p', { className: 'dsm-empty' }, t('forecast_wait')),
        h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('pressure')),
        h(PressureRow, { pressures: props.bottleneck?.pressures, bottleneck: props.bottleneck?.resource }),
        h('p', { className: 'dsm-footNote' }, t('pressure_hint')),
        h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('alert_log')),
        log.length === 0
          ? h('p', { className: 'dsm-empty' }, t('alert_log_empty'))
          : h('div', { className: 'dsm-table' }, log),
        h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('status_caps')),
        h('div', { className: 'dsm-table' }, rows.map((key) => {
          const entry = caps[key] ?? {}
          const ok = entry.available !== false
          return h('div', { key, className: 'dsm-row', 'data-off': ok ? 'false' : 'true' },
            h('span', { className: 'dsm-cName' },
              h('span', { className: `dsm-statusDot${ok ? '' : ' dsm-statusDotOff'}` }),
              h('span', { className: 'dsm-cNameText' }, capabilityLabel(key)),
            ),
            h('span', { className: 'dsm-cSub', style: { width: 'auto', flex: '1 1 auto', textAlign: 'right' } },
              ok ? t('status_available') : reasonText(entry.reason),
            ),
          )
        })),
        h('p', { className: 'dsm-footNote' }, t('status_hint')),
        h('p', { className: 'dsm-groupLabel', style: { marginTop: 10 } }, t('status_config')),
        h('div', { className: 'dsm-configGrid' },
          alertKeys.map((key) => h('span', { key, className: 'dsm-configItem' },
            h('span', { className: 'dsm-configKey' }, key),
            h('strong', null, String(config[key] ?? '—')),
          )),
          displayKeys.map((key) => h('span', { key, className: 'dsm-configItem' },
            h('span', { className: 'dsm-configKey' }, key),
            h('strong', null, config[key] === true ? 'on' : config[key] === false ? 'off' : '—'),
          )),
        ),
      )
    }

    /** The drill-down card: resource tabs, a sort mode, and its table. */
    function DetailCard(props) {
      const detail = props.data?.detail
      const sampledAt = detail?.sampledAt ?? 0
      const processes = detail?.processes ?? []
      const ready = sampledAt > 0
      const [mode, setMode] = React.useState('usage')
      const [expanded, setExpanded] = React.useState(null)
      const tabs = [...(props.resources ?? RESOURCES), 'status']
      const appTab = props.resource !== 'status' && props.resource !== 'disk'
      const growth = detail?.growth
      const growthWindow = growth?.windowSec ? Math.max(1, Math.round(growth.windowSec / 60)) : 0
      // Per-process disk is throttled to thirty seconds and keyed by process
      // name, so a Host that has just started has nothing to show yet.
      const hasDiskData = processes.some((item) => (item.diskRead ?? 0) > 0 || (item.diskWrite ?? 0) > 0)
      return h('section', { className: 'dsm-card dsm-detail' },
        h('header', { className: 'dsm-cardHead' },
          h('div', { className: 'dsm-tabs' }, tabs.map((resource) =>
            h('button', {
              key: resource,
              type: 'button',
              className: 'dsm-tab',
              'data-active': props.resource === resource ? 'true' : 'false',
              onClick: () => {
                setExpanded(null)
                props.onSelect(resource)
              },
            }, resourceTabLabel(resource)),
          )),
          h('div', { className: 'dsm-detailSide' },
            h('span', { className: 'dsm-cardMeta' }, props.resource === 'status'
              ? ''
              : ready ? `${t('updated')} ${formatClock(sampledAt)}` : t('waiting')),
            h('button', {
              type: 'button',
              className: 'dsm-iconBtn',
              title: t('close'),
              'aria-label': t('close'),
              onClick: props.onClose,
            }, h('svg', {
              width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
              strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false',
            }, h('path', { d: 'M6 6l12 12M18 6L6 18' }))),
          ),
        ),
        props.resource === 'status'
          ? h(StatusPanel, {
            capabilities: props.data?.capabilities,
            config: props.data?.config,
            bottleneck: props.data?.bottleneck,
            alertLog: props.data?.alertLog,
            forecast: props.data?.forecast,
            summary: props.data?.summary,
            windowSec: props.range,
          })
          : h('div', { className: 'dsm-detailBar' },
            h('span', { className: 'dsm-cardMeta', style: { textAlign: 'left' } },
              appTab ? t('expand_hint') : t('detail_hint'),
            ),
            appTab ? h('div', { className: 'dsm-tabs dsm-tabsSmall' },
              h('button', {
                type: 'button',
                className: 'dsm-tab',
                'data-active': mode === 'usage' ? 'true' : 'false',
                onClick: () => { setMode('usage'); setExpanded(null) },
              }, t('sort_usage')),
              h('button', {
                type: 'button',
                className: 'dsm-tab',
                'data-active': mode === 'growth' ? 'true' : 'false',
                title: growthWindow ? t('growth_window').replace('{n}', String(growthWindow)) : t('growth_none'),
                onClick: () => { setMode('growth'); setExpanded(null) },
              }, t('sort_growth')),
              // Disk is only offered when the sampler has actually produced a
              // reading. The counter is throttled to thirty seconds, so on a
              // freshly started Host there is genuinely nothing to rank yet, and
              // an empty tab is worse than no tab.
              hasDiskData ? h('button', {
                type: 'button',
                className: 'dsm-tab',
                'data-active': mode === 'disk' ? 'true' : 'false',
                title: t('sort_disk_hint'),
                onClick: () => { setMode('disk'); setExpanded(null) },
              }, t('sort_disk')) : null,
            ) : null,
          ),
        props.resource === 'status'
          ? null
          : props.resource === 'disk'
            ? h(DiskDetail, { disks: props.data?.disks, physicalDisks: detail?.physicalDisks, io: props.data?.io })
            : ready
              ? h('div', { className: 'dsm-detailBody' },
                mode === 'usage' && props.resource === 'memory'
                  ? h(CompositionBar, {
                    processes,
                    appIcons: detail?.appIcons,
                    total: props.data?.memory?.total ?? 0,
                  })
                  : null,
                mode === 'usage' && props.resource === 'gpu'
                  ? h(EngineList, { engines: props.data?.gpu?.engines })
                  : null,
                h(ProcessTable, {
                  resource: props.resource,
                  mode,
                  processes,
                  appIcons: detail?.appIcons,
                  paths: detail?.appPaths,
                  growth,
                  expanded,
                  onExpand: setExpanded,
                  memoryTotal: props.data?.memory?.total ?? 0,
                }),
              )
              : h('p', { className: 'dsm-empty' }, t('none')),
      )
    }

    /** Poll the Host snapshot for as long as the page is mounted. */
    function useMetrics(wantDetail, windowSec) {
      const [state, setState] = React.useState({ data: null, error: null })
      React.useEffect(() => {
        let alive = true
        let timer = null
        const url = metricsUrl(wantDetail, windowSec)
        const pull = async () => {
          try {
            const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (alive) setState({ data: json, error: null })
          } catch (error) {
            if (alive) setState((previous) => ({ data: previous.data, error: error?.message ?? String(error) }))
          }
          if (alive) timer = setTimeout(pull, POLL_MS)
        }
        void pull()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [wantDetail, windowSec])
      return state
    }

    /** The sidebar icon: a gauge glyph plus a sustained-load badge. */
    function PanelIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 16
      const alerts = useAlerts()
      const color = alertColor(alerts.level)
      const summary = alertSummary(alerts)
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      },
        color !== null ? h('title', null, `${t('alert_title')}: ${summary}`) : null,
        h('path', { d: 'M3.6 18.4a8.4 8.4 0 1 1 16.8 0' }),
        h('path', { d: 'M12 18.4l4.6-5.6' }),
        h('circle', { cx: 12, cy: 18.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        color !== null
          ? h('circle', {
            cx: 20, cy: 4, r: 3.2, fill: color,
            stroke: 'var(--dsw-specific-sidebar-fill, transparent)', strokeWidth: 2,
          })
          : null,
      )
    }

    /** The monitoring page behind the sidebar entry. */
    function Panel() {
      const [detailResource, setDetailResource] = React.useState(null)
      const [range, setRange] = React.useState(WINDOW_OPTIONS[0])
      const [density, setDensity] = React.useState(readDensity)
      const [exportOpen, setExportOpen] = React.useState(false)
      const [customOpen, setCustomOpen] = React.useState(false)
      const [customMinutes, setCustomMinutes] = React.useState('')
      const [exportBusy, setExportBusy] = React.useState(false)
      const [saveToast, setSaveToast] = React.useState(null)
      const metrics = DENSITY[density] ?? DENSITY.comfortable
      const { data, error } = useMetrics(detailResource !== null, range)
      const now = Date.now()
      const ts = data?.ts ?? 0
      const age = ts > 0 ? now - ts : Number.POSITIVE_INFINITY
      const liveState = error !== null && data === null ? 'down' : age > 3500 ? 'stale' : 'live'

      /** Apply the typed range, clamped to what the Host actually keeps. */
      const applyCustom = () => {
        const minutes = Number(customMinutes)
        setCustomOpen(false)
        if (!Number.isFinite(minutes) || minutes <= 0) return
        setRange(Math.min(MAX_WINDOW, Math.max(60, Math.round(minutes * 60))))
      }

      // Each toast clears itself; keyed on the toast so a second save restarts
      // the clock rather than inheriting the first one's.
      React.useEffect(() => {
        if (saveToast === null) return undefined
        const timer = setTimeout(() => setSaveToast(null), SAVE_TOAST_MS)
        return () => clearTimeout(timer)
      }, [saveToast])

      const openDetail = React.useCallback((resource) => {
        setDetailResource((current) => (current === resource ? null : resource))
      }, [])

      // Everything above the `data === null` guard must tolerate the first render,
      // which happens before the first poll returns.
      const notes = forecastNotes(data?.forecast)
      const batteryLine = notes.battery
        ? h('div', null, `${t('battery')} ${notes.battery}`)
        : null

      // A Host older than this Client says so, at the top, in one line.
      //
      // Without this the mismatch shows up as whatever it happens to break —
      // a panel that vanishes, an export that blanks the window, data that is
      // quietly empty — and none of those symptoms points at the version.
      // A Host that does not report a protocol at all predates the handshake, so
      // it is treated as protocol 0 rather than as compatible. Reading a missing
      // field as "fine" would make the warning silent in exactly the case it was
      // written for.
      const hostProtocol = Number(data?.protocol)
      const effectiveProtocol = Number.isFinite(hostProtocol) ? hostProtocol : 0
      const staleHost = data !== null && effectiveProtocol < REQUIRED_PROTOCOL
      const staleBanner = staleHost
        ? h('div', { className: 'dsm-stale', role: 'alert' },
          h('span', { className: 'dsm-staleText' },
            t('stale_host').replace('{host}', String(effectiveProtocol)).replace('{want}', String(REQUIRED_PROTOCOL))),
        )
        : null

      const head = h('header', { className: 'dsm-head' },
        h('div', { className: 'dsm-headMain' },
          h('div', { className: 'dsm-titleRow' },
            h('span', { className: 'dsm-titleGlyph' }, h(ResourceGlyph, { kind: 'chart', size: 20 })),
            h('h1', { className: 'dsm-title' }, t('panel')),
            h('span', { className: 'dsm-live' },
              h('i', { className: 'dsm-liveDot', 'data-state': liveState }),
              liveState === 'live' ? t('live') : liveState === 'stale' ? t('stale') : t('unreachable'),
            ),
          ),
          h('p', { className: 'dsm-sub' }, data === null
            ? t('subtitle')
            : [
              data.host.hostname,
              data.host.os,
              `${t('uptime')} ${formatUptime(data.host.uptimeSec)}`,
            ].join(' · ')),
        ),
        h('div', { className: 'dsm-headSide' },
          h('div', { className: 'dsm-tabs dsm-tabsSmall', role: 'group', 'aria-label': t('window') },
            WINDOW_OPTIONS.map((option) => h('button', {
              key: option,
              type: 'button',
              className: 'dsm-tab',
              'data-active': range === option ? 'true' : 'false',
              onClick: () => {
                setCustomOpen(false)
                setRange(option)
              },
            }, option === 60 ? t('window_1m') : option === 300 ? t('window_5m') : t('window_30m'))),
            // A custom range, honoured as asked up to the retention limit. The
            // limit is shown rather than silently applied: a control that quietly
            // gives you less than you asked for is worse than one that says no.
            h('button', {
              type: 'button',
              className: 'dsm-tab',
              'data-active': !WINDOW_OPTIONS.includes(range) || customOpen ? 'true' : 'false',
              title: t('window_custom_hint').replace('{n}', String(Math.round(MAX_WINDOW / 60))),
              onClick: () => setCustomOpen((open) => !open),
            }, WINDOW_OPTIONS.includes(range) ? t('window_custom') : formatSpan(range)),
            customOpen
              ? h('span', { className: 'dsm-customRange' },
                h('input', {
                  type: 'number',
                  className: 'dsm-customInput',
                  min: 1,
                  max: Math.round(MAX_WINDOW / 60),
                  step: 1,
                  value: customMinutes,
                  'aria-label': t('window_custom'),
                  placeholder: t('window_minutes'),
                  onChange: (event) => setCustomMinutes(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') applyCustom()
                    if (event.key === 'Escape') setCustomOpen(false)
                  },
                }),
                h('button', { type: 'button', className: 'dsm-customApply', onClick: applyCustom }, t('window_apply')),
                h('span', { className: 'dsm-customMax' },
                  `${t('window_minutes')} · ≤ ${Math.round(MAX_WINDOW / 60)}`),
              )
              : null,
          ),
          h('div', { className: 'dsm-tabs dsm-tabsSmall', role: 'group', 'aria-label': t('density') },
            ['comfortable', 'compact'].map((option) => h('button', {
              key: option,
              type: 'button',
              className: 'dsm-tab',
              'data-active': density === option ? 'true' : 'false',
              onClick: () => {
                setDensity(option)
                writeDensity(option)
              },
            }, option === 'compact' ? t('density_compact') : t('density_comfortable'))),
          ),
          batteryLine,
          h('div', null, t('sample_rate')),
          h('div', null, `${t('last_update')} ${formatClock(ts)}`),
          // Export lives here rather than three clicks deep in the Status tab.
          // A feature nobody finds is a feature nobody has.
          h('div', { className: 'dsm-exportMenu' },
            h('button', {
              type: 'button',
              className: 'dsm-exportTrigger',
              'data-open': exportOpen ? 'true' : 'false',
              'aria-expanded': exportOpen ? 'true' : 'false',
              onClick: () => setExportOpen((open) => !open),
            },
              h(ResourceGlyph, { kind: 'download', size: 13 }),
              h('span', null, t('export')),
            ),
            exportOpen
              ? h('div', { className: 'dsm-exportPop', role: 'menu' },
                h('span', { className: 'dsm-exportPopHint' }, t('export_hint')),
                // One menu item per format. The scope is the series the panel is
                // currently showing, which is what "the data on screen" means.
                h('div', { className: 'dsm-exportPopLinks' },
                  ['csv', 'json', 'ndjson'].map((format) => h('button', {
                    key: format,
                    type: 'button',
                    className: 'dsm-exportLink',
                    disabled: exportBusy,
                    onClick: async () => {
                      setExportOpen(false)
                      setExportBusy(true)
                      const result = await saveExport(format, range)
                      setExportBusy(false)
                      // Cancel is not an outcome worth announcing.
                      if (result.cancelled) return
                      if (result.ok) {
                        setSaveToast({
                          tone: 'ok',
                          // A path when the Host wrote the file; only a name when
                          // the browser's own dialog did, because it never
                          // discloses the folder.
                          text: result.path
                            ? `${t('export_saved')}：${result.path}`
                            : `${t('export_saved')}：${result.name}`,
                        })
                        return
                      }
                      setSaveToast({ tone: 'error', text: t(`export_note_${result.reason}`) })
                    },
                  }, t(`export_${format}`))),
                ),
              )
              : null,
          ),
        ),
      )

      const verdict = healthSentence(data?.health, data?.bottleneck)
      const healthStrip = h('div', { className: 'dsm-health', 'data-level': verdict.level },
        h('i', { className: 'dsm-healthDot', 'data-level': verdict.level }),
        h('span', { className: 'dsm-healthText' }, verdict.text),
        h('button', {
          type: 'button',
          className: 'dsm-healthLink',
          onClick: () => setDetailResource('status'),
        }, t('status')),
      )

      if (data === null) {
        return h('div', { className: 'dsm-page', 'data-density': density },
          h('style', null, CSS),
          staleBanner,
          head,
          error !== null ? h('p', { className: 'dsm-notice' }, `${t('unreachable')} (${error})`) : null,
          h('section', { className: 'dsm-card' }, h('p', { className: 'dsm-empty' }, t('loading'))),
        )
      }

      const cpu = data.cpu ?? {}
      const memory = data.memory ?? {}
      const gpu = data.gpu ?? {}
      // A Host module from an older generation can answer with a payload missing
      // fields this bundle expects. Default them rather than white-screening.
      const cpuHistory = Array.isArray(cpu.history) ? cpu.history : []
      const memoryHistory = Array.isArray(memory.history) ? memory.history : []
      const gpuHistory = Array.isArray(gpu.history) ? gpu.history : []
      const cpuUsage = Number(cpu.usage) || 0
      const memoryUsage = Number(memory.usage) || 0
      const gpuLive = gpu.status === 'live' && Number.isFinite(gpu.util)
      const caps = data.capabilities ?? {}
      /**
       * Whether to render a panel for a capability.
       *
       * "This machine cannot" and "this broke" are different answers and must not
       * look the same. A capability the machine genuinely lacks is hidden, since
       * an empty shell is noise. One that is missing because something failed is
       * *shown*, carrying its reason — otherwise the panel simply vanishes and
       * the reader cannot tell a missing feature from a broken one. That is
       * exactly how a failed PowerShell spawn presented itself: the GPU panel
       * disappeared with no explanation at all.
       */
      const available = (key) => {
        const capability = caps[key]
        if (capability === undefined || capability.available !== false) return true
        return TRANSIENT_REASONS.has(capability.reason?.code)
      }
      const resources = RESOURCES.filter((resource) => available(resource === 'disk' ? 'diskCapacity' : resource))
      const gpuMeta = gpu.status === 'live' ? t('gpu_live')
        : gpu.status === 'starting' ? t('gpu_starting')
          : gpu.status === 'idle' ? t('gpu_idle')
            : gpu.status === 'degraded' ? t('gpu_degraded')
              : reasonText(gpu.reason) || t('gpu_unavailable')

      const clock = data.clock ?? {}
      const throttleChip = clock.throttled
        ? h('span', { className: 'dsm-chip', 'data-tone': 'warn', title: t('throttle') }, t('throttle'))
        : null
      const cpuLines = [
        cpu.model,
        Number.isFinite(cpu.actualMhz)
          ? `${cpu.cores} ${t('core_short')} · ${t('freq_now')} ${(cpu.actualMhz / 1000).toFixed(2)} GHz`
          : `${cpu.cores} ${t('core_short')}${cpu.nominalMhz > 0 ? ` · ${(cpu.nominalMhz / 1000).toFixed(2)} GHz` : ''}`,
        Number.isFinite(clock.peakMhz)
          ? `${t('nominal')} ${(cpu.nominalMhz / 1000).toFixed(2)} GHz · ${t('peak_clock')} ${(clock.peakMhz / 1000).toFixed(2)} GHz`
          : `${t('history')} · max ${cpuHistory.length > 0 ? Math.max(...cpuHistory).toFixed(0) : '0'}%`,
      ]
      const memoryLines = [
        `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`,
        Number.isFinite(memory.cached)
          ? `${t('free')} ${formatBytes(memory.free)} · ${t('cached')} ${formatBytes(memory.cached)}`
          : `${t('free')} ${formatBytes(memory.free)}`,
        Number.isFinite(memory.committed) && Number.isFinite(memory.commitLimit)
          ? `${t('committed')} ${formatBytes(memory.committed)} / ${formatBytes(memory.commitLimit)}`
          : `${t('history')} · max ${memoryHistory.length > 0 ? Math.max(...memoryHistory).toFixed(0) : '0'}%`,
      ]
      const primaryAdapter = (gpu.adapters ?? []).slice().sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0]
      const gpuLines = [
        primaryAdapter?.name ?? t('gpu'),
        Number.isFinite(gpu.dedicated) ? `${t('vram')} ${formatBytes(gpu.dedicated)}` : gpuMeta,
        Number.isFinite(gpu.shared) ? `${t('shared')} ${formatBytes(gpu.shared)}` : (gpu.reason ?? gpuMeta),
      ]

      const saveToastNode = saveToast === null ? null : h('div', { className: 'dsm-saveToast', 'data-tone': saveToast.tone, role: 'status' },
        h('span', { className: 'dsm-saveToastText', title: saveToast.text }, saveToast.text),
        h('button', {
          type: 'button',
          className: 'dsm-saveToastClose',
          'aria-label': t('close'),
          onClick: () => setSaveToast(null),
        }, '✕'),
      )

      return h('div', { className: 'dsm-page', 'data-density': density },
        h('style', null, CSS),
        saveToastNode,
        staleBanner,
        head,
        error !== null ? h('p', { className: 'dsm-notice' }, `${t('unreachable')} (${error})`) : null,
        healthStrip,
        h('div', { className: 'dsm-gauges' },
          h(GaugeCard, {
            kind: 'cpu',
            title: t('cpu'), meta: `${cpuUsage}%`, value: cpuUsage,
            color: levelColor(cpuUsage), display: cpuUsage.toFixed(0), history: cpuHistory, lines: cpuLines,
            chip: throttleChip,
            ringSize: metrics.ring, ringStroke: metrics.ringStroke, sparkHeight: metrics.spark,
            trend: trendOf(cpuHistory),
            active: detailResource === 'cpu', onOpen: () => openDetail('cpu'),
          }),
          h(GaugeCard, {
            kind: 'memory',
            title: t('memory'), meta: `${memoryUsage}%`, value: memoryUsage,
            color: levelColor(memoryUsage), display: memoryUsage.toFixed(0), history: memoryHistory, lines: memoryLines,
            note: notes.memory,
            ringSize: metrics.ring, ringStroke: metrics.ringStroke, sparkHeight: metrics.spark,
            trend: trendOf(memoryHistory),
            active: detailResource === 'memory', onOpen: () => openDetail('memory'),
          }),
          available('gpu') ? h(GaugeCard, {
            kind: 'gpu',
            title: t('gpu'), meta: gpuMeta, value: gpuLive ? gpu.util : 0,
            color: gpuLive ? levelColor(gpu.util) : 'var(--dsw-alias-border-l2)',
            display: gpuLive ? gpu.util.toFixed(0) : '—',
            history: gpuLive ? gpuHistory : [], lines: gpuLines,
            ringSize: metrics.ring, ringStroke: metrics.ringStroke, sparkHeight: metrics.spark,
            trend: gpuLive ? trendOf(gpuHistory) : 0,
            active: detailResource === 'gpu', onOpen: () => openDetail('gpu'),
          }) : null,
        ),
        h(TrendChart, {
          series: data.series,
          showGpu: available('gpu'),
          alertLog: data.alertLog,
          windowSec: data.windowSec,
          height: metrics.chart,
        }),
        detailResource !== null
          ? h(DetailCard, {
            data,
            resource: detailResource,
            resources,
            range,
            onSelect: setDetailResource,
            onClose: () => setDetailResource(null),
          })
          : null,
        h('div', { className: 'dsm-panels' },
          h(CoreGrid, {
            perCore: Array.isArray(cpu.perCore) ? cpu.perCore : [],
            timeline: cpu.timeline,
            trackHeight: metrics.coreTrack,
          }),
          available('diskCapacity')
            ? h(DiskList, { disks: data.disks, storage: data.storage, note: notes.disk })
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'system-monitor: dictionaries')
        t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))

        // Opening the panel is resolved lazily rather than during apply.
        // Touching a service that is not in this plugin's `inject` list can throw
        // at activation time, and a throw here disposes the whole plugin scope —
        // which would remove the sidebar icon and the panel along with it. The
        // toast is an enhancement; it must never be able to cost the panel.
        openPanel = () => {
          try {
            ctx.layout?.selectPanel?.(PANEL_ID)
          } catch {
            // The panel simply does not open; everything else still works.
          }
        }

        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: PANEL_ID,
            // After the shipped overlay entries, so an alert never covers them.
            order: 60,
            locale: NS,
          }, AlertToaster))
        } catch {
          // No alert toasts on this build; the badge and the log still work.
        }
      },
    }
  },
})
