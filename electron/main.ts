import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, shell, Tray } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  AppConfig, DESIGNS, DesignId, flushConfig, getConfig, LayoutMode, loadConfig, patchConfig,
} from './config'
import { getAutostart, HIDDEN_ARG, setAutostart } from './autostart'
import { journalSize, logEvent, startJournal, stopJournal, syncJournal, writeMetrics } from './journal'
import { queryStats } from './stats'
import type { Metrics } from '../src/types'

// Имя задаёт папку userData. Латиницей — чтобы config.json и будущий журнал
// лежали в %APPDATA%\PCMonitor, а не в пути с кириллицей.
app.setName('PCMonitor')
app.setAppUserModelId('ru.erthat.pcmonitor')

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let statsWin: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null

/** Настоящий выход, а не сворачивание в трей. */
let quitting = false

/** Последний пакет метрик — им дорисовывается окно сразу после показа. */
let latestMetrics: Record<string, unknown> | null = null

/** Запуск из планировщика: окно создаётся, но не показывается. */
const startHidden = process.argv.includes(HIDDEN_ARG)

// Задержки перезапуска бэкенда, секунды. Счётчик сбрасывает первый же пакет.
const RESTART_DELAYS = [1, 2, 5, 15, 30]
let restartAttempt = 0
let restartTimer: NodeJS.Timeout | null = null

/** Молчание дольше этого считаем зависанием: первый опрос LHM занимает секунды. */
const BACKEND_SILENCE_MS = 30_000
let lastPacketAt = 0

function logDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function openLogFolder() {
  fs.mkdirSync(logDir(), { recursive: true })
  void shell.openPath(logDir())
}

/** В сборке бэкенд лежит в resources/backend, в разработке — в корне проекта. */
function backendDir(): string {
  return VITE_DEV_SERVER_URL
    ? path.join(process.env.APP_ROOT!, 'backend')
    : path.join(process.resourcesPath, 'backend')
}

/**
 * Собранный бэкенд (PyInstaller) не требует установленного Python.
 * Если его нет — падаем на исходник, это путь разработки.
 */
function backendCommand(dir: string): { file: string; args: string[]; cwd: string } {
  const packed = path.join(dir, 'sysmon-backend', 'sysmon-backend.exe')
  if (fs.existsSync(packed)) {
    return { file: packed, args: [], cwd: path.dirname(packed) }
  }

  const localPacked = path.join(dir, 'dist', 'sysmon-backend', 'sysmon-backend.exe')
  if (fs.existsSync(localPacked)) {
    return { file: localPacked, args: [], cwd: path.dirname(localPacked) }
  }

  // cwd = папка бэкенда, чтобы monitor.py находил соседний lhm.py
  return { file: 'python', args: [path.join(dir, 'monitor.py')], cwd: dir }
}

/** Единственная точка, через которую проходит каждый пакет метрик. */
function handleMetrics(metrics: Record<string, unknown>) {
  latestMetrics = metrics
  lastPacketAt = Date.now()
  restartAttempt = 0
  updateTrayTooltip(metrics)
  writeMetrics(metrics as unknown as Metrics)

  // Скрытому окну слать нечего: renderer не рисует, а сериализация IPC
  // и перерисовка React — основная цена работы в трее.
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.webContents.send('metrics', metrics)
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('metrics', metrics)
  }
}

function startPython() {
  const dir = backendDir()
  const { file, args, cwd } = backendCommand(dir)

  const cfg = getConfig()
  const proc = spawn(file, [...args, '--poll-ms', String(cfg.pollMs), '--hdd-poll', cfg.hddPoll], { cwd })
  pythonProcess = proc
  lastPacketAt = Date.now()

  let buffer = ''

  proc.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        handleMetrics(JSON.parse(trimmed))
      } catch {
        // ignore malformed lines
      }
    }
  })

  proc.stderr?.on('data', (data: Buffer) => {
    console.error('[Python]', data.toString().trim())
  })

  proc.on('error', (err: Error) => {
    console.error('[Python] Failed to start:', err.message)
  })

  proc.on('close', (code: number | null) => {
    console.log('[Python] Process exited with code', code)
    if (pythonProcess === proc) logEvent('backend', `завершился, код ${code}`)
    // stopPython уже обнулил ссылку: остановка намеренная, перезапускать незачем.
    if (pythonProcess !== proc) return
    pythonProcess = null
    scheduleBackendRestart()
  })
}

function stopPython() {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (pythonProcess) {
    const proc = pythonProcess
    pythonProcess = null
    proc.kill()
  }
}

function scheduleBackendRestart() {
  if (quitting || restartTimer) return
  const delay = RESTART_DELAYS[Math.min(restartAttempt, RESTART_DELAYS.length - 1)]
  restartAttempt += 1
  logEvent('backend', `перезапуск через ${delay} с, попытка ${restartAttempt}`)
  console.error(`[Python] перезапуск через ${delay} с, попытка ${restartAttempt}`)
  tray?.setToolTip('Мониторинг ПК\nБэкенд не отвечает, перезапуск…')
  restartTimer = setTimeout(() => {
    restartTimer = null
    startPython()
  }, delay * 1000)
}

/** Живой, но молчащий процесс сам не упадёт: его нужно снять, дальше сработает перезапуск. */
function watchBackend() {
  let lastTick = Date.now()
  setInterval(() => {
    // Таймер не тикал — компьютер спал. Молчание бэкенда за это время не его вина.
    if (Date.now() - lastTick > 15_000) lastPacketAt = Date.now()
    lastTick = Date.now()

    if (pythonProcess && Date.now() - lastPacketAt > BACKEND_SILENCE_MS) {
      console.error('[Python] нет данных, процесс снимается')
      logEvent('backend', 'нет данных 30 с, процесс снят')
      lastPacketAt = Date.now()
      pythonProcess.kill()
    }
  }, 5000)
}

/**
 * Пресеты размера окна:
 *   full — рабочая область (панель задач видна), на Full HD это 1920×1040
 *   half — правая половина рабочей области, 960×1040
 *   game — весь экран поверх панели задач, 1920×1080
 */
type Preset = 'full' | 'half' | 'game'

function presetBounds(preset: Preset) {
  const display = win
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()

  if (preset === 'game') {
    return { ...display.bounds }
  }

  const area = display.workArea
  const width = preset === 'full' ? area.width : Math.round(area.width / 2)
  return {
    x: preset === 'half' ? area.x + area.width - width : area.x,
    y: area.y,
    width,
    height: area.height,
  }
}

function applyPreset(preset: Preset, alwaysOnTop: boolean) {
  if (!win || win.isDestroyed()) return
  if (win.isMaximized()) win.unmaximize()

  // Игровой режим перекрывает панель задач: обычного «поверх всех» мало,
  // нужен уровень screen-saver.
  if (preset === 'game') {
    win.setAlwaysOnTop(true, 'screen-saver')
  } else {
    win.setAlwaysOnTop(alwaysOnTop)
  }

  win.setBounds(presetBounds(preset))
}

/** Применяет к окну всё, что задаёт конфиг: размер и «поверх всех окон». */
function applyWindowConfig(cfg: AppConfig) {
  if (!win || win.isDestroyed()) return
  if (cfg.layout === 'auto') {
    win.setAlwaysOnTop(cfg.alwaysOnTop)
  } else {
    applyPreset(cfg.layout as Preset, cfg.alwaysOnTop)
  }
  scheduleRepaint()
}

/**
 * После изменения размера окна Chromium иногда оставляет в растре куски
 * предыдущего кадра (они переживают даже перезагрузку страницы).
 * Принудительная инвалидация заставляет перерисовать всё содержимое.
 */
function scheduleRepaint() {
  if (!win || win.isDestroyed()) return
  win.webContents.invalidate()
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.invalidate()
  }, 120)
}

function iconPath(): string {
  return path.join(process.env.VITE_PUBLIC!, 'icon.ico')
}

function createWindow(visible = true) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: Math.min(1920, sw),
    height: Math.min(1040, sh),
    minWidth: 640,
    minHeight: 480,
    frame: false,
    title: 'Мониторинг ПК',
    icon: iconPath(),
    show: false,
    backgroundColor: '#0a0b0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.once('ready-to-show', () => {
    if (visible) win?.show()
  })

  win.webContents.on('did-finish-load', () => {
    applyWindowConfig(getConfig())
  })

  // Выключение компьютера: Windows закрывает окна, и прятать их в трей нельзя —
  // отменённое закрытие задержало бы завершение работы системы.
  win.on('session-end', () => {
    quitting = true
    stopPython()
    flushConfig()
    stopJournal('завершение работы Windows')
  })

  win.on('closed', () => {
    win = null
    // Окно настроек не должно удерживать приложение после настоящего выхода.
    if (quitting) app.quit()
  })

  win.on('resize', scheduleRepaint)
  win.on('resized', scheduleRepaint)

  // Крестик прячет окно в трей, пока это включено в настройках.
  win.on('close', event => {
    if (quitting || !getConfig().closeToTray) {
      // Галка снята — крестик означает настоящий выход, иначе приложение
      // осталось бы жить без окна, одним значком в трее.
      quitting = true
      return
    }
    event.preventDefault()
    win?.hide()
  })

  win.on('show', () => {
    // Пока окно было скрыто, метрики ему не слались — дорисовываем последним пакетом.
    if (latestMetrics && win && !win.isDestroyed()) {
      win.webContents.send('metrics', latestMetrics)
    }
    refreshTrayMenu()
  })
  win.on('hide', refreshTrayMenu)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// ── Трей ───────────────────────────────────────────────────────

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  else showWindow()
}

/** Настройки не должны оказаться под панелью, закреплённой поверх всех окон. */
function syncSettingsOnTop() {
  const cfg = getConfig()
  for (const w of [settingsWin, statsWin]) {
    if (!w || w.isDestroyed()) continue
    if (cfg.alwaysOnTop || cfg.layout === 'game') {
      w.setAlwaysOnTop(true, 'screen-saver', 1)
    } else {
      w.setAlwaysOnTop(false)
    }
  }
}

/**
 * Отдельное окно: открывается из трея, не разворачивая панель мониторинга.
 * Тот же бандл, что и у панели, — что рисовать, решает хеш адреса.
 * При закрытии окно выгружается целиком и памяти в фоне не занимает.
 */
function createChildWindow(opts: {
  hash: string
  title: string
  width: number
  height: number
  minWidth: number
  minHeight: number
  background: string
}): BrowserWindow {
  const anchor = win && !win.isDestroyed() && win.isVisible()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = anchor.workArea
  const width = Math.min(opts.width, area.width)
  const height = Math.min(opts.height, area.height)

  const child = new BrowserWindow({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
    minWidth: opts.minWidth,
    minHeight: opts.minHeight,
    show: false,
    title: opts.title,
    icon: iconPath(),
    autoHideMenuBar: true,
    backgroundColor: opts.background,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  child.setMenu(null)
  child.once('ready-to-show', () => child.show())

  if (VITE_DEV_SERVER_URL) {
    child.loadURL(`${VITE_DEV_SERVER_URL}#${opts.hash}`)
  } else {
    child.loadFile(path.join(RENDERER_DIST, 'index.html'), { hash: opts.hash })
  }
  return child
}

function raise(w: BrowserWindow) {
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    raise(settingsWin)
    return
  }
  settingsWin = createChildWindow({
    hash: 'settings',
    title: 'Настройки — Мониторинг ПК',
    width: 760,
    height: 820,
    minWidth: 560,
    minHeight: 420,
    background: '#121314',
  })
  settingsWin.on('closed', () => { settingsWin = null })
  syncSettingsOnTop()
}

function openStats() {
  if (statsWin && !statsWin.isDestroyed()) {
    raise(statsWin)
    return
  }
  statsWin = createChildWindow({
    hash: 'stats',
    title: 'Статистика — Мониторинг ПК',
    width: 1400,
    height: 960,
    minWidth: 820,
    minHeight: 500,
    background: '#101112',
  })
  statsWin.on('closed', () => { statsWin = null })
  syncSettingsOnTop()
}

function applyConfig(patch: Partial<AppConfig>) {
  const prev = getConfig()
  const next = patchConfig(patch)

  // Геометрию трогаем, только если она и менялась: иначе смена варианта
  // дизайна дёргала бы окно и вызывала лишнюю перерисовку.
  if (next.layout !== prev.layout || next.alwaysOnTop !== prev.alwaysOnTop) {
    applyWindowConfig(next)
    syncSettingsOnTop()
  }
  // Новый период опроса бэкенд получает только при запуске.
  if ((next.pollMs !== prev.pollMs || next.hddPoll !== prev.hddPoll) && (pythonProcess || restartTimer)) {
    stopPython()
    startPython()
  }
  // Трей и интерфейс читают одно и то же состояние, кто бы его ни поменял.
  refreshTrayMenu()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('config:changed', next)
  }
  return next
}

function trayMenu(): Menu {
  const cfg = getConfig()
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible())

  return Menu.buildFromTemplate([
    { label: visible ? 'Скрыть окно' : 'Показать окно', click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Вариант дизайна',
      submenu: DESIGNS.map(d => ({
        label: `${d.id}  ${d.title}`,
        type: 'radio' as const,
        checked: cfg.design === d.id,
        click: () => applyConfig({ design: d.id }),
      })),
    },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: cfg.alwaysOnTop || cfg.layout === 'game',
      enabled: cfg.layout !== 'game',
      click: () => applyConfig({ alwaysOnTop: !cfg.alwaysOnTop }),
    },
    {
      label: 'Крестик сворачивает в трей',
      type: 'checkbox',
      checked: cfg.closeToTray,
      click: () => applyConfig({ closeToTray: !cfg.closeToTray }),
    },
    { type: 'separator' },
    { label: 'Статистика…', click: openStats },
    { label: 'Настройки…', click: openSettings },
    { label: 'Открыть папку журнала', click: openLogFolder },
    { label: 'Выход', click: () => { quitting = true; app.quit() } },
  ])
}

function refreshTrayMenu() {
  tray?.setContextMenu(trayMenu())
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('Мониторинг ПК')
  tray.on('click', toggleWindow)
  tray.on('double-click', showWindow)
  refreshTrayMenu()
}

let tooltipAt = 0

/** Подсказка трея — единственное, что видно, когда окно спрятано. */
function updateTrayTooltip(metrics: Record<string, unknown>) {
  const now = Date.now()
  if (!tray || now - tooltipAt < 3000) return
  tooltipAt = now

  const cpu = metrics.cpu as { utilization?: number; temp_c?: number | null } | undefined
  const gpu = metrics.gpu as { utilization?: number; temp_c?: number | null } | undefined
  const ram = metrics.ram as { utilization_pct?: number } | undefined

  const part = (name: string, load?: number, temp?: number | null) => {
    const head = `${name} ${Math.round(load ?? 0)}%`
    return temp ? `${head} · ${Math.round(temp)}°` : head
  }

  tray.setToolTip([
    'Мониторинг ПК',
    `${part('ЦП', cpu?.utilization, cpu?.temp_c)}   ${part('ГП', gpu?.utilization, gpu?.temp_c)}`,
    `ОЗУ ${Math.round(ram?.utilization_pct ?? 0)}%`,
  ].join('\n'))
}

// ── IPC ────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => getConfig())
ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => applyConfig(patch ?? {}))

ipcMain.handle('metrics:latest', () => latestMetrics)
ipcMain.handle('autostart:get', () => getAutostart())
ipcMain.handle('autostart:set', (_e, enable: boolean) => setAutostart(Boolean(enable)))
ipcMain.handle('log:dir', () => logDir())
ipcMain.handle('log:size', () => journalSize())
ipcMain.on('log:open-folder', openLogFolder)

ipcMain.handle('stats:query', (_e, req: { from: number; to: number; points: number }) => queryStats(logDir(), req))
ipcMain.on('log:open-incidents', () => {
  const dir = path.join(logDir(), 'incidents')
  fs.mkdirSync(dir, { recursive: true })
  void shell.openPath(dir)
})

/** Служба драйвера PawnIO: есть ключ в реестре — драйвер установлен. */
ipcMain.handle('pawnio:status', () => new Promise<boolean>(resolve => {
  execFile('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\PawnIO'], { windowsHide: true }, err => resolve(!err))
}))

ipcMain.handle('pawnio:install', () => new Promise<number>(resolve => {
  const script = VITE_DEV_SERVER_URL
    ? path.join(process.env.APP_ROOT!, 'build', 'pawnio-install.ps1')
    : path.join(process.resourcesPath, 'pawnio-install.ps1')
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
    { windowsHide: true },
    err => resolve(err ? Number((err as { code?: number }).code ?? 1) : 0),
  )
}))

ipcMain.on('settings-open', openSettings)
ipcMain.on('stats-open', openStats)
ipcMain.on('window-minimize', () => win?.minimize())
ipcMain.on('window-maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('window-close', () => win?.close())

/**
 * Перезапуск с повышением прав: без них PawnIO не отдаёт температуры,
 * обороты вентиляторов и SMART. Права нельзя получить в текущем процессе —
 * только запустив новый через ShellExecute с глаголом runas.
 */
ipcMain.on('app-restart-elevated', () => {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
  const args = process.defaultApp ? process.argv.slice(1) : []
  const argList = args.length
    ? ` -ArgumentList ${args.map(quote).join(',')}`
    : ''

  try {
    spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
       // Пауза нужна из-за блокировки одиночного экземпляра: новый процесс
       // должен стартовать после того, как текущий отпустит её, выйдя.
       `Start-Sleep -Milliseconds 900; Start-Process -FilePath ${quote(process.execPath)}${argList} -Verb RunAs`],
      { detached: true, stdio: 'ignore' },
    ).unref()
  } catch (err) {
    console.error('[elevate] failed:', err)
    return
  }

  quitting = true
  stopPython()
  app.quit()
})

// ── Жизненный цикл ─────────────────────────────────────────────

app.on('window-all-closed', () => {
  // В трее окон нет вовсе — выходим только когда выход затребован явно.
  if (process.platform === 'darwin' || !quitting) return
  stopPython()
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  stopPython()
  flushConfig()
  stopJournal('штатный выход')
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Второй запуск не должен поднимать второй бэкенд — он просто показывает окно.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(() => {
    // Тёмная рамка у окна настроек: панель мониторинга рамки не имеет.
    nativeTheme.themeSource = 'dark'
    loadConfig()
    startJournal(logDir())
    // Блокировка запись не останавливает, а сон замораживает всё: журнал отмечает разрыв.
    powerMonitor.on('lock-screen', () => logEvent('session', 'экран заблокирован'))
    powerMonitor.on('unlock-screen', () => logEvent('session', 'экран разблокирован'))
    powerMonitor.on('suspend', () => { syncJournal(); logEvent('power', 'сон') })
    powerMonitor.on('resume', () => { lastPacketAt = Date.now(); logEvent('power', 'пробуждение') })
    createTray()
    createWindow(!startHidden)
    // Бэкенд не привязан к окну: он нужен и тогда, когда окно не показано.
    startPython()
    watchBackend()
  })
}

export type { DesignId, LayoutMode }
