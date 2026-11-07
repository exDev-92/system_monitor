import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type DesignId = '1a' | '1b' | '1c'
export type LayoutMode = 'auto' | 'full' | 'half' | 'game'

export const DESIGNS: Array<{ id: DesignId; title: string }> = [
  { id: '1a', title: 'Плотный пульт' },
  { id: '1b', title: 'Сетка карточек' },
  { id: '1c', title: 'Индустриальный HUD' },
]

export const LAYOUTS: Array<{ id: LayoutMode; title: string }> = [
  { id: 'auto', title: 'Как есть' },
  { id: 'full', title: 'Весь экран' },
  { id: 'half', title: 'Половина экрана' },
  { id: 'game', title: 'Полноэкранный' },
]

/**
 * Настройки журнала, см. journal.ts.
 */
export interface LogConfig {
  /** Короткий журнал: полная детализация, кольцо на `shortMinutes` минут. */
  short: boolean
  shortMinutes: number
  /** Долгий журнал: агрегат min/avg/max с шагом `longStepSec`. */
  long: boolean
  longStepSec: number
  keepDays: number
  maxTotalMB: number
  /** Сброс на диск: реже — меньше нагрузка, больше потеря при сбое. */
  flushSec: number
  /** Состав колонок: базовый, плюс потоки ЦП, плюс вентиляторы и SMART. */
  columns: 'basic' | 'cores' | 'full'
  /** Сохранять короткий журнал рядом со сбоем, не подпадая под автоочистку. */
  keepIncidents: boolean
  maxIncidents: number
  /** Десятичная запятая: русский Excel иначе читает «5.2» как дату. */
  decimalComma: boolean
}

export interface AppConfig {
  design: DesignId
  layout: LayoutMode
  alwaysOnTop: boolean
  /** Крестик прячет окно в трей вместо выхода. Выход — через меню трея. */
  closeToTray: boolean
  /** Период опроса датчиков. Главная ручка нагрузки на систему. */
  pollMs: number
  /**
   * SMART жёстких дисков: active — только когда к диску и так обращаются,
   * always — на каждом опросе, never — не читать. Спящий диск не будится никогда.
   */
  hddPoll: 'active' | 'always' | 'never'
  log: LogConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  design: '1a',
  layout: 'auto',
  alwaysOnTop: false,
  closeToTray: true,
  pollMs: 1000,
  hddPoll: 'active',
  log: {
    short: true,
    shortMinutes: 60,
    long: true,
    longStepSec: 60,
    keepDays: 180,
    maxTotalMB: 500,
    flushSec: 5,
    columns: 'basic',
    keepIncidents: true,
    maxIncidents: 20,
    decimalComma: true,
  },
}

const POLL_CHOICES = [500, 1000, 2000, 5000]

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Приводит прочитанный JSON к валидному конфигу. Файл правят руками и он
 * переживает смену версий, поэтому каждое поле проверяется по отдельности:
 * мусор в одном ключе не должен ронять остальные настройки.
 */
function normalize(raw: unknown): AppConfig {
  const r = (raw ?? {}) as Partial<AppConfig>
  const log = (r.log ?? {}) as Partial<LogConfig>
  const d = DEFAULT_CONFIG

  return {
    design: pick(r.design, DESIGNS.map(x => x.id), d.design),
    layout: pick(r.layout, LAYOUTS.map(x => x.id), d.layout),
    alwaysOnTop: bool(r.alwaysOnTop, d.alwaysOnTop),
    closeToTray: bool(r.closeToTray, d.closeToTray),
    pollMs: pick(r.pollMs, POLL_CHOICES, d.pollMs),
    hddPoll: pick(r.hddPoll, ['active', 'always', 'never'] as const, d.hddPoll),
    log: {
      short: bool(log.short, d.log.short),
      shortMinutes: int(log.shortMinutes, 5, 1440, d.log.shortMinutes),
      long: bool(log.long, d.log.long),
      longStepSec: int(log.longStepSec, 10, 3600, d.log.longStepSec),
      keepDays: int(log.keepDays, 1, 3650, d.log.keepDays),
      maxTotalMB: int(log.maxTotalMB, 10, 100_000, d.log.maxTotalMB),
      flushSec: int(log.flushSec, 1, 300, d.log.flushSec),
      columns: pick(log.columns, ['basic', 'cores', 'full'] as const, d.log.columns),
      keepIncidents: bool(log.keepIncidents, d.log.keepIncidents),
      maxIncidents: int(log.maxIncidents, 1, 1000, d.log.maxIncidents),
      decimalComma: bool(log.decimalComma, d.log.decimalComma),
    },
  }
}

let current: AppConfig = DEFAULT_CONFIG
let saveTimer: NodeJS.Timeout | null = null

export function loadConfig(): AppConfig {
  try {
    current = normalize(JSON.parse(fs.readFileSync(configPath(), 'utf-8')))
  } catch {
    // Файла нет при первом запуске, а битый JSON не повод терять приложение.
    current = DEFAULT_CONFIG
  }
  return current
}

export function getConfig(): AppConfig {
  return current
}

/** Запись через временный файл: обрыв питания не оставит обрезанный config.json. */
function writeNow() {
  const file = configPath()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('[config] не удалось сохранить:', err)
  }
}

/** Склейка на один уровень вложенности — глубже структура не уходит. */
export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  current = normalize({ ...current, ...patch, log: { ...current.log, ...(patch.log ?? {}) } })

  // Настройки меняются щелчками в интерфейсе — пишем пачкой, а не на каждый клик.
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; writeNow() }, 400)
  return current
}

/** Принудительный сброс перед выходом: отложенная запись не успела бы. */
export function flushConfig() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  writeNow()
}
