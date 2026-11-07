import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import './designs/base.css'
import './designs/dense.css'
import './designs/cards.css'
import './designs/hud.css'
import { Metrics } from './types'
import { DesignProps, emptyHistory, History, pushHistory, Snapshot, toSnapshot } from './designs/snapshot'
import DenseConsole from './designs/DenseConsole'
import CardGrid from './designs/CardGrid'
import IndustrialHud from './designs/IndustrialHud'
import { useConfig } from './settings/useConfig'

// ── Варианты дизайна ───────────────────────────────────────────
type DesignId = '1a' | '1b' | '1c'
/** auto — по ширине окна; game — весь экран поверх панели задач. */
type LayoutMode = 'auto' | 'full' | 'half' | 'game'

const DESIGNS: Array<{
  id: DesignId
  title: string
  render: (p: DesignProps) => JSX.Element
}> = [
  { id: '1a', title: 'Плотный пульт', render: p => <DenseConsole {...p} /> },
  { id: '1b', title: 'Сетка карточек', render: p => <CardGrid {...p} /> },
  { id: '1c', title: 'Индустриальный HUD', render: p => <IndustrialHud {...p} /> },
]

/**
 * Базовая высота макета из дизайна (1080 минус 40 px панели задач).
 * Масштаб считается по ней, а ширина кадра подстраивается под окно —
 * так у макета никогда нет чёрных полей, а вертикальная геометрия
 * (кольца 262 px, нижняя полоса 214 px) остаётся ровно как в дизайне.
 */
const BASE_HEIGHT = 1040

/** Ниже этой логической ширины показываем макет половины экрана. */
const HALF_WIDTH_LIMIT = 1400

// ── Пустой снимок до первых данных от бэкенда ──────────────────
const BLANK: Metrics = {
  cpu: { name: '—', utilization: 0, clock_ghz: 0, threads: 0, temp_c: null, history: [], per_core: [] },
  gpu: {
    name: '—', utilization: 0, clock_ghz: 0, clock_mhz: 0, mem_clock_mhz: 0,
    vram_used_gb: 0, vram_total_gb: 0, temp_c: 0, power_w: 0, fan_pct: null, history: [],
  },
  ram: { utilization_pct: 0, used_gb: 0, total_gb: 0, speed_mhz: 0, slots_used: 0, slots_total: 0, committed_gb: 0 },
  disks: [],
  network: { status: '—', type: 'ethernet', download_mbps: 0, upload_mbps: 0, latency_ms: 0, ip: '—', signal: '—' },
  power: { status: '—', charging: false, battery_pct: 0, power_plan: '—', estimated_time: '—', voltage_v: 0, current_a: 0, power_w: 0 },
  fans: { cpu_rpm: 0, cpu_pct: 0, gpu_rpm: 0, gpu_pct: 0 },
  system: { os: '—', motherboard: '—', uptime: '—', last_updated: '—' },
  smart: { overall: '—', reallocated_sectors: 0, power_on_hours: 0, temp_c: 0, drive_status: '—' },
  summary: { healthy: true, total_uptime: '—', total_data_read_tb: 0, total_data_written_gb: 0 },
}

// ── Телеметрия: снимок + кольцевые буферы графиков ─────────────
function useTelemetry(): { snapshot: Snapshot; history: History; silentSec: number } {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => toSnapshot(BLANK, false))
  const [history, setHistory] = useState<History>(emptyHistory)
  const lastPacketAt = useRef(Date.now())
  const [silentSec, setSilentSec] = useState(0)

  useEffect(() => {
    const handler = (_e: unknown, data: Metrics) => {
      const next = toSnapshot(data)
      lastPacketAt.current = Date.now()
      setSilentSec(0)
      setSnapshot(next)
      setHistory(prev => pushHistory(prev, next))
    }
    window.ipcRenderer.on('metrics', handler)
    return () => { window.ipcRenderer.off('metrics', handler) }
  }, [])

  // Часы тикают раз в секунду, даже если бэкенд молчит.
  useEffect(() => {
    const id = setInterval(() => {
      setSilentSec(Math.floor((Date.now() - lastPacketAt.current) / 1000))
      setSnapshot(prev => {
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        return { ...prev, clock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` }
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return { snapshot, history, silentSec }
}

// ── Масштабирование кадра под окно ─────────────────────────────
interface StageBox { width: number; height: number }

function useStageSize(ref: React.RefObject<HTMLElement>): StageBox {
  const [box, setBox] = useState<StageBox>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setBox({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return box
}

/** Кадр в логических пикселях макета: высота фиксирована, ширина — от окна. */
function frameGeometry(box: StageBox) {
  if (!box.width || !box.height) return { scale: 1, width: 0, height: BASE_HEIGHT }
  const scale = box.height / BASE_HEIGHT
  return { scale, width: box.width / scale, height: BASE_HEIGHT }
}

/** Какой из двух макетов рисовать. Игровой режим — широкий, как полный экран. */
function resolveLayout(mode: LayoutMode, logicalWidth: number): 'full' | 'half' {
  if (mode === 'half') return 'half'
  if (mode === 'full' || mode === 'game') return 'full'
  return logicalWidth < HALF_WIDTH_LIMIT ? 'half' : 'full'
}

// ── Плавающие элементы управления ──────────────────────────────
function Controls({
  design,
  onDesign,
  onSettings,
}: {
  design: DesignId
  onDesign: (d: DesignId) => void
  onSettings: () => void
}) {
  return (
    <div className="ui-controls">
      {DESIGNS.map(d => (
        <button
          key={d.id}
          className={d.id === design ? 'ui-pill active' : 'ui-pill'}
          onClick={() => onDesign(d.id)}
          title={d.title}
        >
          {d.id}
        </button>
      ))}
      <span className="ui-sep" />
      <button className="ui-pill" onClick={() => window.ipcRenderer.send('stats-open')} title="Статистика">▤</button>
      <button className="ui-pill" onClick={onSettings} title="Настройки">⚙</button>
      <button className="ui-pill" onClick={() => window.ipcRenderer.send('window-minimize')} title="Свернуть">–</button>
      <button className="ui-pill" onClick={() => window.ipcRenderer.send('window-close')} title="Закрыть">✕</button>
    </div>
  )
}

// ── Приложение ─────────────────────────────────────────────────
export default function App() {
  const { snapshot, history, silentSec } = useTelemetry()
  const [config, patchConfig] = useConfig()

  const stageRef = useRef<HTMLDivElement>(null)
  const box = useStageSize(stageRef)

  // Горячие клавиши: 1/2/3 — вариант дизайна, F2 — настройки, F3 — статистика.
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      patchConfig({ design: DESIGNS[Number(e.key) - 1].id })
    } else if (e.key === 'F2') {
      window.ipcRenderer.send('settings-open')
    } else if (e.key === 'F3') {
      window.ipcRenderer.send('stats-open')
    }
  }, [patchConfig])

  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  const frame = frameGeometry(box)
  const layout = resolveLayout(config?.layout ?? 'auto', frame.width)
  const design = DESIGNS.find(d => d.id === config?.design) ?? DESIGNS[0]

  // До первого пакета бэкенду нужно время на запуск LHM, дальше молчание — уже сбой.
  const stale = snapshot.ready
    ? silentSec >= Math.max(5, (3 * (snapshot.pollMs ?? 1000)) / 1000)
    : silentSec >= 20

  return (
    <div className="app">
      <div className="stage" ref={stageRef}>
        <div
          className="frame"
          style={{
            width: frame.width,
            height: frame.height,
            // zoom, а не transform: scale — масштабируется сама раскладка,
            // без отдельного слоя композитора (иначе после resize остаются
            // куски прошлого кадра) и с чётким текстом
            zoom: frame.scale,
          }}
        >
          {config && design.render({ s: snapshot, h: history, half: layout === 'half' })}
        </div>
      </div>

      {stale && (
        <div className="ui-stale">
          {snapshot.ready ? `ДАННЫЕ УСТАРЕЛИ: ${silentSec} С` : 'НЕТ ДАННЫХ ОТ БЭКЕНДА'} · ПЕРЕЗАПУСК
        </div>
      )}

      <Controls
        design={config?.design ?? DESIGNS[0].id}
        onDesign={d => patchConfig({ design: d })}
        onSettings={() => window.ipcRenderer.send('settings-open')}
      />
    </div>
  )
}
