import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const TASK_NAME = 'PCMonitor Autostart'

export const HIDDEN_ARG = '--hidden'

export interface AutostartStatus {
  enabled: boolean
  /** Создать задачу с наивысшими правами может только процесс администратора. */
  canChange: boolean
  error?: string
}

function run(file: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true }, err => resolve(!err))
  })
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Описание задачи планировщика. XML, а не ключи schtasks, потому что только так
 * снимаются два умолчания, смертельные для программы, которая работает всегда:
 * остановка через 72 часа и запрет работы от батареи.
 */
export function taskXml(opts: {
  user: string
  command: string
  args: string
  workDir: string
  runLevel: 'HighestAvailable' | 'LeastPrivilege'
}): string {
  const user = xmlEscape(opts.user)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Мониторинг ПК: запуск в трее при входе в систему</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>${opts.runLevel}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(opts.command)}</Command>
      <Arguments>${xmlEscape(opts.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(opts.workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** `net session` отвечает успехом только процессу с правами администратора. */
function isElevated(): Promise<boolean> {
  return run('net', ['session'])
}

export async function getAutostart(): Promise<AutostartStatus> {
  const [enabled, canChange] = await Promise.all([
    run('schtasks', ['/Query', '/TN', TASK_NAME]),
    isElevated(),
  ])
  return { enabled, canChange }
}

export async function setAutostart(enable: boolean): Promise<AutostartStatus> {
  if (!(await isElevated())) {
    return { ...(await getAutostart()), error: 'Нужны права администратора.' }
  }

  let ok: boolean
  if (enable) {
    // Без сборки exe — это electron.exe, и путь к приложению идёт первым аргументом.
    const appArg = process.defaultApp ? `"${path.resolve(process.argv[1])}" ` : ''
    const file = path.join(os.tmpdir(), `pcmonitor-task-${process.pid}.xml`)
    const xml = taskXml({
      user: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`,
      command: process.execPath,
      args: `${appArg}${HIDDEN_ARG}`,
      workDir: path.dirname(process.execPath),
      runLevel: 'HighestAvailable',
    })
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + xml, 'utf16le')
    ok = await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'])
    fs.rmSync(file, { force: true })
  } else {
    ok = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'])
  }

  const status = await getAutostart()
  return ok ? status : { ...status, error: 'Планировщик заданий отказал в операции.' }
}
