import { supabase } from './supabase'

// ── Lane aliases (wh_lane_aliases) ──────────────────────────────────────────
// ชื่อเรียกลานแบบอื่นๆ ที่พบในไฟล์ Master นอกเหนือจากที่โค้ดรู้จักอยู่แล้ว (LANE_NAME_MAP
// ใน App.jsx ยังเป็น default/fallback เดิม — ตารางนี้ไว้ "เพิ่ม" alias ใหม่โดยไม่ต้องแก้โค้ด)
// { [aliasText]: laneId }
export const laneAliases = {}

export async function loadLaneAliases() {
  try {
    const { data, error } = await supabase.from("wh_lane_aliases").select("id, data")
    if (error) throw error
    for (const k of Object.keys(laneAliases)) delete laneAliases[k]
    for (const row of data || []) {
      if (row.data?.laneKey) laneAliases[row.id] = row.data.laneKey
    }
  } catch (e) {
    console.error("โหลด wh_lane_aliases ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function saveLaneAlias(alias, laneKey) {
  const id = alias.trim()
  if (!id) throw new Error("กรุณากรอกชื่อเรียกลาน")
  const { error } = await supabase.from("wh_lane_aliases").upsert({ id, data: { laneKey } })
  if (error) throw error
  laneAliases[id] = laneKey
}

export async function deleteLaneAlias(alias) {
  const { error } = await supabase.from("wh_lane_aliases").delete().eq("id", alias)
  if (error) throw error
  delete laneAliases[alias]
}

// ── Waiting reasons (wh_waiting_reasons) ────────────────────────────────────
// รายการเหตุผล "รอสินค้าอะไร" ที่ใช้เป็น fallback เฉพาะตอนไฟล์ Master ไม่มีชื่อสินค้า
// ที่ match กับลานนั้นเลย (ปกติ dropdown จะดึงชื่อสินค้าจาก Master ก่อนเสมอ)
export const waitingReasons = []

export async function loadWaitingReasons() {
  try {
    const { data, error } = await supabase.from("wh_waiting_reasons").select("id, data")
    if (error) throw error
    const rows = (data || []).map(r => ({ id: r.id, label: r.data?.label || "", sortOrder: r.data?.sortOrder ?? 0 }))
    rows.sort((a, b) => a.sortOrder - b.sortOrder)
    waitingReasons.length = 0
    waitingReasons.push(...rows)
  } catch (e) {
    console.error("โหลด wh_waiting_reasons ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function addWaitingReason(label) {
  const trimmed = label.trim()
  if (!trimmed) throw new Error("กรุณากรอกข้อความเหตุผล")
  const id = `reason_${Date.now()}`
  const data = { label: trimmed, sortOrder: Date.now() }
  const { error } = await supabase.from("wh_waiting_reasons").insert({ id, data })
  if (error) throw error
  waitingReasons.push({ id, ...data })
}

export async function deleteWaitingReason(id) {
  const { error } = await supabase.from("wh_waiting_reasons").delete().eq("id", id)
  if (error) throw error
  const idx = waitingReasons.findIndex(r => r.id === id)
  if (idx >= 0) waitingReasons.splice(idx, 1)
}

// ── Basket/hook types (wh_basket_types) ─────────────────────────────────────
// ประเภทตะกร้า/ตะขอที่ฟอร์ม Checker/ตะกร้าค้างคืนใช้ — key ต้องคงที่ตลอดอายุระบบ
// เพราะผูกกับข้อมูลเก่าที่บันทึกไว้แล้ว (loadLanes[...].baskets[key]) เปลี่ยน/ลบ key
// ที่มีข้อมูลอยู่แล้วจะทำให้อ่านข้อมูลเก่าไม่เจอ
// countsInTotal = นับรวมใน "รวมตะกร้า" ไหม (ของเดิม hooks ไม่นับรวม เป็นคนละหน่วยกับตะกร้า)
//
// 4 ตัวนี้เป็น default ในโค้ด เสมอ — ข้อมูลจาก wh_basket_types เป็นส่วนเสริม/override
// เท่านั้น (merge by key) ไม่ได้แทนที่ทั้งชุด กันเคส DB มีแค่ 1 แถวแล้วของเดิมหายไปหมด
const DEFAULT_BASKET_TYPES = [
  { key: "yellowBig",   label: "เหลือง (ใหญ่)", countsInTotal: true,  sortOrder: 1 },
  { key: "yellowSmall", label: "เหลือง (เล็ก)", countsInTotal: true,  sortOrder: 2 },
  { key: "gray",        label: "เทา",           countsInTotal: true,  sortOrder: 3 },
  { key: "hooks",       label: "ตะขอแขวนซาก",   countsInTotal: false, sortOrder: 4 },
]
export const basketTypes = [...DEFAULT_BASKET_TYPES]

export async function loadBasketTypes() {
  try {
    const { data, error } = await supabase.from("wh_basket_types").select("id, data")
    if (error) throw error
    const merged = [...DEFAULT_BASKET_TYPES]
    for (const row of data || []) {
      const entry = { key: row.id, label: row.data?.label || row.id, countsInTotal: !!row.data?.countsInTotal, sortOrder: row.data?.sortOrder ?? 0 }
      const idx = merged.findIndex(b => b.key === entry.key)
      if (idx >= 0) merged[idx] = entry; else merged.push(entry)
    }
    merged.sort((a, b) => a.sortOrder - b.sortOrder)
    basketTypes.length = 0
    basketTypes.push(...merged)
  } catch (e) {
    console.error("โหลด wh_basket_types ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function saveBasketType(key, label, countsInTotal) {
  const id = key.trim()
  if (!id) throw new Error("กรุณากรอกรหัสประเภท (key)")
  const idx = basketTypes.findIndex(b => b.key === id)
  const sortOrder = idx >= 0 ? basketTypes[idx].sortOrder : (basketTypes.length ? Math.max(...basketTypes.map(b => b.sortOrder)) + 1 : 1)
  const { error } = await supabase.from("wh_basket_types").upsert({ id, data: { label, countsInTotal, sortOrder } })
  if (error) throw error
  const row = { key: id, label, countsInTotal, sortOrder }
  if (idx >= 0) basketTypes[idx] = row; else basketTypes.push(row)
}

// ลบได้เฉพาะประเภทที่เพิ่มเองใหม่ (ไม่ใช่ 4 ตัว default ในโค้ด) — ถ้าเคยมีรถบันทึกข้อมูล
// ด้วย key นี้ไว้แล้ว ข้อมูลนั้นจะยังอยู่ในฐานข้อมูลแต่จะไม่แสดง/นับรวมในหน้าเว็บอีก
export async function deleteBasketType(key) {
  const { error } = await supabase.from("wh_basket_types").delete().eq("id", key)
  if (error) throw error
  const idx = basketTypes.findIndex(b => b.key === key)
  if (idx >= 0 && !DEFAULT_BASKET_TYPES.some(b => b.key === key)) basketTypes.splice(idx, 1)
}

// ── PO detail sources / channels (wh_detail_sources) ────────────────────────
// ช่องทางที่ Office วางแผนอัปโหลดไฟล์ PO/order แยกราย retailer — id ต้องคงที่ตลอด
// อายุระบบเพราะผูกกับ id ของแถวที่บันทึกไว้แล้วใน wh_master (detail_<id>_<date>)
// plateCol/productCodeCol/groupFlagCol = ตำแหน่งคอลัมน์ (0-based) ในไฟล์ Excel/CSV
// ของ retailer นั้น — แต่ละเจ้าอาจวางคอลัมน์ไม่ตรงกัน จึงตั้งแยกต่อช่องทางได้
// matchKeywords = คำที่ใช้จับคู่จากช่อง "กลุ่มลูกค้า" ของ LG ว่ารถคันนี้วิ่งช่องทางไหน
const DEFAULT_DETAIL_SOURCES = [
  { id: "wet_market",   label: "ตลาดสด", emoji: "🛒", color: "#10b981", bg: "#d1fae5", plateCol: 65, productCodeCol: 20, groupFlagCol: 11, matchKeywords: ["wetmarket", "wet market"] },
  { id: "modern_trade", label: "Makro",   emoji: "🏪", color: "#3b82f6", bg: "#dbeafe", plateCol: 65, productCodeCol: 20, groupFlagCol: 11, matchKeywords: ["makro"] },
  { id: "others",       label: "LOTUS",   emoji: "📦", color: "#f97316", bg: "#fff7ed", plateCol: 65, productCodeCol: 20, groupFlagCol: 11, matchKeywords: ["lotus"] },
]
export const detailSources = [...DEFAULT_DETAIL_SOURCES]

export async function loadDetailSources() {
  try {
    const { data, error } = await supabase.from("wh_detail_sources").select("id, data")
    if (error) throw error
    const merged = [...DEFAULT_DETAIL_SOURCES]
    for (const row of data || []) {
      const d = row.data || {}
      const entry = {
        id: row.id,
        label: d.label || row.id,
        emoji: d.emoji || "📦",
        color: d.color || "#6b7280",
        bg: d.bg || "#f3f4f6",
        plateCol: Number.isFinite(d.plateCol) ? d.plateCol : 65,
        productCodeCol: Number.isFinite(d.productCodeCol) ? d.productCodeCol : 20,
        groupFlagCol: Number.isFinite(d.groupFlagCol) ? d.groupFlagCol : 11,
        matchKeywords: Array.isArray(d.matchKeywords) ? d.matchKeywords : [],
      }
      const idx = merged.findIndex(s => s.id === entry.id)
      if (idx >= 0) merged[idx] = entry; else merged.push(entry)
    }
    detailSources.length = 0
    detailSources.push(...merged)
  } catch (e) {
    console.error("โหลด wh_detail_sources ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function saveDetailSource(id, fields) {
  const trimmedId = id.trim()
  if (!trimmedId) throw new Error("กรุณากรอกรหัสช่องทาง (id)")
  const { error } = await supabase.from("wh_detail_sources").upsert({ id: trimmedId, data: fields })
  if (error) throw error
  const entry = { id: trimmedId, ...fields }
  const idx = detailSources.findIndex(s => s.id === trimmedId)
  if (idx >= 0) detailSources[idx] = entry; else detailSources.push(entry)
}

// ลบได้เฉพาะช่องทางที่เพิ่มเองใหม่ (ไม่ใช่ 3 ช่องทาง default ในโค้ด) — ไฟล์/ข้อมูลที่เคย
// อัปโหลดด้วยช่องทางนี้จะยังอยู่ในฐานข้อมูลแต่จะไม่แสดงในหน้าเว็บอีก
export async function deleteDetailSource(id) {
  const { error } = await supabase.from("wh_detail_sources").delete().eq("id", id)
  if (error) throw error
  const idx = detailSources.findIndex(s => s.id === id)
  if (idx >= 0 && !DEFAULT_DETAIL_SOURCES.some(s => s.id === id)) detailSources.splice(idx, 1)
}
