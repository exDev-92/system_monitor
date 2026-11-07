import { useEffect, useState } from 'react'
import './settings.css'
import type { DesignId, LayoutMode, LogConfig } from '../../electron/config'
import type { AutostartStatus } from '../../electron/autostart'
import { Metrics } from '../types'
import { useConfig } from './useConfig'

const DESIGNS: Array<{ id: DesignId; title: string; hint: string }> = [
  { id: '1a', title: 'Плотный пульт', hint: 'кольцевые датчики, много мелких цифр' },
  { id: '1b', title: 'Сетка карточек', hint: 'спокойно, воздуха больше, крупные значения' },
  { id: '1c', title: 'Индустриальный HUD', hint: 'круглые датчики и шкалы, узкая гарнитура' },
]

const LAYOUTS: Array<{ id: LayoutMode; title: string; hint: string }> = [
  { id: 'auto', title: 'Как есть', hint: 'макет по текущему размеру окна' },
  { id: 'full', title: 'Весь экран', hint: 'рабочая область, панель задач видна' },
  { id: 'half', title: 'Половина экрана', hint: 'правая половина, панель задач видна' },
  { id: 'game', title: 'Полноэкранный', hint: 'поверх панели задач и всех окон' },
]

const POLL_CHOICES = [
  { ms: 500, title: '0,5 с — выше нагрузка' },
  { ms: 1000, title: '1 с' },
  { ms: 2000, title: '2 с' },
  { ms: 5000, title: '5 с — ниже нагрузка' },
]

/**
 * Значение уходит в конфиг по Enter или потере фокуса: главный процесс зажимает
 * его в границы, и на каждую цифру набираемое «50» превращалось бы в минимум.
 */
function NumberField({ label, value, min, max, disabled, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <label className={disabled ? 'ui-field off' : 'ui-field'}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit() }}
      />
    </label>
  )
}

function Toggle({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className={disabled ? 'ui-row off' : 'ui-row'}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
    </label>
  )
}

/** Последний пакет метрик и все следующие. */
function useMetrics(): Metrics | null {
  const [m, setM] = useState<Metrics | null>(null)

  useEffect(() => {
    let alive = true
    window.ipcRenderer.invoke('metrics:latest').then((data: Metrics | null) => {
      if (alive && data) setM(data)
    })
    const onMetrics = (_e: unknown, data: Metrics) => setM(data)
    window.ipcRenderer.on('metrics', onMetrics)
    return () => {
      alive = false
      window.ipcRenderer.off('metrics', onMetrics)
    }
  }, [])

  return m
}

/** Драйвер PawnIO: без него нет температур, вентиляторов и SMART. */
function Pawnio() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')

  useEffect(() => {
    window.ipcRenderer.invoke('pawnio:status').then(setInstalled)
  }, [])

  if (installed !== false) return null

  const install = async () => {
    setState('busy')
    await window.ipcRenderer.invoke('pawnio:install')
    const now: boolean = await window.ipcRenderer.invoke('pawnio:status')
    setInstalled(now)
    setState(now ? 'done' : 'failed')
  }

  if (state === 'done') {
    return (
      <>
        <div className="ui-hint">PawnIO установлен. Датчики заработают после перезапуска приложения.</div>
        <button className="ui-btn" onClick={() => window.ipcRenderer.send('app-restart-elevated')}>Перезапустить</button>
      </>
    )
  }

  return (
    <>
      <div className="ui-warn">
        Не установлен драйвер PawnIO: температуры, вентиляторы, мощность процессора и SMART
        недоступны.
      </div>
      <button className="ui-btn" disabled={state === 'busy'} onClick={install}>
        {state === 'busy' ? 'Установка… следуйте окну установщика' : 'Скачать и установить PawnIO'}
      </button>
      <div className="ui-hint">
        {state === 'failed'
          ? 'Установка не завершилась. Можно поставить вручную с pawnio.eu.'
          : 'Установщик загрузится со страницы автора (github.com/namazso), подпись проверяется перед запуском.'}
      </div>
    </>
  )
}

/** Состояние источника датчиков — объясняет прочерки вместо температур. */
function SensorStatus() {
  const m = useMetrics()

  let body
  if (!m) {
    body = <div className="ui-hint">Ожидание данных от бэкенда…</div>
  } else if (!m.system.elevated) {
    // Без прав администратора PawnIO не отдаёт значения вообще
    body = (
      <>
        <div className="ui-warn">
          Нет прав администратора: температуры, обороты вентиляторов, мощность ЦП и SMART
          недоступны — PawnIO не отдаёт их обычному процессу.
        </div>
        <button className="ui-btn" onClick={() => window.ipcRenderer.send('app-restart-elevated')}>
          Перезапустить от администратора
        </button>
      </>
    )
  } else if (m.system.sensor_source === 'none') {
    body = (
      <div className="ui-warn">
        Библиотека датчиков не открылась. Установите PawnIO: <code>winget install PawnIO</code>
      </div>
    )
  } else if (m.cpu.temp_c == null) {
    // Права есть, библиотека открыта, но датчики молчат — обычно нет драйвера PawnIO
    body = (
      <>
        <div className="ui-warn">
          Датчиков уровня ядра нет: температуры ЦП, обороты вентиляторов и частоты
          недоступны. Установите драйвер: <code>winget install PawnIO</code>, затем
          перезапустите приложение.
        </div>
        <div className="ui-hint">Загрузка, память, диски и сеть при этом работают.</div>
      </>
    )
  } else {
    body = (
      <div className="ui-hint">
        Активны: {m.system.sensor_count ?? 0} шт.
        {m.system.sensor_source === 'embedded'
          ? ' Встроенная LibreHardwareMonitorLib через PawnIO.'
          : ' Внешний LibreHardwareMonitor через WMI.'}
      </div>
    )
  }

  return (
    <div className="ui-group">
      <div className="ui-group-title">Датчики</div>
      <Pawnio />
      {body}
    </div>
  )
}

const HDD_CHOICES: Array<{ id: 'active' | 'always' | 'never'; title: string }> = [
  { id: 'active', title: 'Когда диск и так работает' },
  { id: 'always', title: 'Каждый опрос' },
  { id: 'never', title: 'Не читать' },
]

function HddSettings({ value, onChange }: { value: 'active' | 'always' | 'never'; onChange: (v: 'active' | 'always' | 'never') => void }) {
  const m = useMetrics()
  const hdds = (m?.disks ?? []).filter(d => d.kind === 'hdd')
  const list = hdds.map(d => `${d.label.slice(0, 2)}${d.asleep ? ' (спит)' : ''}`).join(', ')

  return (
    <>
      <label className="ui-field">
        <span>Температура и SMART жёстких дисков</span>
        <select value={value} onChange={e => onChange(e.target.value as 'active' | 'always' | 'never')}>
          {HDD_CHOICES.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </label>
      <div className="ui-hint">
        Чтение SMART выполняет сам диск, поэтому частый опрос не даёт ему уснуть и щёлкает головками.
        «Когда диск и так работает» — читать не чаще раза в 5 минут и только если к диску обращаются
        другие программы. Остановленный диск не будится ни в одном режиме. SSD это не касается.
      </div>
      <div className="ui-hint">
        {m ? (hdds.length ? `Жёсткие диски: ${list}.` : 'Жёстких дисков не найдено.') : ''}
        {' '}Диск засыпает сам, если в Windows включено «Отключать жёсткий диск через…» (Электропитание).
      </div>
    </>
  )
}

function Autostart() {
  const [status, setStatus] = useState<AutostartStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.ipcRenderer.invoke('autostart:get').then(setStatus)
  }, [])

  const change = async (enable: boolean) => {
    setBusy(true)
    setStatus(await window.ipcRenderer.invoke('autostart:set', enable))
    setBusy(false)
  }

  return (
    <>
      <Toggle
        label="Запускать при входе в Windows"
        checked={status?.enabled ?? false}
        disabled={!status || !status.canChange || busy}
        onChange={change}
      />
      <div className="ui-hint">
        Приложение стартует скрытым, в трее. Окно открывается щелчком по значку.
      </div>
      {status && !status.canChange && (
        <div className="ui-hint">Изменить можно только при запуске от администратора.</div>
      )}
      {status?.error && <div className="ui-warn">{status.error}</div>}
    </>
  )
}

/** Прикидка по замеренным строкам: около 120 байт в коротком журнале, 450 — в долгом. */
function estimate(log: LogConfig): string {
  const factor = { basic: 1, cores: 1.3, full: 1.5 }[log.columns]
  const shortMB = log.short ? (0.5 * factor * log.shortMinutes) / 60 : 0
  const longMB = log.long ? ((0.7 * factor * 60) / log.longStepSec) * log.keepDays : 0
  const total = shortMB + longMB
  const text = `Примерный объём: ${total < 10 ? total.toFixed(1) : Math.round(total)} МБ.`
  return total > log.maxTotalMB
    ? `${text} Это больше лимита: самые старые файлы будут удаляться раньше срока.`
    : text
}

function LogSettings({ log, onChange }: { log: LogConfig; onChange: (patch: Partial<LogConfig>) => void }) {
  const [dir, setDir] = useState('')
  const [size, setSize] = useState<number | null>(null)
  useEffect(() => {
    window.ipcRenderer.invoke('log:dir').then(setDir)
    window.ipcRenderer.invoke('log:size').then(setSize)
  }, [])

  return (
    <div className="ui-group">
      <div className="ui-group-title">Журнал</div>
      <Toggle
        label="Короткий журнал — каждый опрос, полная детализация"
        checked={log.short}
        onChange={short => onChange({ short })}
      />
      <NumberField
        label="Хранить последние, минут"
        value={log.shortMinutes} min={5} max={1440} disabled={!log.short}
        onCommit={shortMinutes => onChange({ shortMinutes })}
      />

      <Toggle
        label="Долгий журнал — минимум, среднее и максимум за период"
        checked={log.long}
        onChange={long => onChange({ long })}
      />
      <NumberField
        label="Период усреднения, секунд"
        value={log.longStepSec} min={10} max={3600} disabled={!log.long}
        onCommit={longStepSec => onChange({ longStepSec })}
      />
      <NumberField
        label="Хранить, дней"
        value={log.keepDays} min={1} max={3650} disabled={!log.long}
        onCommit={keepDays => onChange({ keepDays })}
      />

      <NumberField
        label="Лимит папки журнала, МБ"
        value={log.maxTotalMB} min={10} max={100000}
        onCommit={maxTotalMB => onChange({ maxTotalMB })}
      />
      <label className="ui-field">
        <span>Состав данных</span>
        <select
          value={log.columns}
          onChange={e => onChange({ columns: e.target.value as LogConfig['columns'] })}
        >
          <option value="basic">Основное</option>
          <option value="cores">+ потоки ЦП</option>
          <option value="full">+ вентиляторы, SMART</option>
        </select>
      </label>
      <NumberField
        label="Сброс на диск, секунд (столько можно потерять при сбое)"
        value={log.flushSec} min={1} max={300}
        onCommit={flushSec => onChange({ flushSec })}
      />

      <Toggle
        label="Сохранять записи вокруг сбоя отдельно от автоочистки"
        checked={log.keepIncidents}
        onChange={keepIncidents => onChange({ keepIncidents })}
      />
      <NumberField
        label="Хранить сбоев"
        value={log.maxIncidents} min={1} max={1000} disabled={!log.keepIncidents}
        onCommit={maxIncidents => onChange({ maxIncidents })}
      />

      <Toggle
        label="Десятичная запятая (для русского Excel)"
        checked={log.decimalComma}
        onChange={decimalComma => onChange({ decimalComma })}
      />

      <div className="ui-hint">
        {estimate(log)}
        {size != null && ` Сейчас занято: ${(size / 1048576).toFixed(1)} МБ.`}
      </div>
      <div className="ui-path">{dir}</div>
      <div className="ui-buttons">
        <button className="ui-btn" onClick={() => window.ipcRenderer.send('log:open-folder')}>
          Открыть папку
        </button>
      </div>
    </div>
  )
}

export default function SettingsApp() {
  const [config, patch] = useConfig()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!config) return null

  return (
    <div className="ui-settings">
      <SensorStatus />

      <div className="ui-group">
        <div className="ui-group-title">Запуск и трей</div>
        <Autostart />
        <Toggle
          label="Крестик сворачивает в трей"
          checked={config.closeToTray}
          onChange={closeToTray => patch({ closeToTray })}
        />
        <div className="ui-hint">
          {config.closeToTray
            ? 'Приложение продолжает работать в трее. Выход — через меню значка.'
            : 'Крестик закрывает приложение полностью.'}
        </div>
      </div>

      <div className="ui-group">
        <div className="ui-group-title">Вариант дизайна</div>
        {DESIGNS.map(d => (
          <button
            key={d.id}
            className={d.id === config.design ? 'ui-choice active' : 'ui-choice'}
            onClick={() => patch({ design: d.id })}
          >
            <span className="ui-choice-id">{d.id}</span>
            <span className="ui-choice-text">
              <b>{d.title}</b>
              <i>{d.hint}</i>
            </span>
          </button>
        ))}
      </div>

      <div className="ui-group">
        <div className="ui-group-title">Режим окна</div>
        <div className="ui-choices">
          {LAYOUTS.map(l => (
            <button
              key={l.id}
              className={l.id === config.layout ? 'ui-choice active' : 'ui-choice'}
              onClick={() => patch({ layout: l.id })}
            >
              <span className="ui-choice-text">
                <b>{l.title}</b>
                <i>{l.hint}</i>
              </span>
            </button>
          ))}
        </div>
        <Toggle
          label="Поверх всех окон"
          checked={config.alwaysOnTop || config.layout === 'game'}
          disabled={config.layout === 'game'}
          onChange={alwaysOnTop => patch({ alwaysOnTop })}
        />
      </div>

      <div className="ui-group">
        <div className="ui-group-title">Опрос датчиков</div>
        <label className="ui-field">
          <span>Период</span>
          <select
            value={config.pollMs}
            onChange={e => patch({ pollMs: Number(e.target.value) })}
          >
            {POLL_CHOICES.map(c => <option key={c.ms} value={c.ms}>{c.title}</option>)}
          </select>
        </label>
        <div className="ui-hint">
          Главная настройка нагрузки на систему. От неё же зависит детализация журнала.
        </div>
        <HddSettings value={config.hddPoll} onChange={hddPoll => patch({ hddPoll })} />
      </div>

      <LogSettings log={config.log} onChange={log => patch({ log: { ...config.log, ...log } })} />
    </div>
  )
}
