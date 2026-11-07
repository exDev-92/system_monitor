import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import type { Metrics } from '../src/types'
import { TH } from '../src/designs/tokens'
import { getConfig, LogConfig } from './config'

/**
 * Журнал показаний. Две части в одном формате CSV:
 *   short/ — каждый опрос, кольцо файлов на log.shortMinutes минут;
 *   long/  — минимум, среднее и максимум за log.longStepSec, хранится долго.
 * Плюс events.log (что случалось) и incidents/ (записи вокруг сбоя).
 *
 * Строка уходит в кэш ОС сразу: падение приложения её не потеряет. На диск кэш
 * сбрасывается раз в log.flushSec — это граница потерь при отключении питания.
 * Любая ошибка диска остаётся внутри журнала: мониторинг из-за неё падать не должен.
 */

type Value = number | null | undefined

interface Column {
  name: string
  get: (m: Metrics) => Value
}

const HOUR_MS = 3_600_000
const MAINTENANCE_MS = 600_000
const INCIDENT_WINDOW_MS = 900_000
const EVENTS_MAX_BYTES = 1_048_576
const RETRY_AFTER_MS = 60_000

let dir = ''
let started = false
let maintenanceTimer: NodeJS.Timeout | null = null
let maintenanceBusy = false

const pad = (n: number) => String(n).padStart(2, '0')

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Местное время без «T»: так значение распознают и Excel, и pandas. */
function stamp(d: Date): string {
  return `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fileStamp(d: Date): string {
  return `${dateStr(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function formatNumber(v: Value, comma: boolean): string {
  if (v == null || !Number.isFinite(v)) return ''
  const text = String(Math.round(v * 100) / 100)
  return comma ? text.replace('.', ',') : text
}

// ── Колонки ────────────────────────────────────────────────────

/** Ноль у этих датчиков значит «нет данных»: так их отдаёт бэкенд. */
const orNull = (v: Value) => v || null

function buildColumns(m: Metrics, set: LogConfig['columns']): Column[] {
  const cols: Column[] = [
    { name: 'cpu_load', get: x => x.cpu.utilization },
    { name: 'cpu_temp', get: x => x.cpu.temp_c },
    { name: 'cpu_max', get: x => x.cpu.max_core_temp_c },
    { name: 'cpu_ghz', get: x => orNull(x.cpu.clock_ghz) },
    { name: 'cpu_w', get: x => orNull(x.cpu.power_w) },
    { name: 'gpu_load', get: x => x.gpu.utilization },
    { name: 'gpu_temp', get: x => orNull(x.gpu.temp_c) },
    { name: 'gpu_hot', get: x => x.gpu.hotspot_c },
    { name: 'gpu_w', get: x => orNull(x.gpu.power_w) },
    { name: 'gpu_mhz', get: x => orNull(x.gpu.clock_mhz) },
    { name: 'gpu_fan', get: x => x.gpu.fan_pct },
    { name: 'vram_gb', get: x => x.gpu.vram_used_gb },
    { name: 'ram_gb', get: x => x.ram.used_gb },
    { name: 'ram_pct', get: x => x.ram.utilization_pct },
    { name: 'swap_gb', get: x => x.ram.swap_used_gb },
    { name: 'net_down_kbs', get: x => (x.network.download_bytes_ps ?? 0) / 1024 },
    { name: 'net_up_kbs', get: x => (x.network.upload_bytes_ps ?? 0) / 1024 },
    { name: 'ping_ms', get: x => orNull(x.network.latency_ms) },
  ]

  m.disks.forEach((d, i) => {
    const id = /([A-Za-z]):/.exec(d.label)?.[1]?.toUpperCase() ?? String(i)
    const disk = (x: Metrics) => x.disks.find(o => o.label === d.label)
    cols.push(
      { name: `disk_${id}_read_mbs`, get: x => disk(x)?.read_speed_mbps },
      { name: `disk_${id}_write_mbs`, get: x => disk(x)?.write_speed_mbps },
      { name: `disk_${id}_temp`, get: x => disk(x)?.temp_c },
      { name: `disk_${id}_free_gb`, get: x => disk(x)?.free_gb },
    )
  })

  if (set !== 'basic') {
    m.cpu.per_core.forEach((_, i) => {
      cols.push({ name: `cpu_t${i}`, get: x => x.cpu.per_core[i] })
    })
  }

  if (set === 'full') {
    (m.fans_list ?? []).forEach((f, i) => {
      cols.push({ name: `fan${i}_rpm`, get: x => x.fans_list?.find(o => o.name === f.name)?.rpm })
    })
    m.disks.forEach((d, i) => {
      const id = /([A-Za-z]):/.exec(d.label)?.[1]?.toUpperCase() ?? String(i)
      cols.push({ name: `disk_${id}_life`, get: x => x.disks.find(o => o.label === d.label)?.life_pct })
    })
  }

  return cols
}

// ── Запись в файл ──────────────────────────────────────────────

class Writer {
  readonly openedAt = Date.now()
  private fd: number | null
  private syncing = false
  private dirty = false

  constructor(readonly file: string, readonly signature: string, header: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.fd = fs.openSync(file, 'a')
    this.line(header)
  }

  line(text: string) {
    if (this.fd == null) return
    fs.writeSync(this.fd, `${text}\n`)
    this.dirty = true
  }

  /** Сброс в фоновом потоке: главный процесс не ждёт диск. */
  sync() {
    if (this.fd == null || !this.dirty || this.syncing) return
    this.dirty = false
    this.syncing = true
    fs.fdatasync(this.fd, () => { this.syncing = false })
  }

  close() {
    if (this.fd == null) return
    const fd = this.fd
    this.fd = null
    try {
      fs.fdatasyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
}

// ── События ────────────────────────────────────────────────────

export function logEvent(kind: string, text: string) {
  if (!started) return
  const file = path.join(dir, 'events.log')
  try {
    // События редки, и случаются чаще всего перед бедой: пишем сразу на диск.
    if (fs.existsSync(file) && fs.statSync(file).size > EVENTS_MAX_BYTES) {
      fs.renameSync(file, path.join(dir, 'events.1.log'))
    }
    const fd = fs.openSync(file, 'a')
    fs.writeSync(fd, `${stamp(new Date())}  ${kind.padEnd(10)} ${text}\n`)
    fs.fdatasyncSync(fd)
    fs.closeSync(fd)
  } catch (err) {
    console.error('[journal] события:', err)
  }
}

// ── Пороги ─────────────────────────────────────────────────────

const WATCHED: Array<{ name: string; th: readonly [number, number]; get: (m: Metrics) => Value }> = [
  { name: 'cpu_temp', th: TH.cpuTemp, get: m => m.cpu.temp_c },
  { name: 'gpu_temp', th: TH.gpuTemp, get: m => orNull(m.gpu.temp_c) },
  { name: 'gpu_hot', th: TH.gpuHotspot, get: m => m.gpu.hotspot_c },
]
const hotNow = new Set<string>()

const diskAsleep = new Map<string, boolean>()

/** Видно, когда жёсткий диск засыпал и что его будило. */
function checkDisks(m: Metrics) {
  for (const d of m.disks) {
    if (d.kind !== 'hdd') continue
    const asleep = Boolean(d.asleep)
    const before = diskAsleep.get(d.label)
    diskAsleep.set(d.label, asleep)
    if (before === undefined || before === asleep) continue
    logEvent('disk', `${d.label.slice(0, 2)} ${asleep ? 'остановился' : 'раскрутился'}`)
  }
}

/** Вход — выше порога «жарко», выход — ниже «тепло»: иначе колебание у порога заспамит журнал. */
function checkThresholds(m: Metrics) {
  for (const w of WATCHED) {
    const v = w.get(m)
    if (v == null) continue
    if (!hotNow.has(w.name) && v >= w.th[1]) {
      hotNow.add(w.name)
      logEvent('threshold', `${w.name} ${Math.round(v)}° — жарко`)
    } else if (hotNow.has(w.name) && v < w.th[0]) {
      hotNow.delete(w.name)
      logEvent('threshold', `${w.name} ${Math.round(v)}° — снова норма`)
    }
  }
}

// ── Короткий и долгий журнал ───────────────────────────────────

let columns: Column[] = []
let columnShape = ''
let signature = ''
let shortWriter: Writer | null = null
let longWriter: Writer | null = null
let lastSyncAt = 0
let retryAt = 0
let firstPacket = true

interface Bucket {
  id: number
  step: number
  count: number
  min: Array<number | null>
  max: Array<number | null>
  sum: number[]
  seen: number[]
}
let bucket: Bucket | null = null

/** Длина файла кольца: шестая часть глубины, чтобы кольцо укорачивалось плавно. */
function segmentMs(log: LogConfig): number {
  return Math.max(1, Math.min(60, Math.round(log.shortMinutes / 6))) * 60_000
}

function closeWriter(w: Writer | null) {
  try {
    w?.close()
  } catch (err) {
    console.error('[journal] закрытие:', err)
  }
}

function flushBucket(log: LogConfig) {
  const b = bucket
  bucket = null
  if (!b || !b.count || !longWriter) return
  const cells = columns.flatMap((_, i) => {
    const avg = b.seen[i] ? b.sum[i] / b.seen[i] : null
    return [b.min[i], avg, b.max[i]].map(v => formatNumber(v, log.decimalComma))
  })
  longWriter.line([stamp(new Date(b.id * b.step * 1000)), b.count, ...cells].join(';'))
}

function addToBucket(m: Metrics, log: LogConfig, now: number) {
  const id = Math.floor(now / 1000 / log.longStepSec)
  if (bucket && (bucket.id !== id || bucket.step !== log.longStepSec)) flushBucket(log)
  if (!bucket) {
    const n = columns.length
    bucket = {
      id,
      step: log.longStepSec,
      count: 0,
      min: Array(n).fill(null),
      max: Array(n).fill(null),
      sum: Array(n).fill(0),
      seen: Array(n).fill(0),
    }
  }
  const b = bucket
  b.count += 1
  columns.forEach((c, i) => {
    const v = c.get(m)
    if (v == null || !Number.isFinite(v)) return
    b.min[i] = b.min[i] == null ? v : Math.min(b.min[i]!, v)
    b.max[i] = b.max[i] == null ? v : Math.max(b.max[i]!, v)
    b.sum[i] += v
    b.seen[i] += 1
  })
}

function writeRows(m: Metrics, log: LogConfig, now: number) {
  // Появился диск или сменился состав данных: у файла с другими колонками своё начало.
  const shape = [
    log.columns,
    m.cpu.per_core.length,
    m.disks.map(d => d.label).join(),
    (m.fans_list ?? []).map(f => f.name).join(),
  ].join('|')
  if (shape !== columnShape) {
    flushBucket(log)
    columns = buildColumns(m, log.columns)
    signature = columns.map(c => c.name).join(';')
    columnShape = shape
  }

  const date = new Date(now)
  if (!log.short) {
    closeWriter(shortWriter)
    shortWriter = null
  } else {
    if (shortWriter && (shortWriter.signature !== signature || now - shortWriter.openedAt >= segmentMs(log))) {
      closeWriter(shortWriter)
      shortWriter = null
    }
    shortWriter ??= new Writer(
      path.join(dir, 'short', `short_${fileStamp(date)}.csv`), signature, `time;${signature}`,
    )
    const cells = columns.map(c => formatNumber(c.get(m), log.decimalComma))
    shortWriter.line([stamp(date), ...cells].join(';'))
  }

  if (!log.long) {
    bucket = null
    closeWriter(longWriter)
    longWriter = null
  } else {
    const sameDay = longWriter && path.basename(longWriter.file).startsWith(`long_${dateStr(date)}`)
    if (longWriter && (longWriter.signature !== signature || !sameDay)) {
      flushBucket(log)
      closeWriter(longWriter)
      longWriter = null
    }
    if (!longWriter) {
      const header = columns.flatMap(c => [`${c.name}_min`, `${c.name}_avg`, `${c.name}_max`]).join(';')
      longWriter = new Writer(
        path.join(dir, 'long', `long_${fileStamp(date)}.csv`), signature, `time;samples;${header}`,
      )
    }
    addToBucket(m, log, now)
  }

  if (now - lastSyncAt >= log.flushSec * 1000) {
    lastSyncAt = now
    shortWriter?.sync()
    longWriter?.sync()
  }
}

/** Вызывается на каждый пакет метрик. */
export function writeMetrics(m: Metrics) {
  if (!started) return
  const now = Date.now()
  try {
    if (firstPacket) {
      firstPacket = false
      logEvent('sensors', `elevated=${Boolean(m.system.elevated)} sensors=${m.system.sensor_count ?? 0}`)
    }
    checkThresholds(m)
    checkDisks(m)
    if (now < retryAt) return
    writeRows(m, getConfig().log, now)
  } catch (err) {
    // Диск полон или папка недоступна: пробуем снова позже, новым файлом.
    console.error('[journal] запись:', err)
    logEvent('error', `запись не удалась: ${String(err)}`)
    retryAt = now + RETRY_AFTER_MS
    closeWriter(shortWriter)
    closeWriter(longWriter)
    shortWriter = null
    longWriter = null
    bucket = null
  }
}

/** Перед сном: всё накопленное должно быть на диске, питание могут и не вернуть. */
export function syncJournal() {
  shortWriter?.sync()
  longWriter?.sync()
}

// ── Обслуживание: очистка и сжатие ─────────────────────────────

interface Entry { file: string; size: number; mtime: number }

async function listFiles(sub: string): Promise<Entry[]> {
  const root = path.join(dir, sub)
  let names: string[]
  try {
    names = await fs.promises.readdir(root)
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const name of names) {
    try {
      const st = await fs.promises.stat(path.join(root, name))
      if (st.isFile()) out.push({ file: path.join(root, name), size: st.size, mtime: st.mtimeMs })
    } catch { /* файл только что удалён */ }
  }
  return out
}

async function compress(file: string) {
  const tmp = `${file}.gz.tmp`
  await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(tmp))
  await fs.promises.rename(tmp, `${file}.gz`)
  await fs.promises.rm(file)
}

async function maintenance() {
  if (maintenanceBusy) return
  maintenanceBusy = true
  try {
    const log = getConfig().log
    const now = Date.now()
    const active = new Set([shortWriter?.file, longWriter?.file])

    for (const e of await listFiles('short')) {
      if (!active.has(e.file) && now - e.mtime > log.shortMinutes * 60_000 + segmentMs(log)) {
        await fs.promises.rm(e.file, { force: true })
      }
    }

    for (const e of await listFiles('long')) {
      if (active.has(e.file)) continue
      if (e.file.endsWith('.tmp')) {
        await fs.promises.rm(e.file, { force: true }) // след прерванного сжатия
      } else if (now - e.mtime > log.keepDays * 24 * HOUR_MS) {
        await fs.promises.rm(e.file, { force: true })
      } else if (e.file.endsWith('.csv') && now - e.mtime > 24 * HOUR_MS) {
        await compress(e.file)
      }
    }

    // Потолок папки: самое старое уходит первым. Записи сбоев не считаются и не удаляются.
    const all = [...await listFiles('short'), ...await listFiles('long')]
      .filter(e => !active.has(e.file))
      .sort((a, b) => a.mtime - b.mtime)
    let total = all.reduce((sum, e) => sum + e.size, 0)
    const limit = log.maxTotalMB * 1024 * 1024
    for (const e of all) {
      if (total <= limit) break
      await fs.promises.rm(e.file, { force: true })
      total -= e.size
    }
  } catch (err) {
    console.error('[journal] обслуживание:', err)
  } finally {
    maintenanceBusy = false
  }
}

/** Размер папки журнала в байтах — для окна настроек. */
export async function journalSize(): Promise<number> {
  let total = 0
  for (const sub of ['short', 'long']) {
    for (const e of await listFiles(sub)) total += e.size
  }
  return total
}

// ── Сессии и сбои ──────────────────────────────────────────────

interface Session { id: number; startedAt: string; clean: boolean }

function sessionFile() {
  return path.join(dir, 'session.json')
}

function writeSession(s: Session) {
  const tmp = `${sessionFile()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s), 'utf-8')
  fs.renameSync(tmp, sessionFile())
}

function readSession(): Session | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), 'utf-8')) as Session
  } catch {
    return null
  }
}

/** Кольцо затрёт записи вокруг сбоя — копия в incidents/ в автоочистку не попадает. */
function saveIncident(prev: Session, log: LogConfig) {
  const shortDir = path.join(dir, 'short')
  const files = fs.existsSync(shortDir)
    ? fs.readdirSync(shortDir).map(name => {
      const file = path.join(shortDir, name)
      return { name, file, mtime: fs.statSync(file).mtimeMs }
    })
    : []
  const newest = Math.max(0, ...files.map(f => f.mtime))

  const root = path.join(dir, 'incidents')
  const target = path.join(root, fileStamp(new Date(newest || Date.now())))
  fs.mkdirSync(target, { recursive: true })
  for (const f of files) {
    if (newest - f.mtime <= INCIDENT_WINDOW_MS) fs.copyFileSync(f.file, path.join(target, f.name))
  }
  fs.writeFileSync(path.join(target, 'info.txt'), [
    `Сессия ${prev.id}, начата ${prev.startedAt}.`,
    `Последняя запись: ${newest ? stamp(new Date(newest)) : 'нет'}.`,
    'Приложение завершилось без отметки о выходе: сбой системы, пропало питание',
    'или процесс был снят принудительно.',
    '',
  ].join('\n'), 'utf-8')

  const dirs = fs.readdirSync(root).sort()
  for (const old of dirs.slice(0, Math.max(0, dirs.length - log.maxIncidents))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true })
  }
  return target
}

export function startJournal(logDir: string) {
  dir = logDir
  try {
    fs.mkdirSync(dir, { recursive: true })
    const prev = readSession()
    const id = (prev?.id ?? 0) + 1
    started = true

    if (prev && !prev.clean) {
      const log = getConfig().log
      const saved = log.keepIncidents ? saveIncident(prev, log) : null
      logEvent('incident', `сессия ${prev.id} завершилась без отметки о выходе${saved ? `, записи: ${path.basename(saved)}` : ''}`)
    }

    writeSession({ id, startedAt: stamp(new Date()), clean: false })
    logEvent('start', `сессия ${id}`)
    void maintenance()
    maintenanceTimer = setInterval(() => void maintenance(), MAINTENANCE_MS)
  } catch (err) {
    console.error('[journal] запуск:', err)
  }
}

/** Штатное завершение. Повторный вызов безвреден: выход приходит с нескольких сторон. */
export function stopJournal(reason: string) {
  if (!started) return
  try {
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    flushBucket(getConfig().log)
    closeWriter(shortWriter)
    closeWriter(longWriter)
    shortWriter = null
    longWriter = null
    logEvent('stop', reason)
    const s = readSession()
    if (s) writeSession({ ...s, clean: true })
  } catch (err) {
    console.error('[journal] остановка:', err)
  }
  started = false
}
