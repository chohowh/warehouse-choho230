import { supabase } from '../lib/supabase'

const localDateStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const parseThaiDateToISO = (dateStr) => {
  if (!dateStr) return null
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  const [d, m, y] = parts.map(Number)
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// อ่านวันที่รอบงานจาก wh_queue — เปลี่ยนเมื่อกดปิดงานและโหลดรอบใหม่
export const getCycleDate = async () => {
  const { data } = await supabase
    .from('wh_queue')
    .select('data')
    .limit(1)
    .single()
  const queueDate = data?.data?.date
  return parseThaiDateToISO(queueDate) || localDateStr()
}
