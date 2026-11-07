import { Metrics } from '../types'
import { col, pct, rateScale, TH, word } from './tokens'

/** Длина кольцевого буфера графиков (≈45 с при опросе 500 мс). */
export const HISTORY_LEN = 90

export interface Snapshot {
  /** false до первого пакета от бэкенда — тогда не пугаем предупреждениями. */
  ready: boolean
  clock: string
  date: string
  uptime: string
  hostname: string
  os: string
  sensorCount: number | null
  pollMs: number | null
  /** Датчики уровня ядра доступны только процессу с правами администратора. */
  elevated: boolean
  sensorSource: string

  cpu: {
    name: string
    load: number
    temp: number | null
    clockGHz: number
    maxCoreTemp: number | null
    minThread: number | null
    cores: number | null
    threadCount: number
    threads: number[]
    /** Мощность пакета, Вт. Датчик живёт в LHM и требует прав администратора. */
    powerW: number | null
  }
  gpu: {
    name: string
    load: number
    temp: number | null
    hotspot: number | null
    coreMHz: number | null
    memMHz: number | null
    fanPct: number | null
    vramUsedGB: number
    vramTotalGB: number
    vramPct: number
    busPct: number | null
    powerW: number | null
    engines: Array<{ name: string; value: number | null }>
  }
  ram: {
    usedGB: number
    totalGB: number
    pct: number
    swapUsedGB: number | null
    swapTotalGB: number | null
    swapPct: number
  }
  disks: Array<{
    name: string
    /** Доля занятого места, %. Скорость чтения/записи — отдельные поля. */
    usedPct: number
    usedGB: number
    freeGB: number | null
    totalGB: number
    readMBs: number
    writeMBs: number
    rw: string
    temp: number | null
    asleep: boolean
  }>
  net: {
    /** «ETHERNET 1G» — тип плюс скорость линка, как в макете. */
    label: string
    /** Имя адаптера, по которому считается трафик. */
    nic: string
    /** Байты в секунду: единицу подписи выбирает `rate()`. */
    downBps: number
    upBps: number
    pingMs: number | null
  }
  fans: Array<{ name: string; rpm: number; pct: number }>
}

/** Общий контракт всех вариантов дизайна. */
export interface DesignProps {
  s: Snapshot
  h: History
  half: boolean
}

export interface History {
  cpuLoad: number[]
  gpuLoad: number[]
  cpuTemp: number[]
  gpuTemp: number[]
  netDown: number[]
  netUp: number[]
}

export function emptyHistory(): History {
  const zeros = () => Array(HISTORY_LEN).fill(0) as number[]
  return { cpuLoad: zeros(), gpuLoad: zeros(), cpuTemp: zeros(), gpuTemp: zeros(), netDown: zeros(), netUp: zeros() }
}

/** Сдвигает кольцевой буфер влево и дописывает новое значение. */
function shift(buf: number[], v: number): number[] {
  const next = buf.slice(1)
  next.push(Number.isFinite(v) ? v : 0)
  return next
}

export function pushHistory(h: History, s: Snapshot): History {
  return {
    cpuLoad: shift(h.cpuLoad, s.cpu.load),
    gpuLoad: shift(h.gpuLoad, s.gpu.load),
    cpuTemp: shift(h.cpuTemp, s.cpu.temp ?? 0),
    gpuTemp: shift(h.gpuTemp, s.gpu.temp ?? 0),
    netDown: shift(h.netDown, s.net.downBps),
    netUp: shift(h.netUp, s.net.upBps),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

const DASH_NIC = '—'

export interface DeviceState {
  label: string
  value: string
  color: string
}

/** Список «норма / тепло / жарко» — используется вариантами 1a и 1b. */
export function deviceStates(s: Snapshot): DeviceState[] {
  const temps = s.disks.map(d => d.temp).filter((t): t is number => t != null)
  const hottestDisk = temps.length ? Math.max(...temps) : null
  return [
    { label: 'Процессор', value: word(s.cpu.temp, TH.cpuTemp), color: col(s.cpu.temp, TH.cpuTemp) },
    { label: 'Видеокарта', value: word(s.gpu.temp, TH.gpuTemp), color: col(s.gpu.temp, TH.gpuTemp) },
    { label: 'Память', value: word(s.ram.pct, TH.ram), color: col(s.ram.pct, TH.ram) },
    { label: 'Накопители', value: word(hottestDisk, TH.diskTemp), color: col(hottestDisk, TH.diskTemp) },
  ]
}

/** Общий потолок сетевых графиков, байт/с — ступенька выше пика. */
export function netMax(down: number[], up: number[]): number {
  return rateScale(down, up)
}

/** «Ethernet» + 1000 Мбит/с → «ETHERNET 1G». */
function netLabel(type: string, linkMbps?: number): string {
  const base = (type || '').toUpperCase()
  if (!linkMbps) return base
  const speed = linkMbps >= 1000
    ? `${Number((linkMbps / 1000).toFixed(1))}G`
    : `${linkMbps}M`
  return `${base} ${speed}`
}

const ENGINE_LABELS: Array<['d3d' | 'encode' | 'decode' | 'copy', string]> = [
  ['d3d', '3D'],
  ['encode', 'ENC'],
  ['decode', 'DEC'],
  ['copy', 'COPY'],
]

/** Приводит сырой JSON бэкенда к неизменяемому снимку для отрисовки. */
export function toSnapshot(m: Metrics, ready = true): Snapshot {
  const now = new Date()
  const threads = m.cpu.per_core ?? []
  const engines = m.gpu.engines

  const fans = m.fans_list?.length
    ? m.fans_list
    : [
        { name: 'ЦП', rpm: m.fans.cpu_rpm, pct: m.fans.cpu_pct },
        { name: 'ГП', rpm: m.fans.gpu_rpm, pct: m.fans.gpu_pct },
      ].filter(f => f.rpm > 0 || f.pct > 0)

  const swapUsed = m.ram.swap_used_gb ?? null
  const swapTotal = m.ram.swap_total_gb ?? null

  return {
    ready,
    clock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    date: `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`,
    uptime: m.system.uptime,
    hostname: m.system.hostname || 'WORKSTATION',
    os: m.system.os,
    sensorCount: m.system.sensor_count ?? null,
    pollMs: m.system.poll_ms ?? null,
    elevated: m.system.elevated ?? false,
    sensorSource: m.system.sensor_source ?? 'none',

    cpu: {
      name: m.cpu.name,
      load: m.cpu.utilization,
      temp: m.cpu.temp_c,
      clockGHz: m.cpu.clock_ghz,
      maxCoreTemp: m.cpu.max_core_temp_c ?? null,
      minThread: threads.length ? Math.min(...threads) : null,
      cores: m.cpu.cores ?? null,
      threadCount: m.cpu.threads,
      threads,
      powerW: m.cpu.power_w ?? null,
    },

    gpu: {
      name: m.gpu.name,
      load: m.gpu.utilization,
      temp: m.gpu.temp_c || null,
      hotspot: m.gpu.hotspot_c ?? null,
      coreMHz: m.gpu.clock_mhz || null,
      memMHz: m.gpu.mem_clock_mhz || null,
      fanPct: m.gpu.fan_pct ?? null,
      vramUsedGB: m.gpu.vram_used_gb,
      vramTotalGB: m.gpu.vram_total_gb,
      vramPct: pct(m.gpu.vram_used_gb, m.gpu.vram_total_gb),
      busPct: m.gpu.bus_pct ?? null,
      powerW: m.gpu.power_w ?? null,
      engines: ENGINE_LABELS.map(([key, name]) => ({ name, value: engines ? engines[key] : null })),
    },

    ram: {
      usedGB: m.ram.used_gb,
      totalGB: m.ram.total_gb,
      pct: m.ram.utilization_pct,
      swapUsedGB: swapUsed,
      swapTotalGB: swapTotal,
      swapPct: swapUsed != null && swapTotal ? pct(swapUsed, swapTotal) : 0,
    },

    disks: m.disks.map(d => ({
      name: d.label,
      usedPct: d.utilization_pct,
      usedGB: d.used_gb,
      // Свободное место: у старого бэкенда поля нет — считаем из занятого.
      freeGB: d.free_gb ?? (d.total_gb ? Math.max(0, d.total_gb - d.used_gb) : null),
      totalGB: d.total_gb,
      readMBs: d.read_speed_mbps,
      writeMBs: d.write_speed_mbps,
      rw: `${Math.round(d.read_speed_mbps)} / ${Math.round(d.write_speed_mbps)}`,
      temp: d.temp_c,
      asleep: Boolean(d.asleep),
    })),

    net: {
      label: netLabel(m.network.type, m.network.link_mbps),
      nic: m.network.interface || DASH_NIC,
      // Запасной путь для бэкенда без байтовых полей: мегабиты → байты.
      downBps: m.network.download_bytes_ps ?? (m.network.download_mbps * 1_000_000) / 8,
      upBps: m.network.upload_bytes_ps ?? (m.network.upload_mbps * 1_000_000) / 8,
      pingMs: m.network.latency_ms || null,
    },

    fans: fans.map(f => ({ name: f.name, rpm: f.rpm, pct: f.pct })),
  }
}
