/**
 * Токены и правила из дизайн-хендофа: цвет появляется только при отклонении
 * от нормы, всё остальное — нейтральный матовый серый.
 */

export type Threshold = readonly [warn: number, hot: number]

export const STATE = {
  normal: '#d3d6d8',
  warn: 'oklch(0.76 0.11 76)',
  hot: 'oklch(0.63 0.17 32)',
} as const

/** Пороги «тепло / жарко» по метрикам. */
export const TH = {
  cpuLoad: [70, 90],
  cpuTemp: [70, 85],
  gpuLoad: [75, 93],
  gpuTemp: [70, 84],
  gpuHotspot: [84, 96],
  vram: [78, 92],
  ram: [80, 92],
  thread: [78, 94],
  diskSpace: [80, 94],
  diskTemp: [55, 68],
} satisfies Record<string, Threshold>

export function col(v: number | null | undefined, th: Threshold): string {
  if (v == null || Number.isNaN(v)) return STATE.normal
  if (v >= th[1]) return STATE.hot
  if (v >= th[0]) return STATE.warn
  return STATE.normal
}

export function word(v: number | null | undefined, th: Threshold): string {
  if (v == null || Number.isNaN(v)) return '—'
  if (v >= th[1]) return 'жарко'
  if (v >= th[0]) return 'тепло'
  return 'норма'
}

/** stroke-dasharray для кольцевого датчика радиуса r. */
export function arc(pct: number | null | undefined, r: number): string {
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, (pct ?? 0) / 100))
  return `${(c * p).toFixed(1)} ${c.toFixed(1)}`
}

/** points для polyline в viewBox 0 0 100 40. */
export function poly(arr: number[] | undefined, max: number): string {
  if (!arr || arr.length < 2) return ''
  const n = arr.length
  return arr
    .map((v, i) => {
      const x = (i / (n - 1)) * 100
      const y = 39 - Math.max(0, Math.min(1, v / max)) * 37
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/** Температура 30…90 °C → 0…100 % для внутреннего кольца. */
export function tempPct(t: number | null | undefined): number {
  if (t == null) return 0
  return Math.max(0, Math.min(100, ((t - 30) / 60) * 100))
}

export function pct(used: number, total: number): number {
  if (!total) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

export const DASH = '—'

/** Форматирование: пропущенный датчик — прочерк, никогда не 0. */
export const num = {
  int: (v: number | null | undefined) => (v == null ? DASH : String(Math.round(v))),
  one: (v: number | null | undefined) => (v == null ? DASH : v.toFixed(1)),
  two: (v: number | null | undefined) => (v == null ? DASH : v.toFixed(2)),
  /** Тактовая частота: 0 ГГц означает «нет данных». */
  ghz: (v: number | null | undefined) => (v == null || v === 0 ? DASH : v.toFixed(2)),
  deg: (v: number | null | undefined) => (v == null ? DASH : `${Math.round(v)}°`),
  /** Мощность: ровный ноль — это отсутствующий датчик, а не простой. */
  watt: (v: number | null | undefined) => (v == null || v === 0 ? DASH : String(Math.round(v))),
}

/** Единицы объёма: гигабайты, пока влезают, дальше терабайты. */
export function gb(v: number | null | undefined): string {
  if (v == null) return DASH
  if (v >= 1024) return `${(v / 1024).toFixed(2)} ТБ`
  return `${Math.round(v)} ГБ`
}

export interface Rate {
  value: string
  /** «КБ/с» или «МБ/с» — подпись меняется вместе с порядком величины. */
  unit: string
}

const KB = 1024
const MB = 1024 * 1024

/**
 * Байты в секунду → читаемая пара «число + единица».
 * До 1000 КБ/с показываем килобайты: на медленном канале это единственный
 * масштаб, в котором видно разницу. Выше — мегабайты.
 */
export function rate(bps: number | null | undefined): Rate {
  if (bps == null || !Number.isFinite(bps)) return { value: DASH, unit: 'КБ/с' }
  const kb = bps / KB
  if (kb < 1000) return { value: kb >= 100 ? String(Math.round(kb)) : kb.toFixed(1), unit: 'КБ/с' }
  const mb = kb / 1024
  if (mb < 1000) return { value: mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1), unit: 'МБ/с' }
  return { value: (mb / 1024).toFixed(2), unit: 'ГБ/с' }
}

/** Одной строкой — там, где подпись не вынесена отдельно. */
export function rateStr(bps: number | null | undefined): string {
  const r = rate(bps)
  return `${r.value} ${r.unit}`
}

/**
 * Лесенка потолков графика, байт/с. Без неё автомасштаб дёргается на каждом
 * кадре; со ступенями картинка стоит на месте, пока трафик не вырастет втрое.
 */
const RATE_STEPS = [
  32 * KB, 64 * KB, 128 * KB, 256 * KB, 512 * KB,
  1 * MB, 2 * MB, 5 * MB, 10 * MB, 25 * MB, 50 * MB, 100 * MB, 250 * MB, 500 * MB, 1024 * MB,
]

/** Потолок сетевого графика: ближайшая ступень выше пика за всё окно истории. */
export function rateScale(...series: Array<number[] | undefined>): number {
  let peak = 0
  for (const arr of series) {
    if (!arr) continue
    for (const v of arr) if (Number.isFinite(v) && v > peak) peak = v
  }
  return RATE_STEPS.find(step => step >= peak) ?? peak
}
