import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { installDisplayMetricsLog } from './debug/displayMetrics.ts'
import './styles.css'

// Каждая вкладка (мастер, игрок, общий стол) пишет метрики экрана в свой лог; игроки шлют его мастеру.
installDisplayMetricsLog()

createRoot(document.getElementById('root')!).render(<App />)
