import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { loadSettings } from './lib/settings'
import { loadLaneAliases, loadWaitingReasons, loadBasketTypes, loadDetailSources } from './lib/masterData'

// โหลด master data (wh_settings, wh_lane_aliases, wh_waiting_reasons, wh_basket_types,
// wh_detail_sources) ให้เสร็จก่อน mount แอป — ฟังก์ชัน top-level ใน App.jsx (DATE_STR,
// cycleDateStr, normalizeLaneKey, normalizeChannels, ฯลฯ) อ่านค่าจาก object เหล่านี้
// ตรงๆ ตอน render/เรียกใช้ครั้งแรก ถ้า mount ไปก่อนจะเห็นค่า default ค้างอยู่จนกว่าจะมี
// re-render ครั้งถัดไป
// กันแอปค้างไม่ mount ถ้า Supabase ตอบช้า/ไม่ตอบ — ปล่อยผ่านไปใช้ค่า default แทน
const settingsReady = Promise.race([
  Promise.all([loadSettings(), loadLaneAliases(), loadWaitingReasons(), loadBasketTypes(), loadDetailSources()]),
  new Promise(resolve => setTimeout(resolve, 5000)),
])

settingsReady.finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
