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

// ตัวเลขคอลัมน์เริ่มต้นสำหรับฟอร์ม "เพิ่มช่องทาง PO ใหม่" — อ้างอิงจากช่องทาง default
// ตัวแรก (wet_market) แทนที่จะพิมพ์ 65/20/11 ซ้ำอีกที่ (เดิมมี 2 จุดที่ hardcode ตัวเลข
// เดียวกันนี้ซ้ำ ทั้งที่ค่าจริงมาจาก DEFAULT_DETAIL_SOURCES อยู่แล้ว)
export function defaultDetailCols() {
  const d = detailSources.find(s => s.id === "wet_market") || detailSources[0] || {}
  return { plateCol: d.plateCol ?? 65, productCodeCol: d.productCodeCol ?? 20, groupFlagCol: d.groupFlagCol ?? 11 }
}

// ── Lanes (wh_lanes) ─────────────────────────────────────────────────────────
// ป้ายชื่อ/สี/emoji ของลานโหลด — id (lane_parts/lane_head/lane_pork) ต้องคงที่ตลอด
// อายุระบบ เพราะผูกกับ qcLanes/loadLanes/sampleLanes ที่บันทึกไว้แล้ว รวมถึง URL kiosk
// mode (qc_parts, loading_parts, ...) ที่มี QR code พิมพ์ใช้งานจริงอยู่แล้ว ดังนั้นตาราง
// นี้ "เพิ่ม" ลานใหม่ได้ (จะไปโผล่ในตารางที่ generic เช่น Dashboard/ใบสรุป/Basket Summary)
// แต่การเพิ่มลานใหม่ให้มี kiosk URL/เมนูของตัวเองยังต้องแก้โค้ดส่วน routing อยู่ดี
//
// 3 ตัวนี้เป็น default ในโค้ด เสมอ — ข้อมูลจาก wh_lanes เป็นส่วนเสริม/override เท่านั้น
const DEFAULT_LANES = [
  { id: "lane_parts", label: "ลานโหลดชิ้นส่วน",       shortLabel: "ลานโหลดชิ้นส่วน", tinyLabel: "ชิ้นส่วน",     emoji: "🥩", color: "#f97316", bg: "#fff7ed", border: "#fed7aa", sortOrder: 1 },
  { id: "lane_head",  label: "ลานโหลดหัว/เครื่องใน",  shortLabel: "ลานโหลดหัว/เครื่องใน", tinyLabel: "หัว/เครื่องใน", emoji: "🐷", color: "#8b5cf6", bg: "#faf5ff", border: "#ddd6fe", sortOrder: 2 },
  { id: "lane_pork",  label: "ลานโหลดหมูซีก",          shortLabel: "ลานโหลดหมูซีก",        tinyLabel: "หมูซีก",        emoji: "🐖", color: "#e11d48", bg: "#fff1f2", border: "#fecdd3", sortOrder: 3 },
]
export const lanes = [...DEFAULT_LANES]

export async function loadLanes() {
  try {
    const { data, error } = await supabase.from("wh_lanes").select("id, data")
    if (error) throw error
    const merged = [...DEFAULT_LANES]
    for (const row of data || []) {
      const d = row.data || {}
      const base = merged.find(l => l.id === row.id) || {}
      const entry = {
        id: row.id,
        label:      d.label      || base.label      || row.id,
        shortLabel: d.shortLabel || base.shortLabel  || d.label || row.id,
        tinyLabel:  d.tinyLabel  || base.tinyLabel   || d.label || row.id,
        emoji:      d.emoji      || base.emoji       || "📦",
        color:      d.color      || base.color       || "#6b7280",
        bg:         d.bg         || base.bg          || "#f3f4f6",
        border:     d.border     || base.border      || "#e5e7eb",
        sortOrder:  Number.isFinite(d.sortOrder) ? d.sortOrder : (base.sortOrder ?? 0),
      }
      const idx = merged.findIndex(l => l.id === entry.id)
      if (idx >= 0) merged[idx] = entry; else merged.push(entry)
    }
    merged.sort((a, b) => a.sortOrder - b.sortOrder)
    lanes.length = 0
    lanes.push(...merged)
  } catch (e) {
    console.error("โหลด wh_lanes ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function saveLane(id, fields) {
  const trimmedId = id.trim()
  if (!trimmedId) throw new Error("กรุณาระบุรหัสลาน (id)")
  const { error } = await supabase.from("wh_lanes").upsert({ id: trimmedId, data: fields })
  if (error) throw error
  const idx = lanes.findIndex(l => l.id === trimmedId)
  const entry = { id: trimmedId, ...(idx >= 0 ? lanes[idx] : {}), ...fields }
  if (idx >= 0) lanes[idx] = entry; else lanes.push(entry)
}

// ลบได้เฉพาะลานที่เพิ่มเองใหม่ (ไม่ใช่ 3 ลาน default ในโค้ด) — 3 ลาน default ผูกกับ
// kiosk routing โดยตรง ลบไม่ได้
export async function deleteLane(id) {
  if (DEFAULT_LANES.some(l => l.id === id)) throw new Error("ลบลาน default ของระบบไม่ได้")
  const { error } = await supabase.from("wh_lanes").delete().eq("id", id)
  if (error) throw error
  const idx = lanes.findIndex(l => l.id === id)
  if (idx >= 0) lanes.splice(idx, 1)
}

// ── Bays (wh_bays) ───────────────────────────────────────────────────────────
// ช่องโหลดย่อยภายในแต่ละลาน (ชิ้นส่วน 7 ช่อง / หัวเครื่องใน 2 ช่อง / หมูซีก 4 ช่อง เป็น
// default) — เปิด/ปิดการบังคับเลือกช่องโหลดทั้งระบบได้ที่ settings.enableBaySelection
// (wh_settings, key enable_bay_selection) ปิดแล้วหน้า QC/QC สุ่ม/Checker จะข้ามหน้าเลือก
// ช่องไปเข้าฟอร์มเลย ไม่บันทึก bayId ลง DB
// id คงที่ตลอดอายุระบบเพราะผูกกับ qcLanes/sampleLanes/loadLanes[...].bayId ที่บันทึกไว้
// แล้ว — เพิ่ม/ลบ/แก้ชื่อได้อิสระต่อลาน แต่ deleteBay กันไว้ไม่ให้ลบช่องสุดท้ายของลานนั้น
const DEFAULT_BAYS = [
  ...Array.from({ length: 7 }, (_, i) => ({ id: `lane_parts_bay_${i + 1}`, laneId: "lane_parts", label: `ช่องโหลด ${i + 1}`, sortOrder: i + 1 })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `lane_head_bay_${i + 1}`,  laneId: "lane_head",  label: `ช่องโหลด ${i + 1}`, sortOrder: i + 1 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `lane_pork_bay_${i + 1}`,  laneId: "lane_pork",  label: `ช่องโหลด ${i + 1}`, sortOrder: i + 1 })),
]
export const bays = [...DEFAULT_BAYS]

export async function loadBays() {
  try {
    const { data, error } = await supabase.from("wh_bays").select("id, data")
    if (error) throw error
    // แถวที่ data.deleted=true คือ tombstone ของ default bay ที่ถูกลบ (ดู deleteBay) —
    // ต้อง apply ก่อน merge เพราะ default ตัวนั้นจะไม่มีแถวจริงให้ .delete() ลบได้เลย
    const deletedDefaults = new Set((data || []).filter(r => r.data?.deleted).map(r => r.id))
    const merged = DEFAULT_BAYS.filter(b => !deletedDefaults.has(b.id))
    for (const row of data || []) {
      if (row.data?.deleted) continue
      const d = row.data || {}
      const base = merged.find(b => b.id === row.id)
      const laneId = d.laneId || base?.laneId
      if (!laneId) continue // ไม่รู้จะผูกกับลานไหน ข้ามแถวนี้
      const entry = {
        id: row.id,
        laneId,
        label: d.label || base?.label || row.id,
        sortOrder: Number.isFinite(d.sortOrder) ? d.sortOrder : (base?.sortOrder ?? 0),
      }
      const idx = merged.findIndex(b => b.id === entry.id)
      if (idx >= 0) merged[idx] = entry; else merged.push(entry)
    }
    bays.length = 0
    bays.push(...merged)
  } catch (e) {
    console.error("โหลด wh_bays ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

export async function addBay(laneId, label) {
  const trimmed = (label || "").trim()
  if (!trimmed) throw new Error("กรุณากรอกชื่อช่องโหลด")
  const id = `${laneId}_bay_${Date.now()}`
  const sortOrder = Date.now()
  const { error } = await supabase.from("wh_bays").insert({ id, data: { laneId, label: trimmed, sortOrder } })
  if (error) throw error
  bays.push({ id, laneId, label: trimmed, sortOrder })
}

export async function saveBay(id, label) {
  const trimmed = (label || "").trim()
  if (!trimmed) throw new Error("กรุณากรอกชื่อช่องโหลด")
  const row = bays.find(b => b.id === id)
  if (!row) throw new Error("ไม่พบช่องโหลดนี้")
  const { error } = await supabase.from("wh_bays").upsert({ id, data: { laneId: row.laneId, label: trimmed, sortOrder: row.sortOrder } })
  if (error) throw error
  row.label = trimmed
}

// ต้องเหลืออย่างน้อย 1 ช่องต่อลานเสมอ กันหน้าเลือกช่องโหลดของลานนั้นว่างเปล่า
export async function deleteBay(id) {
  const row = bays.find(b => b.id === id)
  if (!row) return
  const remaining = bays.filter(b => b.laneId === row.laneId && b.id !== id)
  if (remaining.length === 0) throw new Error("ต้องเหลืออย่างน้อย 1 ช่องโหลดต่อลาน")
  if (DEFAULT_BAYS.some(b => b.id === id)) {
    // default bay ไม่มีแถวจริงใน wh_bays เสมอไป (ถ้าไม่เคยแก้ชื่อ) — .delete() ธรรมดาจะไม่ error
    // แต่ก็ไม่ลบอะไรจริง แล้ว DEFAULT_BAYS จะทำให้ช่องนี้โผล่กลับมาใหม่ทุกครั้งที่ loadBays()
    // ต้องฝัง tombstone แทนเพื่อให้ loadBays() รู้ว่าต้องข้าม default id นี้ไปตลอด
    const { error } = await supabase.from("wh_bays").upsert({ id, data: { deleted: true, laneId: row.laneId } })
    if (error) throw error
  } else {
    const { error } = await supabase.from("wh_bays").delete().eq("id", id)
    if (error) throw error
  }
  const idx = bays.findIndex(b => b.id === id)
  if (idx >= 0) bays.splice(idx, 1)
}

// ── Roles (wh_roles) ─────────────────────────────────────────────────────────
// ป้ายชื่อ/emoji/รูปของตำแหน่งงานในหน้าเลือกตำแหน่งงาน — id ต้องคงที่เสมอเพราะ
// ROLE_TABS/LANE_SELECT_ROLES ใน App.jsx ผูก logic ว่า role ไหนเห็นเมนูอะไรกับ id
// เหล่านี้ตรงๆ ตารางนี้แก้ได้แค่ label/emoji/img ไม่ใช่ที่ไว้เพิ่ม/ลบตำแหน่งงานใหม่
const DEFAULT_ROLES = [
  { id: "qc",            label: "ลานโหลด",             emoji: "🌡️", sortOrder: 1 },
  { id: "checker",        label: "QC",                  emoji: "🥩", sortOrder: 2 },
  { id: "loading",        label: "Checker",             img: "/basket.png", sortOrder: 3 },
  { id: "office_wh",      label: "Office คลัง",          emoji: "🖨️", sortOrder: 4 },
  { id: "office_plan",    label: "Office วางแผน",        emoji: "🧾", sortOrder: 5 },
  { id: "lg",             label: "LG",                  emoji: "⬆️", sortOrder: 6 },
  { id: "dashboard_only", label: "Dashboard",           sortOrder: 7 },
  { id: "loading_data",   label: "ข้อมูลการโหลดสินค้า",  sortOrder: 8 },
  { id: "tracking",       label: "Tracking การทำงาน",    emoji: "📊", sortOrder: 9 },
  { id: "all",            label: "ทั้งหมด",              sortOrder: 10 },
]
export const roles = [...DEFAULT_ROLES]

export async function loadRoles() {
  try {
    const { data, error } = await supabase.from("wh_roles").select("id, data")
    if (error) throw error
    const merged = [...DEFAULT_ROLES]
    for (const row of data || []) {
      // เฉพาะ id ที่มีอยู่แล้วในระบบเท่านั้น — role id ใหม่จะไม่มี routing รองรับ
      const idx = merged.findIndex(r => r.id === row.id)
      if (idx < 0) continue
      const d = row.data || {}
      merged[idx] = {
        ...merged[idx],
        label: d.label || merged[idx].label,
        emoji: d.emoji ?? merged[idx].emoji,
        img:   d.img   ?? merged[idx].img,
      }
    }
    roles.length = 0
    roles.push(...merged)
  } catch (e) {
    console.error("โหลด wh_roles ไม่สำเร็จ ใช้ default ในโค้ดไปก่อน:", e)
  }
}

// แก้ได้เฉพาะ label/emoji/img ของ role ที่มีอยู่แล้วในระบบเท่านั้น (10 ตัว default)
export async function saveRole(id, fields) {
  if (!DEFAULT_ROLES.some(r => r.id === id)) throw new Error("เพิ่มตำแหน่งงานใหม่ไม่ได้ — แก้ได้เฉพาะตำแหน่งที่มีอยู่แล้ว")
  const { label, emoji, img } = fields
  const { error } = await supabase.from("wh_roles").upsert({ id, data: { label, emoji, img } })
  if (error) throw error
  const idx = roles.findIndex(r => r.id === id)
  if (idx >= 0) roles[idx] = { ...roles[idx], label, emoji, img }
}
