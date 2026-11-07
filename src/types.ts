export interface CpuData {
  name: string
  utilization: number
  clock_ghz: number
  threads: number
  cores?: number
  temp_c: number | null
  max_core_temp_c?: number | null
  power_w?: number | null
  history: number[]
  per_core: number[]
}

export interface GpuEngines {
  d3d: number | null
  encode: number | null
  decode: number | null
  copy: number | null
}

export interface GpuData {
  name: string
  utilization: number
  clock_ghz: number
  clock_mhz: number
  mem_clock_mhz: number
  vram_used_gb: number
  vram_total_gb: number
  temp_c: number
  hotspot_c?: number | null
  bus_pct?: number | null
  power_w: number
  /** null — датчика нет; 0 — вентиляторы стоят (пассивный режим). */
  fan_pct: number | null
  engines?: GpuEngines
  history: number[]
}

export interface RamData {
  utilization_pct: number
  used_gb: number
  total_gb: number
  speed_mhz: number
  slots_used: number
  slots_total: number
  committed_gb: number
  swap_used_gb?: number
  swap_total_gb?: number
  temp_c?: number | null
}

export interface DiskData {
  label: string
  model: string
  used_gb: number
  free_gb?: number
  total_gb: number
  utilization_pct: number
  read_speed_mbps: number
  write_speed_mbps: number
  temp_c: number | null
  life_pct?: number | null
  kind?: 'hdd' | 'ssd' | null
  /** Жёсткий диск остановлен: его не опрашивают, температуры нет. */
  asleep?: boolean
  power_on_hours?: number | null
  health: string
}

export interface NetworkData {
  status: string
  type: string
  interface?: string
  link_mbps?: number
  download_mbps: number
  upload_mbps: number
  /** Байты в секунду — точный источник для КБ/с и МБ/с в интерфейсе. */
  download_bytes_ps?: number
  upload_bytes_ps?: number
  latency_ms: number
  ip: string
  signal: string
}

export interface PowerData {
  status: string
  charging: boolean
  battery_pct: number
  power_plan: string
  estimated_time: string
  voltage_v: number
  current_a: number
  power_w: number
}

/** Устаревшая форма: два вентилятора. Оставлена для обратной совместимости. */
export interface FansData {
  cpu_rpm: number
  cpu_pct: number
  gpu_rpm: number
  gpu_pct: number
}

export interface FanEntry {
  name: string
  rpm: number
  pct: number
}

export interface SystemData {
  os: string
  hostname?: string
  motherboard: string
  uptime: string
  sensor_count?: number | null
  /** 'embedded' — встроенная LibreHardwareMonitorLib, 'wmi' — внешний LHM, 'none' — нет. */
  sensor_source?: string
  elevated?: boolean
  poll_ms?: number
  last_updated: string
}

export interface SmartData {
  overall: string
  reallocated_sectors: number
  power_on_hours: number
  temp_c: number
  drive_status: string
}

export interface SummaryData {
  healthy: boolean
  total_uptime: string
  total_data_read_tb: number
  total_data_written_gb: number
}

export interface Metrics {
  cpu: CpuData
  gpu: GpuData
  ram: RamData
  disks: DiskData[]
  network: NetworkData
  power: PowerData
  fans: FansData
  fans_list?: FanEntry[]
  system: SystemData
  smart: SmartData
  summary: SummaryData
}
