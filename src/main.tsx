import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'

// Шрифты дизайна, встроенные локально (десктопное приложение работает офлайн)
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/cyrillic-400.css'
import '@fontsource/jetbrains-mono/cyrillic-500.css'
import '@fontsource/jetbrains-mono/cyrillic-700.css'
import '@fontsource/ibm-plex-sans/300.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/cyrillic-300.css'
import '@fontsource/ibm-plex-sans/cyrillic-400.css'
import '@fontsource/ibm-plex-sans/cyrillic-500.css'
import '@fontsource/ibm-plex-sans/cyrillic-600.css'
import '@fontsource/barlow-condensed/400.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'

import './index.css'

// Один бандл на все окна: хеш адреса решает, что рисовать.
// Загрузка по требованию не даёт стилям панели попасть в остальные окна.
const Root = lazy(() => {
  if (window.location.hash === '#settings') return import('./settings/SettingsApp')
  if (window.location.hash === '#stats') return import('./stats/StatsApp')
  return import('./App.tsx')
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
)
