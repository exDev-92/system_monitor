import { useCallback, useEffect, useState } from 'react'
import type { AppConfig } from '../../electron/config'

/**
 * Хозяин настроек — главный процесс: они нужны ему для трея, размеров окна
 * и журнала. Здесь зеркало; null — ответ ещё не пришёл.
 */
export function useConfig(): [AppConfig | null, (patch: Partial<AppConfig>) => void] {
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    let alive = true
    window.ipcRenderer.invoke('config:get').then((cfg: AppConfig) => {
      if (alive) setConfig(cfg)
    })

    const onChanged = (_e: unknown, cfg: AppConfig) => setConfig(cfg)
    window.ipcRenderer.on('config:changed', onChanged)
    return () => {
      alive = false
      window.ipcRenderer.off('config:changed', onChanged)
    }
  }, [])

  const patch = useCallback((changes: Partial<AppConfig>) => {
    // Рисуем сразу, не дожидаясь ответа, иначе щелчки ощущаются вязкими.
    setConfig(prev => (prev ? { ...prev, ...changes } : prev))
    void window.ipcRenderer.invoke('config:patch', changes)
  }, [])

  return [config, patch]
}
