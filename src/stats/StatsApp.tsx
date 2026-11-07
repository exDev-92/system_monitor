import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './stats.css'
import type { StatsResult } from '../../electron/stats'
import { rateStr, TH } from '../designs/tokens'

const HOUR = 3_600_000

const PRESETS: Array<{ id: string; label: string; ms: number | null }> = [
  { id: '1h', label: '1 ч', ms: HOUR },
  { id: '6h', label: '6 ч', ms: 6 * HOUR },
  { id: '24h', label: '24 ч', ms: 24 * HOUR },
  { id: '7d', label: '7 д', ms: 168 * HOUR },
  { id: '30d', label: '30 д', ms: 720 * HOUR },
  { id: 'all', label: 'Всё', ms: null },
]

/** Столько отрезков запрашиваем: примерно по одному на пиксель широкого экрана. */
const POINTS = 2000

const CPU = '#5aa9e6'
const GPU = '#f0a04b'
const RAM = '#b48ee8'
const DOWN = '#4fc3a1'
const UP = '#e58fb4'
const DISK_COLORS = ['#5fd0d8', '#e8d36a', '#b48ee8', '#9ccc65', '#ef9a9a']
const HOT = '#e0705a'

const pad = (n: number) => String(n).padStart(2, '0')

function dateTime(t: number): string {
  const d = new Date(t)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} в ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function tick(t: number, span: number): string {
  const d = new Date(t)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
  if (span <= 24 * HOUR) return clock
  if (span <= 72 * HOUR) return `${date} ${clock}`
  return date
}

function duration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h >= 48) return `${Math.round(h / 24)} дн`
  if (h > 0) return `${h} ч ${m} мин`
  return `${m} мин`
}

/** Частота записи берётся из самих строк, а не из настройки: период могли менять. */
function intervalText(sec: number | null): string {
  if (sec == null) return 'точные данные'
  const rounded = sec < 10 ? Math.round(sec * 2) / 2 : Math.round(sec)
  return `каждые ~${String(rounded).replace('.', ',')} с`
}

function detailText(from: number, to: number, sec: number | null): string {
  const minutes = Math.round((to - from) / 60_000)
  const span = minutes >= 120 ? `последние ${Math.round(minutes / 60)} ч` : `последние ${minutes} мин`
  return `${span} — ${intervalText(sec)}`
}

interface Line {
  key: string
  name: string
  color: string
}

interface ChartDef {
  title: string
  height: number
  yMin: number
  yMax: number
  top: string
  bottom: string
  format: (v: number) => string
  lines: Line[]
  limit?: number
  peaks?: boolean
}

/** Значение ближе всего к указанному отрезку, но не через разрыв в данных. */
function nearest(arr: Float32Array, i: number): number {
  for (let k = 0; k < 40; k++) {
    if (i - k >= 0 && !Number.isNaN(arr[i - k])) return i - k
    if (i + k < arr.length && !Number.isNaN(arr[i + k])) return i + k
  }
  return -1
}

function Chart({ def, data, hover, setHover, onZoom, showDetailLabel }: {
  def: ChartDef
  data: StatsResult
  hover: number | null
  setHover: (f: number | null) => void
  onZoom: (from: number, to: number) => void
  showDetailLabel: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(e => setWidth(e[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const span = data.to - data.from
  const pct = (t: number) => ((t - data.from) / span) * 100
  const yPct = useCallback((v: number) => {
    const c = Math.min(def.yMax, Math.max(def.yMin, v))
    return 100 - ((c - def.yMin) / (def.yMax - def.yMin)) * 100
  }, [def.yMin, def.yMax])

  const lines = def.lines.filter(l => data.series[l.key])

  // Канва перерисовывается только при новых данных и смене размера, а не на каждое движение мыши.
  useEffect(() => {
    const c = canvas.current
    if (!c || !width) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(width * dpr)
    c.height = Math.round(def.height * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, def.height)

    g.strokeStyle = '#1d2021'
    g.lineWidth = 1
    for (const f of [0.25, 0.5, 0.75]) {
      g.beginPath()
      g.moveTo(0, Math.round(def.height * f) + 0.5)
      g.lineTo(width, Math.round(def.height * f) + 0.5)
      g.stroke()
    }

    g.fillStyle = '#1b1d1e'
    for (const gap of data.gaps) {
      const x = (pct(gap.from) / 100) * width
      g.fillRect(x, 0, ((gap.to - gap.from) / span) * width, def.height)
    }

    if (data.detail) {
      const x = Math.max(0, (pct(data.detail.from) / 100) * width)
      g.fillStyle = 'rgba(120, 190, 255, 0.10)'
      g.fillRect(x, 0, width - x, def.height)
    }

    if (def.limit != null) {
      g.strokeStyle = HOT
      g.setLineDash([6, 5])
      const y = (yPct(def.limit) / 100) * def.height
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(width, y)
      g.stroke()
      g.setLineDash([])
    }

    const bucket = span / data.points
    g.lineWidth = 1.6
    g.lineJoin = 'round'
    for (const line of lines) {
      const avg = data.series[line.key].avg
      g.strokeStyle = line.color
      g.beginPath()
      let prevT: number | null = null
      for (let i = 0; i < avg.length; i++) {
        if (Number.isNaN(avg[i])) continue
        const t = data.from + (i + 0.5) * bucket
        const pT = prevT
        const broken = pT == null || data.gaps.some(gap => gap.from >= pT - bucket && gap.to <= t + bucket && gap.to > pT)
        const x = (i / (avg.length - 1)) * width
        const y = (yPct(avg[i]) / 100) * def.height
        if (broken) g.moveTo(x, y)
        else g.lineTo(x, y)
        prevT = t
      }
      g.stroke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, width, def.height, def.limit, yPct, lines.length])

  const fracAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  const hoverT = hover == null ? null : data.from + hover * span
  const hoverGap = hoverT == null ? null : data.gaps.find(g => hoverT >= g.from && hoverT <= g.to) ?? null
  const hoverDetail = hoverT != null && data.detail != null && hoverT >= data.detail.from
  const hoverIdx = hover == null ? -1 : Math.min(data.points - 1, Math.floor(hover * data.points))

  const points = hover == null || hoverGap
    ? []
    : lines.flatMap(l => {
      const s = data.series[l.key]
      const j = nearest(s.avg, hoverIdx)
      if (j < 0) return []
      return [{ line: l, avg: s.avg[j], max: s.max[j], left: (j / (data.points - 1)) * 100 }]
    })

  const peaks = def.peaks && hover == null
    ? lines.flatMap(l => {
      const m = data.series[l.key].max
      let at = -1
      for (let i = 0; i < m.length; i++) if (!Number.isNaN(m[i]) && (at < 0 || m[i] > m[at])) at = i
      if (at < 0) return []
      const left = (at / (data.points - 1)) * 100
      return [{ line: l, value: m[at], left, time: data.from + ((at + 0.5) / data.points) * span }]
    })
    : []

  const legendValue = (l: Line) => {
    const p = points.find(x => x.line === l)
    if (p) return def.format(p.avg)
    if (hover != null) return '—'
    const m = data.series[l.key].max
    let best = NaN
    for (let i = 0; i < m.length; i++) if (!Number.isNaN(m[i]) && !(m[i] <= best)) best = m[i]
    return Number.isNaN(best) ? '—' : `макс. ${def.format(best)}`
  }

  const detailPct = data.detail ? Math.max(0, pct(data.detail.from)) : null

  return (
    <section className="st-chart">
      <div className="st-chart-head">
        <h2>{def.title}</h2>
        <div className="st-legend">
          {lines.map(l => (
            <span key={l.key}>
              <i style={{ background: l.color }} />
              {l.name} <b style={{ color: l.color }}>{legendValue(l)}</b>
            </span>
          ))}
          {def.limit != null && (
            <span style={{ color: HOT }}><i className="dash" />перегрев от {def.limit}°</span>
          )}
        </div>
      </div>

      <div className="st-plot">
        <div className="st-axis"><span>{def.top}</span><span>{def.bottom}</span></div>
        <div
          ref={box}
          className="st-canvas-box"
          style={{ height: def.height }}
          onMouseMove={e => {
            const f = fracAt(e.clientX)
            setHover(f)
            if (drag) setDrag({ a: drag.a, b: f })
          }}
          onMouseLeave={() => { setHover(null); setDrag(null) }}
          onMouseDown={e => { const f = fracAt(e.clientX); setDrag({ a: f, b: f }) }}
          onMouseUp={e => {
            const f = fracAt(e.clientX)
            const a = drag?.a ?? f
            setDrag(null)
            if (Math.abs(f - a) * width > 6) {
              onZoom(data.from + Math.min(a, f) * span, data.from + Math.max(a, f) * span)
            } else if (data.detail && data.from + f * span >= data.detail.from) {
              // Щелчок по зоне точных данных открывает её на весь график.
              onZoom(Math.max(data.from, data.detail.from), data.to)
            }
          }}
        >
          <canvas ref={canvas} style={{ width: '100%', height: def.height, display: 'block' }} />

          {data.gaps.map(g => ((g.to - g.from) / span) * width >= 70 && (
            <div
              key={g.from}
              className="st-gap"
              style={{ left: `${pct(g.from)}%`, width: `${((g.to - g.from) / span) * 100}%` }}
            >
              <span>{g.label}</span>
              <small>{duration((g.to - g.from) / 1000)}</small>
            </div>
          ))}

          {detailPct != null && (
            <div className="st-detail-edge" style={{ left: `${detailPct}%` }} />
          )}
          {data.detail && showDetailLabel && (
            <div className="st-detail-label">{detailText(Math.max(data.from, data.detail.from), data.to, data.detail.intervalSec)}</div>
          )}

          {peaks.map(p => (
            <div key={p.line.key}>
              <div className="st-dot small" style={{ left: `${p.left}%`, top: `${yPct(p.value)}%`, background: p.line.color }} />
              <div
                className={p.left > 75 ? 'st-peak flip' : 'st-peak'}
                style={{ left: `${p.left}%`, top: `${yPct(p.value)}%`, color: p.line.color }}
              >
                {def.format(p.value)}, {dateTime(p.time)}
              </div>
            </div>
          ))}

          {hover != null && <div className="st-cross" style={{ left: `${hover * 100}%` }} />}
          {points.map(p => (
            <div
              key={p.line.key}
              className="st-dot"
              style={{ left: `${p.left}%`, top: `${yPct(p.avg)}%`, background: p.line.color }}
            />
          ))}

          {hover != null && hoverT != null && (
            <div className={hover > 0.75 ? 'st-tip flip' : 'st-tip'} style={{ left: `${hover * 100}%` }}>
              <time>{dateTime(hoverT)}</time>
              {hoverGap && <span>{hoverGap.label}, {duration((hoverGap.to - hoverGap.from) / 1000)}</span>}
              {points.map(p => (
                <span key={p.line.key} className="row">
                  <span>{p.line.name}</span>
                  <b style={{ color: p.line.color }}>
                    {def.format(p.avg)}
                    {!hoverDetail && p.max - p.avg >= 1 && <em> макс. {def.format(p.max)}</em>}
                  </b>
                </span>
              ))}
              {!hoverGap && points.length > 0 && (
                <small style={{ color: hoverDetail ? '#a9d2f2' : undefined }}>
                  {hoverDetail ? `точное значение, ${intervalText(data.detail!.intervalSec)}` : 'среднее, сглажено'}
                </small>
              )}
            </div>
          )}

          {drag && Math.abs(drag.b - drag.a) * width > 6 && (
            <div
              className="st-select"
              style={{ left: `${Math.min(drag.a, drag.b) * 100}%`, width: `${Math.abs(drag.b - drag.a) * 100}%` }}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function buildCharts(data: StatsResult): ChartDef[] {
  let watts = 100
  for (const key of ['cpu_w', 'gpu_w']) {
    const m = data.series[key]?.max
    if (m) for (let i = 0; i < m.length; i++) if (m[i] > watts) watts = m[i]
  }
  const wattsTop = Math.ceil(watts / 50) * 50

  let bytes = 0
  for (const key of ['net_down_kbs', 'net_up_kbs']) {
    const m = data.series[key]?.avg
    if (m) for (let i = 0; i < m.length; i++) if (m[i] > bytes) bytes = m[i]
  }
  const kbTop = Math.max(32, bytes * 1.1)

  const disks = Object.keys(data.series)
    .filter(k => /^disk_.+_temp$/.test(k))
    .sort()
    .map((key, i) => ({
      key,
      name: `${key.slice(5, -5)}:`,
      color: DISK_COLORS[i % DISK_COLORS.length],
    }))

  const deg = (v: number) => `${Math.round(v)}°`

  return [
    {
      title: 'ТЕМПЕРАТУРЫ', height: 190, yMin: 20, yMax: 100, top: '100°', bottom: '20°',
      format: deg, limit: TH.cpuTemp[1], peaks: true,
      lines: [
        { key: 'cpu_temp', name: 'Процессор', color: CPU },
        { key: 'gpu_temp', name: 'Видеокарта', color: GPU },
      ],
    },
    {
      title: 'ЗАГРУЗКА', height: 130, yMin: 0, yMax: 100, top: '100 %', bottom: '0',
      format: v => `${Math.round(v)} %`,
      lines: [
        { key: 'cpu_load', name: 'Процессор', color: CPU },
        { key: 'gpu_load', name: 'Видеокарта', color: GPU },
        { key: 'ram_pct', name: 'Память', color: RAM },
      ],
    },
    {
      title: 'МОЩНОСТЬ', height: 130, yMin: 0, yMax: wattsTop, top: `${wattsTop} Вт`, bottom: '0',
      format: v => `${Math.round(v)} Вт`,
      lines: [
        { key: 'cpu_w', name: 'Процессор', color: CPU },
        { key: 'gpu_w', name: 'Видеокарта', color: GPU },
      ],
    },
    {
      title: 'СЕТЬ', height: 110, yMin: 0, yMax: kbTop, top: rateStr(kbTop * 1024), bottom: '0',
      format: v => rateStr(v * 1024),
      lines: [
        { key: 'net_down_kbs', name: 'Загрузка', color: DOWN },
        { key: 'net_up_kbs', name: 'Отдача', color: UP },
      ],
    },
    {
      title: 'ТЕМПЕРАТУРА НАКОПИТЕЛЕЙ', height: 110, yMin: 20, yMax: 70, top: '70°', bottom: '20°',
      format: deg, lines: disks,
    },
  ]
}

const EVENT_COLOR: Record<string, string> = {
  threshold: HOT,
  incident: HOT,
  error: HOT,
}

export default function StatsApp() {
  const [preset, setPreset] = useState<string | null>('24h')
  const [range, setRange] = useState(() => ({ from: Date.now() - 24 * HOUR, to: Date.now() }))
  const [data, setData] = useState<StatsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const request = useRef(0)

  // Быстрые щелчки по периодам: показываем только ответ на последний запрос.
  const load = useCallback(async (r: { from: number; to: number }) => {
    const id = ++request.current
    setLoading(true)
    const res: StatsResult = await window.ipcRenderer.invoke('stats:query', { ...r, points: POINTS })
    if (id !== request.current) return
    setData(res)
    setLoading(false)
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const pick = (id: string) => {
    const p = PRESETS.find(x => x.id === id)!
    const to = Date.now()
    setPreset(id)
    setHover(null)
    setRange({ from: p.ms ? to - p.ms : data?.earliest ?? to - 720 * HOUR, to })
  }

  const zoom = (from: number, to: number) => {
    setPreset(null)
    setHover(null)
    setRange({ from: Math.round(from), to: Math.round(to) })
  }

  const shift = (dir: number) => {
    const span = range.to - range.from
    const to = Math.min(Date.now(), range.to + dir * span)
    setPreset(null)
    setHover(null)
    setRange({ from: to - span, to })
  }

  // Кнопка «Всё» до первого ответа не знает начала журнала.
  useEffect(() => {
    if (preset === 'all' && data?.earliest && range.from !== data.earliest) {
      setRange(r => ({ ...r, from: data.earliest! }))
    }
  }, [preset, data?.earliest, range.from])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const charts = useMemo(() => (data ? buildCharts(data) : []), [data])
  const span = data ? data.to - data.from : 1
  const hasRows = data ? Object.keys(data.series).length > 0 : false
  const s = data?.summary

  return (
    <div className="st-app">
      <header className="st-top">
        <h1>СТАТИСТИКА</h1>
        <div className="st-pills">
          {PRESETS.map(p => (
            <button key={p.id} className={preset === p.id ? 'active' : ''} onClick={() => pick(p.id)}>{p.label}</button>
          ))}
        </div>
        <div className="st-nav">
          <button aria-label="Предыдущий период" onClick={() => shift(-1)}>‹</button>
          <span>{dateTime(range.from)} — {dateTime(range.to)}</span>
          <button aria-label="Следующий период" onClick={() => shift(1)}>›</button>
          <button
            aria-label="Обновить"
            title="Обновить"
            onClick={() => (preset ? pick(preset) : void load(range))}
          >↻</button>
          <span className="st-busy">{loading ? 'чтение…' : ''}</span>
        </div>
      </header>

      {s && (
        <section className="st-tiles">
          <div>
            <label>ПРОЦЕССОР, МАКСИМУМ</label>
            <b style={{ color: CPU }}>{s.cpuTemp ? `${Math.round(s.cpuTemp.value)}°` : '—'}</b>
            <small>{s.cpuTemp ? `${dateTime(s.cpuTemp.time)}, в среднем ${Math.round(s.cpuTemp.avg ?? 0)}°` : 'нет данных: нужны права администратора'}</small>
          </div>
          <div>
            <label>ВИДЕОКАРТА, МАКСИМУМ</label>
            <b style={{ color: GPU }}>{s.gpuTemp ? `${Math.round(s.gpuTemp.value)}°` : '—'}</b>
            <small>{s.gpuTemp ? `${dateTime(s.gpuTemp.time)}, в среднем ${Math.round(s.gpuTemp.avg ?? 0)}°` : 'нет данных'}</small>
          </div>
          <div>
            <label>МОЩНОСТЬ</label>
            <b>{s.powerAvg != null ? `${Math.round(s.powerAvg)} Вт` : '—'}</b>
            <small>{s.powerPeak != null ? `в среднем, пик ${Math.round(s.powerPeak)} Вт` : 'нет данных'}</small>
          </div>
          <div>
            <label>ЭНЕРГИЯ</label>
            <b>{s.energyKWh.toFixed(s.energyKWh < 10 ? 2 : 1).replace('.', ',')} кВт·ч</b>
            <small>процессор и видеокарта</small>
          </div>
          <div>
            <label>ИНТЕРНЕТ</label>
            <b style={{ color: DOWN }}>{s.downGB.toFixed(s.downGB < 10 ? 2 : 1).replace('.', ',')} ГБ</b>
            <small>скачано, отдано {s.upGB.toFixed(2).replace('.', ',')} ГБ</small>
          </div>
          <div>
            <label>СБОИ</label>
            <b style={{ color: s.incidents ? HOT : undefined }}>{s.incidents}</b>
            <small>компьютер работал {duration(s.workedSec)}</small>
          </div>
        </section>
      )}

      {data && !hasRows && !loading && (
        <div className="st-empty">За этот период в журнале нет записей.</div>
      )}

      {data && hasRows && (
        <main className="st-charts">
          {charts.map((def, i) => (
            <Chart
              key={def.title}
              def={def}
              data={data}
              hover={hover}
              setHover={setHover}
              onZoom={zoom}
              showDetailLabel={i === 0}
            />
          ))}

          <div className="st-ticks">
            {[0, 0.25, 0.5, 0.75, 1].map(f => <span key={f}>{tick(data.from + f * span, span)}</span>)}
          </div>
          <div className="st-help">
            Наведите мышь, чтобы увидеть точку и время. Выделите участок мышью, чтобы приблизить.
            Щелчок по голубой зоне открывает точные данные.
          </div>
        </main>
      )}

      {data && data.events.length > 0 && (
        <section className="st-events">
          <h2>СОБЫТИЯ</h2>
          {data.events.map(e => (
            <div key={`${e.time}-${e.kind}-${e.text}`} className="st-event">
              <time>{dateTime(e.time)}</time>
              <i style={{ background: EVENT_COLOR[e.kind] ?? '#a3a8ab' }} />
              <span>{e.text}</span>
              {e.kind === 'incident'
                ? <button onClick={() => window.ipcRenderer.send('log:open-incidents')}>Открыть записи</button>
                : <button onClick={() => zoom(e.time - HOUR / 2, e.time + HOUR / 2)}>К графику</button>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
