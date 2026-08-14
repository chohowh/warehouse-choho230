import { supabase } from './supabase'

// ค่า default — ใช้จนกว่า loadSettings() จะโหลดค่าจริงจาก wh_settings สำเร็จ
// (เดิมค่าพวกนี้กระจายเป็น const แยกกันหลายจุดใน App.jsx แก้ไขได้เฉพาะทาง dev เท่านั้น
// ตอนนี้รวมเป็นจุดเดียว โหลดครั้งเดียวก่อน mount แอปใน main.jsx เพื่อให้ทุกจุดที่อ่านค่า
// (ทั้ง component และฟังก์ชัน top-level อย่าง cycleDateStr/DATE_STR) เห็นค่าล่าสุดตรงกันหมด)
export const settings = {
  workDayCutoffHour:    10,
  waitingUrgentMinutes: 20,
  maxPhotoUploads:      15,
  maxWaitingReasons:    3,
  geofence:             { lat: 14.7260, lng: 100.7950, radiusM: 2000 },
}

const SETTERS = {
  work_day_cutoff_hour:  v => { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n < 24) settings.workDayCutoffHour = n; },
  waiting_urgent_minutes: v => { const n = Number(v); if (Number.isFinite(n) && n > 0) settings.waitingUrgentMinutes = n; },
  max_photo_uploads:     v => { const n = Number(v); if (Number.isFinite(n) && n > 0) settings.maxPhotoUploads = n; },
  max_waiting_reasons:   v => { const n = Number(v); if (Number.isFinite(n) && n > 0) settings.maxWaitingReasons = n; },
  geofence:              v => { if (v && typeof v === "object") settings.geofence = { ...settings.geofence, ...v }; },
}

export async function loadSettings() {
  try {
    const { data, error } = await supabase.from("wh_settings").select("id, value")
    if (error) throw error
    for (const row of data || []) {
      SETTERS[row.id]?.(row.value)
    }
  } catch (e) {
    console.error("โหลด wh_settings ไม่สำเร็จ ใช้ค่า default:", e)
  }
}

export async function saveSetting(id, value) {
  const { error } = await supabase.from("wh_settings").upsert({ id, value })
  if (error) throw error
  SETTERS[id]?.(value)
}
