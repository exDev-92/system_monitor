import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

/**
 * Чтение журнала для окна статистики. Всё считается по запросу и не держится
 * в памяти: окно закрыто — главный процесс ничего не хранит.
 *
 * Период делится на равные отрезки, в каждый сводятся минимум, среднее и максимум.
 * Посекундные данные берутся из short/, всё более раннее — из long/.
 */

/** Колонки журнала, которые показывает окно. Температуры дисков находятся по шаблону. */
const FIXED_SERIES = [
  'cpu_temp', 'gpu_temp', 'cpu_load', 'gpu_load', 'ram_pct',
  'cpu_w', 'gpu_w', 'net_down_kbs', 'net_up_kbs',
]
const DISK_TEMP = /^disk_(.+)_temp$/

const MIN_GAP_SEC = 15

export interface StatsSeries {
  min: Float32Array
  avg: Float32Array
  max: Float32Array
}

export interface StatsGap { from: number; to: number; label: string }
export interface StatsEvent { time: number; kind: string; text: string }
export interface StatsPeak { value: number; time: number; avg: number | null }

export interface StatsResult {
  from: number
  to: number
  points: number
  series: Record<string, StatsSeries>
  gaps: StatsGap[]
  /** Зона точных данных: с какого момента идёт short/ и как часто там строки. */
  detail: { from: number; intervalSec: number | null } | null
  events: StatsEvent[]
  /** Самая ранняя запись журнала — для кнопки «Всё». */
  earliest: number | null
  summary: {
    cpuTemp: StatsPeak | null
    gpuTemp: StatsPeak | null
    powerAvg: number | null
    powerPeak: number | null
    energyKWh: number
    downGB: number
    upGB: number
    workedSec: number
    incidents: number
  }
}

interface LogFile { file: string; start: number; end: number }

const NAME_TIME = /_(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)(\d\d)\.csv(\.gz)?$/

async function listLogFiles(dir: string, isLong: boolean): Promise<LogFile[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: LogFile[] = []
  for (const name of names) {
    const m = NAME_TIME.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
    try {
      const { mtimeMs } = await fs.promises.stat(file)
      // Файл долгого журнала не переходит через полночь, а его mtime сдвигает сжатие.
      const dayEnd = new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime()
      out.push({ file, start, end: isLong ? Math.min(mtimeMs, dayEnd) : mtimeMs })
    } catch { /* файл только что удалён очисткой */ }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Разбор вручную заметно быстрее `new Date(строка)`, а строк бывают сотни тысяч. */
function parseTime(s: string): number {
  if (s.length !== 19) return NaN
  return new Date(
    +s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10),
    +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19),
  ).getTime()
}

function parseNumber(s: string | undefined): number {
  if (!s) return NaN
  return Number(s.replace(',', '.'))
}

interface Wanted { name: string; lo: number; mid: number; hi: number }

function wantedColumns(header: string[], isLong: boolean): Wanted[] {
  const out: Wanted[] = []
  const add = (name: string) => {
    if (isLong) {
      const mid = header.indexOf(`${name}_avg`)
      if (mid >= 0) out.push({ name, lo: header.indexOf(`${name}_min`), mid, hi: header.indexOf(`${name}_max`) })
    } else {
      const mid = header.indexOf(name)
      if (mid >= 0) out.push({ name, lo: mid, mid, hi: mid })
    }
  }
  FIXED_SERIES.forEach(add)
  for (const col of header) {
    const name = isLong ? col.replace(/_avg$/, '') : col
    if (DISK_TEMP.test(name) && (!isLong || col.endsWith('_avg'))) add(name)
  }
  return out
}

interface Accumulator {
  from: number
  to: number
  points: number
  sum: Record<string, Float64Array>
  count: Record<string, Uint32Array>
  min: Record<string, Float32Array>
  max: Record<string, Float32Array>
  gaps: Array<{ from: number; to: number }>
  lastTime: number | null
  step: number
  shortRows: number
  shortSpanSec: number
  cpuTemp: { value: number; time: number; sum: number; n: number } | null
  gpuTemp: { value: number; time: number; sum: number; n: number } | null
  powerSum: number
  powerN: number
  powerPeak: number | null
  energyWh: number
  downKB: number
  upKB: number
  workedSec: number
}

function touchPeak(cur: Accumulator['cpuTemp'], hi: number, avg: number, t: number): Accumulator['cpuTemp'] {
  const p = cur ?? { value: hi, time: t, sum: 0, n: 0 }
  if (hi > p.value) {
    p.value = hi
    p.time = t
  }
  p.sum += avg
  p.n += 1
  return p
}

async function readFile(log: LogFile, isLong: boolean, skipFrom: number | null, acc: Accumulator) {
  const raw = fs.createReadStream(log.file)
  const input = log.file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw
  const lines = readline.createInterface({ input, crlfDelay: Infinity })

  let columns: Wanted[] | null = null
  let minDiff = Infinity
  let rowsInFile = 0
  const span = acc.to - acc.from

  try {
    for await (const line of lines) {
      const cells = line.split(';')
      if (!columns) {
        columns = wantedColumns(cells, isLong)
        continue
      }
      const t = parseTime(cells[0])
      if (Number.isNaN(t)) continue // оборванная запись при сбое
      if (t < acc.from || t > acc.to) continue
      if (skipFrom != null && t >= skipFrom) continue

      let dt = 0
      if (acc.lastTime != null) {
        const diff = (t - acc.lastTime) / 1000
        // Шаг записи узнаём только внутри файла: расстояние до прошлого файла — это и есть разрыв.
        if (rowsInFile > 0 && diff > 0 && diff < minDiff) minDiff = diff
        const known = Number.isFinite(minDiff) ? minDiff : acc.step
        const threshold = Math.max(MIN_GAP_SEC, 3 * known)
        if (diff > threshold) {
          acc.gaps.push({ from: acc.lastTime + known * 1000, to: t })
        } else if (diff > 0) {
          dt = diff
        }
        if (Number.isFinite(minDiff)) acc.step = minDiff
      }
      acc.lastTime = t
      rowsInFile += 1
      acc.workedSec += dt
      if (!isLong && dt > 0) {
        acc.shortRows += 1
        acc.shortSpanSec += dt
      }

      const i = Math.min(acc.points - 1, Math.floor(((t - acc.from) / span) * acc.points))
      let cpuW = NaN
      let gpuW = NaN
      let cpuWHi = NaN
      let gpuWHi = NaN

      for (const c of columns) {
        const mid = parseNumber(cells[c.mid])
        if (Number.isNaN(mid)) continue
        const lo = c.lo === c.mid ? mid : parseNumber(cells[c.lo])
        const hi = c.hi === c.mid ? mid : parseNumber(cells[c.hi])

        if (!acc.sum[c.name]) {
          acc.sum[c.name] = new Float64Array(acc.points)
          acc.count[c.name] = new Uint32Array(acc.points)
          acc.min[c.name] = new Float32Array(acc.points).fill(NaN)
          acc.max[c.name] = new Float32Array(acc.points).fill(NaN)
        }
        acc.sum[c.name][i] += mid
        acc.count[c.name][i] += 1
        const curLo = acc.min[c.name][i]
        const curHi = acc.max[c.name][i]
        acc.min[c.name][i] = Number.isNaN(curLo) ? lo : Math.min(curLo, lo)
        acc.max[c.name][i] = Number.isNaN(curHi) ? hi : Math.max(curHi, hi)

        switch (c.name) {
          case 'cpu_temp': acc.cpuTemp = touchPeak(acc.cpuTemp, hi, mid, t); break
          case 'gpu_temp': acc.gpuTemp = touchPeak(acc.gpuTemp, hi, mid, t); break
          case 'cpu_w': cpuW = mid; cpuWHi = hi; break
          case 'gpu_w': gpuW = mid; gpuWHi = hi; break
          case 'net_down_kbs': acc.downKB += mid * dt; break
          case 'net_up_kbs': acc.upKB += mid * dt; break
        }
      }

      // Датчик мощности ЦП без прав администратора молчит: считаем то, что есть.
      if (!Number.isNaN(cpuW) || !Number.isNaN(gpuW)) {
        const watts = (cpuW || 0) + (gpuW || 0)
        const peak = (cpuWHi || 0) + (gpuWHi || 0)
        acc.powerSum += watts
        acc.powerN += 1
        acc.energyWh += (watts * dt) / 3600
        if (acc.powerPeak == null || peak > acc.powerPeak) acc.powerPeak = peak
      }
    }
  } catch (err) {
    // Повреждённый архив не должен лишать статистики за остальные дни.
    console.error('[stats] чтение', log.file, err)
  } finally {
    lines.close()
    raw.destroy()
  }
}

const EVENT_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+)\s+(.*)$/

async function readEvents(dir: string): Promise<StatsEvent[]> {
  const out: StatsEvent[] = []
  for (const name of ['events.1.log', 'events.log']) {
    let text: string
    try {
      text = await fs.promises.readFile(path.join(dir, name), 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = EVENT_LINE.exec(line)
      if (m) out.push({ time: parseTime(m[1]), kind: m[2], text: m[3] })
    }
  }
  return out
}

/** Почему не было данных — по журналу событий вокруг начала и конца разрыва. */
function gapLabel(gap: { from: number; to: number }, events: StatsEvent[]): string {
  const margin = 180_000
  const near = events.filter(e => e.time >= gap.from - margin && e.time <= gap.to + margin)
  if (near.some(e => e.kind === 'incident')) return 'сбой'
  if (near.some(e => e.kind === 'power' && e.text === 'сон')) return 'сон'
  const stop = near.find(e => e.kind === 'stop')
  if (stop) return stop.text.includes('Windows') ? 'выключен' : 'приложение закрыто'
  return 'нет данных'
}

const SHOWN_EVENTS = new Set(['threshold', 'incident', 'power', 'backend', 'error', 'disk'])

export async function queryStats(
  dir: string,
  req: { from: number; to: number; points: number },
): Promise<StatsResult> {
  const to = Number(req.to)
  const from = Math.min(Number(req.from), to - 60_000)
  const points = Math.max(100, Math.min(4000, Math.round(Number(req.points)) || 2000))

  const shortFiles = await listLogFiles(path.join(dir, 'short'), false)
  const longFiles = await listLogFiles(path.join(dir, 'long'), true)
  const starts = [...shortFiles, ...longFiles].map(f => f.start)

  const acc: Accumulator = {
    from, to, points,
    sum: {}, count: {}, min: {}, max: {},
    gaps: [],
    lastTime: null,
    step: 60,
    shortRows: 0,
    shortSpanSec: 0,
    cpuTemp: null,
    gpuTemp: null,
    powerSum: 0,
    powerN: 0,
    powerPeak: null,
    energyWh: 0,
    downKB: 0,
    upKB: 0,
    workedSec: 0,
  }

  // Точные данные важнее: там, где есть short/, долгий журнал не читается.
  const detailFrom = shortFiles.length ? shortFiles[0].start : null
  const overlaps = (f: LogFile) => f.start <= to && f.end >= from

  for (const f of longFiles.filter(overlaps)) await readFile(f, true, detailFrom, acc)
  for (const f of shortFiles.filter(overlaps)) await readFile(f, false, null, acc)

  const series: Record<string, StatsSeries> = {}
  for (const name of Object.keys(acc.sum)) {
    const avg = new Float32Array(points).fill(NaN)
    const sum = acc.sum[name]
    const count = acc.count[name]
    for (let i = 0; i < points; i++) if (count[i]) avg[i] = sum[i] / count[i]
    series[name] = { min: acc.min[name], avg, max: acc.max[name] }
  }

  const events = await readEvents(dir)
  const inRange = events.filter(e => e.time >= from && e.time <= to)
  const peak = (p: Accumulator['cpuTemp']): StatsPeak | null => (
    p ? { value: p.value, time: p.time, avg: p.n ? p.sum / p.n : null } : null
  )

  return {
    from,
    to,
    points,
    series,
    gaps: acc.gaps.map(g => ({ ...g, label: gapLabel(g, events) })),
    detail: detailFrom != null && detailFrom < to
      ? { from: detailFrom, intervalSec: acc.shortRows ? acc.shortSpanSec / acc.shortRows : null }
      : null,
    events: inRange.filter(e => SHOWN_EVENTS.has(e.kind)).reverse().slice(0, 200),
    earliest: starts.length ? Math.min(...starts) : null,
    summary: {
      cpuTemp: peak(acc.cpuTemp),
      gpuTemp: peak(acc.gpuTemp),
      powerAvg: acc.powerN ? acc.powerSum / acc.powerN : null,
      powerPeak: acc.powerPeak,
      energyKWh: acc.energyWh / 1000,
      downGB: acc.downKB / 1048576,
      upGB: acc.upKB / 1048576,
      workedSec: acc.workedSec,
      incidents: inRange.filter(e => e.kind === 'incident').length,
    },
  }
}
