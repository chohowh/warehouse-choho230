import React, { useState, useEffect, useRef, useCallback } from "react";

const useIsMobile = () => {
  const [v, setV] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setV(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return v;
};

const useIsNarrow = () => {
  const [v, setV] = useState(() => window.innerWidth < 900);
  useEffect(() => {
    const h = () => setV(window.innerWidth < 900);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return v;
};
import * as XLSX from "xlsx";
import { supabase } from "./lib/supabase";
import { uploadToR2 } from "./lib/r2";
import { sendTeamsNotification } from "./utils/teams";

// ─────────────────────────────────────────────────────────────────────────────
// FLOW:
// 1. LG Upload คิวรถ
// 2. คนขับสแกนเข้า  → status: "arrived"
// 3. Picking พิมพ์เบิกพัสดุ → status: "picking"
// 4. QC ตรวจอุณหภูมิก่อนเข้าแต่ละลาน (ทีละลาน ไม่ต้องครบ 3 พร้อมกัน)
// 5. ลานโหลด: QC ผ่านลานไหน → โหลดลานนั้นได้เลย (truck.qcLanes / truck.loadLanes)
// 6. Picking พิมพ์สรุปค่าย (โหลดแล้วอย่างน้อย 1 ลาน) → status: "summary_printed"
// 7. วางแผน ออก Invoice → status: "invoiced"
// ─────────────────────────────────────────────────────────────────────────────

const LOADING_LANES = [
  { id: "lane_parts", label: "ลานโหลดชิ้นส่วน",       shortLabel: "ลานโหลดชิ้นส่วน", tinyLabel: "ชิ้นส่วน",     emoji: "🥩", color: "#f97316", bg: "#fff7ed", border: "#fed7aa" },
  { id: "lane_head",  label: "ลานโหลดหัว/เครื่องใน",  shortLabel: "ลานโหลดหัว/เครื่องใน", tinyLabel: "หัว/เครื่องใน", emoji: "🐷", color: "#8b5cf6", bg: "#faf5ff", border: "#ddd6fe" },
  { id: "lane_pork",  label: "ลานโหลดหมูซีก",          shortLabel: "ลานโหลดหมูซีก",        tinyLabel: "หมูซีก",        emoji: "🐖", color: "#e11d48", bg: "#fff1f2", border: "#fecdd3" },
];

const STATUS_META = {
  arrived:         { label: "เข้าโรงงานแล้ว",   color: "#3b82f6", bg: "#dbeafe", step: 1 },
  picking:         { label: "กำลังโหลด",          color: "#f97316", bg: "#ffedd5", step: 2 },
  summary_printed: { label: "โหลดเสร็จ/สรุปแล้ว", color: "#10b981", bg: "#d1fae5", step: 3 },
  invoiced:        { label: "ออก Invoice แล้ว",   color: "#6b7280", bg: "#f3f4f6", step: 4 },
};

const FLOW_STEPS = [
  { key: "arrived",         label: "เข้าโรงงาน",  emoji: "🚛" },
  { key: "picking",         label: "โหลดสินค้า",  emoji: "📋" },
  { key: "summary_printed", label: "ใบสรุป",       emoji: "🖨️" },
  { key: "invoiced",        label: "Invoice",      emoji: "📄" },
];

const TODAY = new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
const SHORT_DATE = `${new Date().getDate()}/${new Date().getMonth() + 1}/${new Date().getFullYear()}`;
const TIME_NOW = () => new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
const getStep = (status) => STATUS_META[status]?.step ?? 0;

const DATE_STR = () => {
  const d = new Date();
  if (d.getHours() < 9) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const safePlate = p => String(p).replace(/[^a-zA-Z0-9]/g, "") || "unknown";

const compressImage = file => new Promise(resolve => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = ev => {
    const img = new Image();
    img.src = ev.target.result;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      const MAX_SIZE = 1200;
      if (width > height) {
        if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; }
      } else {
        if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
  };
});

async function uploadPhotos(folder, plate, photos) {
  if (!photos || !photos.length) return [];
  const ts = Date.now();
  const urls = [];
  for (let i = 0; i < photos.length; i++) {
    const blob = await fetch(photos[i]).then(r => r.blob());
    const ext = blob.type.split("/")[1] || "jpg";
    const path = `${folder}/${DATE_STR()}/${safePlate(plate)}/${ts}_${i}.${ext}`;
    const url = await uploadToR2(path, blob);
    urls.push(url);
  }
  return urls;
}

// ─── GEOFENCE ────────────────────────────────────────────────────────────────
const FACTORY_LAT = 14.7260;
const FACTORY_LNG = 100.7950;
const GEOFENCE_RADIUS_M = 2000; // meters (2 km)

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function useGeofence() {
  const [state, setState] = useState({ status: "idle", distance: null, error: null });
  const watchRef = useRef(null);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setState({ status: "error", distance: null, error: "เบราว์เซอร์ไม่รองรับ GPS" });
      return;
    }
    setState(s => ({ ...s, status: "loading" }));
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const d = haversineDistance(pos.coords.latitude, pos.coords.longitude, FACTORY_LAT, FACTORY_LNG);
        setState({ status: d <= GEOFENCE_RADIUS_M ? "inside" : "outside", distance: Math.round(d), error: null });
      },
      (err) => {
        const msgs = { 1: "กรุณาอนุญาตการเข้าถึงตำแหน่ง (Location)", 2: "ไม่สามารถหาตำแหน่งได้ กรุณาเปิด GPS", 3: "หมดเวลาหาตำแหน่ง กรุณาลองใหม่" };
        setState({ status: "error", distance: null, error: msgs[err.code] || err.message });
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }, []);

  useEffect(() => {
    return () => { if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current); };
  }, []);

  return { ...state, start };
}

// ─── QR CODE (SVG-based, no external lib) ────────────────────────────────────
// Minimal QR-like display using a Google Charts API image
const DRIVER_URL = typeof window !== "undefined"
  ? `${window.location.origin}${window.location.pathname}?mode=driver`
  : "";

const QRCodeDisplay = ({ url, size = 220 }) => (
  <div style={{ textAlign: "center" }}>
    <img
      src={`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`}
      alt="QR Code"
      width={size}
      height={size}
      style={{ borderRadius: 0, border: "3px solid #e5e7eb" }}
    />
  </div>
);

const QR_ITEMS = [
  { mode: "driver",        emoji: "🚛", label: "คนขับ เช็คอิน",     color: "#111",    bg: "#f9fafb" },
  { mode: "qc_parts",      emoji: "🌡️", label: "ลานโหลด ชิ้นส่วน",      color: "#0369a1", bg: "#f0f9ff" },
  { mode: "qc_head",       emoji: "🌡️", label: "ลานโหลด หัว/เครื่องใน", color: "#0369a1", bg: "#f0f9ff" },
  { mode: "qc_pork",       emoji: "🌡️", label: "ลานโหลด หมูซีก",       color: "#0369a1", bg: "#f0f9ff" },
  { mode: "loading_parts", emoji: "🥩", label: "Checker ชิ้นส่วน",      color: "#c2410c", bg: "#fff7ed" },
  { mode: "loading_head",  emoji: "🐷", label: "Checker หัว/เครื่องใน", color: "#7c3aed", bg: "#faf5ff" },
  { mode: "loading_pork",  emoji: "🐖", label: "Checker หมูซีก",       color: "#be123c", bg: "#fff1f2" },
  { mode: "sample_parts",  emoji: "📷", label: "QC ชิ้นส่วน",          color: "#0d9488", bg: "#f0fdfa" },
  { mode: "sample_head",   emoji: "📷", label: "QC หัว/เครื่องใน",     color: "#0d9488", bg: "#f0fdfa" },
  { mode: "sample_pork",   emoji: "📷", label: "QC หมูซีก",           color: "#0d9488", bg: "#f0fdfa" },
];

const saveImageToDevice = async (url, fileName) => {
  let blob;
  try {
    blob = await (await fetch(url)).blob();
  } catch {
    window.open(url, "_blank");
    return;
  }
  const file = new File([blob], fileName, { type: blob.type || "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* user cancelled share sheet */ }
    return;
  }
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(blobUrl);
};

const saveQrImage = async (url, mode) => {
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(url)}`;
    const blob = await (await fetch(qrUrl)).blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl; a.download = `qr-${mode}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(`https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(url)}`, "_blank");
  }
};

const QRCodePage = () => {
  const base = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "";
  const [zoomItem, setZoomItem] = useState(null);
  const driverItems = QR_ITEMS.filter(i => i.mode === "driver");
  const otherItems  = QR_ITEMS.filter(i => i.mode !== "driver");

  const renderCard = ({ mode, emoji, label, color, bg }) => {
    const url = `${base}?mode=${mode}`;
    return (
      <div key={mode} onClick={() => setZoomItem({ mode, emoji, label, color, bg })}
        style={{ background: "#fff", borderRadius: 0, padding: 8, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", border: `2px solid ${color}20`, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, cursor: "pointer" }}>
        <div style={{ width: "100%", background: color, borderRadius: 0, padding: "4px 0", textAlign: "center", color: "#fff", fontWeight: 900, fontSize: 10 }}>
          {emoji} {label}
        </div>
        <QRCodeDisplay url={url} size={80} />
        <div style={{ background: bg, borderRadius: 0, padding: "3px 6px", fontSize: 7, color: "#374151", wordBreak: "break-all", fontFamily: "monospace", width: "100%", boxSizing: "border-box", textAlign: "center" }}>
          {url}
        </div>
        <div style={{ display: "flex", gap: 4, width: "100%" }}>
          <button onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(url); }}
            style={{ flex: 1, background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "4px 0", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>
            📋 คัดลอก
          </button>
          <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
            style={{ flex: 1, background: color, color: "#fff", border: "none", borderRadius: 0, padding: "4px 0", fontSize: 9, fontWeight: 700, cursor: "pointer", textDecoration: "none", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
            ↗ เปิด
          </a>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>📱 QR Code ทั้งหมด</h2>
          <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 12 }}>สแกนเพื่อเข้าหน้าต่าง ๆ โดยตรง · คลิกที่กล่องเพื่อดูขนาดใหญ่</p>
        </div>
        <button onClick={() => window.print()}
          style={{ background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          🖨️ พิมพ์ทั้งหมด
        </button>
      </div>
      {driverItems.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
          {driverItems.map(renderCard)}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        {otherItems.map(renderCard)}
      </div>

      {zoomItem && (() => {
        const url = `${base}?mode=${zoomItem.mode}`;
        return (
          <div onClick={() => setZoomItem(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 0, padding: 28, maxWidth: 360, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, cursor: "default" }}>
              <div style={{ width: "100%", background: zoomItem.color, borderRadius: 0, padding: "12px 0", textAlign: "center", color: "#fff", fontWeight: 900, fontSize: 18 }}>
                {zoomItem.emoji} {zoomItem.label}
              </div>
              <QRCodeDisplay url={url} size={280} />
              <div style={{ background: zoomItem.bg, borderRadius: 0, padding: "8px 12px", fontSize: 11, color: "#374151", wordBreak: "break-all", fontFamily: "monospace", width: "100%", boxSizing: "border-box", textAlign: "center" }}>
                {url}
              </div>
              <div style={{ display: "flex", gap: 8, width: "100%" }}>
                <button onClick={() => navigator.clipboard?.writeText(url)}
                  style={{ flex: 1, background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  📋 คัดลอก
                </button>
                <a href={url} target="_blank" rel="noreferrer"
                  style={{ flex: 1, background: zoomItem.color, color: "#fff", border: "none", borderRadius: 0, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", textDecoration: "none", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  ↗ เปิด
                </a>
              </div>
              <button onClick={() => saveQrImage(url, zoomItem.mode)}
                style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 0, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                💾 บันทึกรูป QR
              </button>
              <button onClick={() => setZoomItem(null)}
                style={{ width: "100%", background: "transparent", color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 0, padding: "8px 0", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                ปิด
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// ─── ICONS ───────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 20 }) => {
  const icons = {
    truck:     <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
    scan:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M7 12h10"/></svg>,
    upload:    <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
    clipboard: <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>,
    camera:    <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
    check:     <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>,
    chart:     <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>,
    list:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>,
    print:     <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z"/></svg>,
    invoice:   <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
    temp:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/></svg>,
    loader:    <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
    x:         <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>,
    bell:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
    plan:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
    lock:      <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
    pig_head:  <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="13.5" r="6.5"/><path d="M7 8.5 L5 4 L10 7.5"/><path d="M17 8.5 L19 4 L14 7.5"/><ellipse cx="12" cy="17" rx="2.5" ry="1.5"/><circle cx="11" cy="17" r="0.6" fill="currentColor" stroke="none"/><circle cx="13" cy="17" r="0.6" fill="currentColor" stroke="none"/><circle cx="9.5" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="0.9" fill="currentColor" stroke="none"/></svg>,
    pig_cuts:  <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M3 16 Q12 13 21 16 L21 18.5 Q12 21.5 3 18.5 Z"/><path d="M4 11 Q12 8 20 11 L20 13.5 Q12 16.5 4 13.5 Z"/><path d="M5 6 Q12 3 19 6 L19 8.5 Q12 11.5 5 8.5 Z"/></svg>,
    pig_side:  <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 L10 4.5 C7 5.5 6 9 6 13 C6 17 7.5 20.5 10 22 L14 22 C16.5 20.5 18 17 18 13 C18 9 17 5.5 14 4.5 L14 2"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="8.5" y1="14.5" x2="15.5" y2="14.5"/><line x1="9" y1="18" x2="15" y2="18"/></svg>,
  };
  return icons[name] || null;
};

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const s = STATUS_META[status]; if (!s) return null;
  return <span style={{ background: s.bg, color: s.color, padding: "3px 10px", borderRadius: 0, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{s.label}</span>;
};

// ─── FLOW PROGRESS ────────────────────────────────────────────────────────────
const FlowProgress = ({ status }) => {
  const cur = getStep(status);
  return (
    <div style={{ display: "flex", alignItems: "center", overflowX: "auto", padding: "2px 0" }}>
      {FLOW_STEPS.map((s, i) => {
        const n = i + 1; const done = n <= cur;
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <div style={{ textAlign: "center", width: 42 }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", margin: "0 auto 2px", background: done ? "#111" : "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {done ? <Icon name="check" size={13} /> : <span style={{ color: "#9ca3af", fontSize: 12 }}>{s.emoji}</span>}
              </div>
              <div style={{ fontSize: 9, fontWeight: done ? 700 : 400, color: done ? "#111" : "#9ca3af", lineHeight: 1.2 }}>{s.label}</div>
            </div>
            {i < FLOW_STEPS.length - 1 && <div style={{ width: 12, height: 2, background: n < cur ? "#111" : "#e5e7eb", flexShrink: 0, marginBottom: 12 }} />}
          </div>
        );
      })}
    </div>
  );
};

// ─── MODAL ────────────────────────────────────────────────────────────────────
const Modal = ({ title, onClose, children }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <div style={{ background: "#fff", borderRadius: 0, width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 25px 60px rgba(0,0,0,0.3)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280" }}><Icon name="x" size={22} /></button>
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  </div>
);

// ─── PRINT MODAL ──────────────────────────────────────────────────────────────
const PrintModal = ({ truck, type, onClose }) => {
  const titles = { pickup: "เบิกพัสดุสินค้า", summary: "ใบสรุปค่าย", invoice: "ใบ Invoice" };
  const title = titles[type];
  return (
    <Modal title={`🖨️ ${title}`} onClose={onClose}>
      <div style={{ border: "2px solid #111", borderRadius: 0, padding: 20, fontFamily: "monospace", fontSize: 13, lineHeight: 1.9 }}>
        <div style={{ textAlign: "center", fontWeight: 900, fontSize: 17, borderBottom: "2px solid #111", paddingBottom: 8, marginBottom: 14 }}>
          🏭 โรงงานอาหารสด<br/><span style={{ fontSize: 14 }}>{title}</span>
        </div>
        <div>วันที่: {TODAY}</div>
        <div>เลขที่: {type.toUpperCase()}-{truck.id}-{Date.now().toString().slice(-4)}</div>
        <div>ทะเบียนรถ: <b>{truck.plate}</b></div>
        <div>คนขับ: {truck.driver}</div>
        <div style={{ margin: "10px 0", borderTop: "1px dashed #aaa", paddingTop: 10 }}>
          <div>สินค้า: {truck.product}</div>
          <div>จำนวน: {truck.qty} {truck.unit}</div>
          <div>ปลายทาง: {truck.destination}</div>
        </div>
        {type === "summary" && truck.qcLanes && (
          <div style={{ borderTop: "1px dashed #aaa", paddingTop: 10 }}>
            <b>อุณหภูมิ QC:</b>
            {LOADING_LANES.map(l => <div key={l.id}>{l.shortLabel}: {truck.qcLanes[l.id]?.temp || "–"}°C</div>)}
          </div>
        )}
        {type === "invoice" && (
          <div style={{ borderTop: "1px dashed #aaa", paddingTop: 10 }}>
            <div>ราคาต่อหน่วย: 120.00 บาท</div>
            <div>รวม: {(truck.qty * 120).toLocaleString()} บาท</div>
            <div>VAT 7%: {Math.round(truck.qty * 120 * 0.07).toLocaleString()} บาท</div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>รวมทั้งสิ้น: {Math.round(truck.qty * 120 * 1.07).toLocaleString()} บาท</div>
          </div>
        )}
        <div style={{ textAlign: "center", marginTop: 14, borderTop: "1px dashed #aaa", paddingTop: 10, fontSize: 11, color: "#666" }}>
          ผู้รับสินค้า: _______________ / ผู้ส่งสินค้า: _______________
        </div>
      </div>
      <button onClick={() => { window.print(); onClose(); }} style={{ marginTop: 14, width: "100%", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "13px 0", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
        🖨️ พิมพ์เอกสาร
      </button>
    </Modal>
  );
};

// ─── PHOTO UPLOADER ───────────────────────────────────────────────────────────
const PhotoUploader = ({ label, value, onChange, onRemove }) => {
  const photos = Array.isArray(value) ? value : (value ? [value] : []);
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 5 }}>{label}</label>}
      <div style={{ border: `2px dashed ${photos.length > 0 ? "#6ee7b7" : "#d1d5db"}`, borderRadius: 0, padding: photos.length > 0 ? 10 : 18, background: photos.length > 0 ? "#f0fdf4" : "#fafafa" }}>
        {photos.length > 0
          ? <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                {photos.map((src, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <img src={src} alt="" style={{ width: "100%", aspectRatio: "1", borderRadius: 0, objectFit: "cover", display: "block" }} />
                    {onRemove && (
                      <button onClick={e => { e.stopPropagation(); onRemove(photos.filter((_, j) => j !== i)); }}
                        style={{ position: "absolute", top: 3, right: 3, background: "rgba(0,0,0,0.55)", color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, fontSize: 11, fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {photos.length < 15 && (
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", aspectRatio: "1", borderRadius: 0, border: "1.5px dashed #d1d5db", cursor: "pointer", background: "#fff", gap: 2 }}>
                    <input type="file" accept="image/*" multiple onChange={onChange} style={{ display: "none" }} />
                    <Icon name="camera" size={18} />
                    <span style={{ color: "#9ca3af", fontSize: 10 }}>เพิ่ม</span>
                  </label>
                )}
              </div>
              <div style={{ textAlign: "center", marginTop: 8, fontSize: 11, color: "#10b981", fontWeight: 700 }}>
                {photos.length} / 15 รูป
              </div>
            </div>
          : <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="file" accept="image/*" multiple onChange={onChange} style={{ display: "none" }} />
              <Icon name="camera" size={28} />
              <span style={{ color: "#9ca3af", fontSize: 13 }}>ถ่ายรูป / เลือกจาก Gallery</span>
              <span style={{ color: "#d1d5db", fontSize: 11 }}>สูงสุด 15 รูปต่อครั้ง</span>
            </label>
        }
      </div>
    </div>
  );
};

// ─── TRUCK CARD ───────────────────────────────────────────────────────────────
const TruckCard = ({ t, children, highlight }) => (
  <div style={{ background: "#fff", borderRadius: 0, padding: 18, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", marginBottom: 14, border: highlight ? "2px solid #111" : "1.5px solid #f0f0f0" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
      <div>
        <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: 1 }}>{t.plate}</div>
        <div style={{ color: "#6b7280", fontSize: 12 }}>{t.driver} · เข้า {t.arrivedAt}</div>
      </div>
      <StatusBadge status={t.status} />
    </div>
    <div style={{ background: "#f9fafb", borderRadius: 0, padding: "8px 12px", fontSize: 13, marginBottom: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
      <span><b>สินค้า:</b> {t.product}</span>
      <span><b>จำนวน:</b> {t.qty} {t.unit}</span>
      <span><b>ปลายทาง:</b> {t.destination}</span>
    </div>
    <FlowProgress status={t.status} />
    {children && <div style={{ marginTop: 12 }}>{children}</div>}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────────────────────────────────

// ── TIME BAR ──────────────────────────────────────────────────────────────────
const parseExitDatetime = (dateStr, timeStr) => {
  if (!timeStr) return null;
  const timeParts = timeStr.split(":");
  const h = parseInt(timeParts[0], 10);
  const min = parseInt(timeParts[1], 10);
  if (isNaN(h) || isNaN(min)) return null;
  if (dateStr) {
    let [day, month, year] = dateStr.split("/").map(Number);
    // handle M/D/YYYY format (US Excel) — month > 12 means day/month are swapped
    if (month > 12) { [day, month] = [month, day]; }
    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      const d = new Date(year, month - 1, day, h, min, 0, 0);
      if (h * 60 + min <= 9 * 60) d.setDate(d.getDate() + 1);
      return d;
    }
  }
  // ไม่มี date → fallback วันนี้ + ปรับข้ามคืน
  const d = new Date(); d.setHours(h, min, 0, 0);
  if (h * 60 + min <= 9 * 60) d.setDate(d.getDate() + 1);
  return d;
};

const calcTimeBarInfo = (exitTime, date) => {
  const exitDt = parseExitDatetime(date, exitTime);
  const remaining = exitDt ? Math.round((exitDt - Date.now()) / 60000) : 0;
  const totalWindow = 240;
  const color = remaining > 60 ? "#22c55e" : remaining > 20 ? "#f59e0b" : "#ef4444";
  const fmtMins = m => { const a = Math.abs(m); return `${Math.floor(a/60)}:${String(a%60).padStart(2,"0")}`; };
  const label = remaining < 0 ? `เกิน ${fmtMins(remaining)} ชม.` : `เหลือ ${fmtMins(remaining)} ชม.`;
  const pct = Math.min(Math.max(remaining / totalWindow, 0), 1) * 100;
  return { remaining, color, label, pct };
};

const TimeBar = ({ exitTime, date, done, invoicedAt, fs, card, hideBar, hideLabel }) => {
  if (!exitTime) return <span style={{ color: "#d1d5db", fontSize: fs ? 15 : 11 }}>—</span>;

  if (done) {
    return (
      <div>
        <div style={{ fontSize: fs ? 15 : card ? 20 : 11, fontWeight: 700, color: "#374151" }}>{exitTime}</div>
        {invoicedAt && <div style={{ fontSize: fs ? 13 : card ? 13 : 10, color: "#6b7280", marginTop: 2 }}>ออกจริง {invoicedAt}</div>}
      </div>
    );
  }

  const { remaining, color, label, pct } = calcTimeBarInfo(exitTime, date);
  const barExtend = card ? null : fs ? { marginLeft: -180, width: "calc(100% + 180px)" } : { marginLeft: -114, width: "calc(100% + 114px)" };
  return (
    <div>
      <div style={{ fontSize: fs ? 16 : card ? 20 : 13, fontWeight: 700, color: remaining <= 0 ? "#ef4444" : "#374151", whiteSpace: "nowrap", lineHeight: "18px" }}>{exitTime}</div>
      {!hideLabel && <div style={{ fontSize: fs ? 13 : card ? 14 : 11, color, marginTop: 2, whiteSpace: "nowrap", fontWeight: 600, lineHeight: "16px" }}>{label}</div>}
      {!hideBar && <div style={{ marginTop: fs ? 14 : 4, height: fs ? 10 : 6, borderRadius: card ? 3 : 0, ...(barExtend ?? {}), background: `linear-gradient(to right, ${color} ${pct}%, #e5e7eb ${pct}%)` }} />}
    </div>
  );
};

const TimeBarTrack = ({ exitTime, date, done }) => {
  if (!exitTime || done) return null;
  const { color, pct, label } = calcTimeBarInfo(exitTime, date);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: `linear-gradient(to right, ${color} ${pct}%, #e5e7eb ${pct}%)` }} />
      <div style={{ fontSize: 12, color, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
const exportArchiveExcel = async (dateStr) => {
  const { data, error } = await supabase.from("wh_archive").select("*").eq("archive_date", dateStr).single();
  if (error || !data) { alert("ไม่พบข้อมูลวันที่ " + dateStr); return; }
  const { queue, trucks } = data;
  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const rows = queue.map((q, i) => {
    const truck = trucks.find(t => t.queueId === q.id);
    return {
      "ลำดับ":                          i + 1,
      "วันที่":                         q.date || dateStr,
      "กลุ่มลูกค้า":                   q.customerGroup || "",
      "Zone":                           q.zone || "",
      "ทะเบียนรถ":                      q.plate || "",
      "น้ำหนักจัดรถ":                   "",
      "เวลารถเข้าโรงงาน STD":            q.entryTime || "",
      "เวลารถเข้าโรงงาน ACT":            truck?.arrivedAt || "",
      "เวลาพิมพ์ใบเบิก (Picking)":       truck?.pickingAt || "",
      "สถานะเพิ่มเติม":                  truck?.extraStatus || "",
      "เวลาสถานะเพิ่มเติม":             truck?.extraStatusAt || "",
      "เวลาเข้าโหลดชิ้นส่วน STD":       "",
      "เวลาเข้าโหลดชิ้นส่วน ACT":       truck?.qcLanes?.lane_parts?.doneAt || "",
      "เวลารอสินค้าชิ้นส่วน":           truck?.loadLanes?.lane_parts?.waitingAt || "",
      "เวลาเสร็จสิ้นโหลดชิ้นส่วน":     truck?.loadLanes?.lane_parts?.doneAt || "",
      "เวลาเข้าโหลดหัวเครื่องใน STD":   "",
      "เวลาเข้าโหลดหัวเครื่องใน ACT":   truck?.qcLanes?.lane_head?.doneAt || "",
      "เวลารอสินค้าหัวเครื่องใน":       truck?.loadLanes?.lane_head?.waitingAt || "",
      "เวลาเสร็จสิ้นโหลดหัวเครื่องใน":  truck?.loadLanes?.lane_head?.doneAt || "",
      "เวลาเข้าโหลดหมูซีก STD":         "",
      "เวลาเข้าโหลดหมูซีก ACT":         truck?.qcLanes?.lane_pork?.doneAt || "",
      "เวลารอสินค้าหมูซีก":             truck?.loadLanes?.lane_pork?.waitingAt || "",
      "เวลาเสร็จสิ้นโหลดหมูซีก":       truck?.loadLanes?.lane_pork?.doneAt || "",
      "เวลาทำใบสรุปจ่าย":               truck?.summaryPrintedAt || "",
      "เวลาทำใบ Invoice":                truck?.invoicedAt || "",
      "เวลาออกจากโรงงาน":               q.exitTime || "",
      "WT ลูกค้า":                       "",
      "หมายเหตุ":                        "",
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, dateStr);
  XLSX.writeFile(wb, `คิวรถ_${dateStr}.xlsx`);
};

const LANE_LABEL = { lane_parts: "ลานชิ้นส่วน", lane_head: "ลานหัว/เครื่องใน", lane_pork: "ลานหมูซีก" };

const TruckTable = ({ visibleRows, allRows, searchPlate, setSearchPlate, getRemMins }) => {
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTvMode, setIsTvMode] = useState(false);
  const isMobile = useIsMobile();
  useEffect(() => {
    const onChange = () => {
      const inFs = !!document.fullscreenElement;
      setIsFullscreen(inFs);
      if (!inFs) setIsTvMode(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };
  const toggleTvMode = () => {
    if (!isTvMode) {
      containerRef.current?.requestFullscreen();
      setIsTvMode(true);
    } else {
      document.exitFullscreen();
    }
  };
  const fs = isTvMode;
  const Tick = () => <span style={{ color: "#10b981", fontWeight: 700, fontSize: fs ? 20 : 13 }}>✓</span>;
  const Dash = () => <span style={{ color: "#d1d5db", fontSize: fs ? 18 : 12 }}>—</span>;
  const tdP = fs ? "10px 20px" : "10px 12px";
  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
      <div style={{ padding: fs ? "10px 24px" : "10px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: fs ? 18 : 14, whiteSpace: "nowrap" }}>
          🚛 รถในโรงงานวันนี้ <span style={{ background: "#111", color: "#fff", borderRadius: 0, padding: fs ? "2px 8px" : "2px 8px", fontSize: fs ? 14 : 11, marginLeft: 4 }}>{allRows.length}</span>
        </span>
        <div style={{ flex: 1 }} />
        <input
          type="text"
          placeholder="🔍 ค้นหาทะเบียน..."
          value={searchPlate}
          onChange={e => setSearchPlate(e.target.value)}
          style={{ border: "1px solid #e5e7eb", borderRadius: 0, padding: "5px 10px", fontSize: 12, width: 180, outline: "none", display: fs ? "none" : undefined, marginRight: 4 }}
        />
        {!isMobile && <button
          onClick={toggleFullscreen}
          title={isFullscreen && !isTvMode ? "ย่อหน้าต่าง (Esc)" : "ขยายเต็มจอ (Desktop)"}
          style={{ border: "1px solid #e5e7eb", borderRadius: 0, background: "#f9fafb", cursor: "pointer", padding: "4px 8px", fontSize: 15, lineHeight: 1, color: "#374151", flexShrink: 0, display: fs ? "none" : "flex", alignItems: "center", justifyContent: "center" }}
        >
          {isFullscreen && !isTvMode ? "✕" : "⛶"}
        </button>}
        {!isMobile && <button
          onClick={toggleTvMode}
          title={fs ? "ออกจากโหมด TV" : "โหมด Smart TV"}
          style={{ border: "1px solid #e5e7eb", borderRadius: 0, background: fs ? "#111" : "#f9fafb", cursor: "pointer", padding: fs ? "6px 12px" : "4px 8px", fontSize: fs ? 22 : 15, fontWeight: 800, lineHeight: 1, color: fs ? "#fff" : "#374151", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", marginLeft: fs ? "auto" : undefined }}
        >
          {fs ? "✕" : "TV"}
        </button>}
      </div>
      {visibleRows.length === 0
        ? <div style={{ padding: fs ? 40 : 36, textAlign: "center", color: "#9ca3af", fontSize: fs ? 20 : 14 }}>
            {searchPlate.trim() ? `ไม่พบทะเบียน "${searchPlate}"` : "ยังไม่มีรถเข้าโรงงาน"}
          </div>
        : isMobile && !fs
        ? <div style={{ padding: "8px 12px 16px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", maxHeight: "calc(100vh - 130px)" }}>
            {visibleRows.map(({ key, date, plate, customerGroup, entryTime, exitTime, truck }) => {
              const rem = getRemMins({ date, exitTime });
              const urgent = rem < 20 && truck?.status !== "invoiced";
              const anyQC = LOADING_LANES.some(l => truck?.qcLanes?.[l.id]?.done);
              return (
                <div key={key} style={{ background: urgent ? "#fff5f5" : "#fff", borderRadius: 0, padding: "14px 16px", boxShadow: "0 1px 6px rgba(0,0,0,0.08)", border: urgent ? "1.5px solid #fca5a5" : "1px solid #f3f4f6" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <div style={{ fontWeight: 900, fontSize: 20, color: "#111", letterSpacing: 0.5 }}>{plate}</div>
                      <div style={{ fontSize: 13, color: "#6b7280" }}>{customerGroup}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <TimeBar exitTime={exitTime} date={date} done={truck?.status === "invoiced"} invoicedAt={truck?.invoicedAt} fs={false} card hideBar hideLabel />
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, color: "#3b82f6", fontSize: 12 }}>{entryTime || "—"}</div>
                    {truck?.arrivedAt && <div style={{ fontSize: 11, color: "#9ca3af" }}>({`เข้าจริง ${truck.arrivedAt}`})</div>}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <TimeBarTrack exitTime={exitTime} date={date} done={truck?.status === "invoiced"} />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {!truck
                      ? <span style={{ fontSize: 12, color: "#9ca3af", background: "#f9fafb", borderRadius: 0, padding: "4px 10px" }}>รอเช็คอิน</span>
                      : !anyQC
                      ? <span style={{ fontSize: 12, color: "#6b7280", background: "#f3f4f6", borderRadius: 0, padding: "4px 10px", fontWeight: 600 }}>รอเข้าโหลด</span>
                      : LOADING_LANES.map(l => {
                          const loaded = truck.loadLanes?.[l.id]?.done;
                          const qcDone = truck.qcLanes?.[l.id]?.done;
                          const waiting = truck.loadLanes?.[l.id]?.waiting && !loaded;
                          if (loaded) return <span key={l.id} style={{ background: "#10b981", color: "#fff", borderRadius: 0, padding: "4px 12px", fontSize: 12, fontWeight: 700 }}>✓ {l.tinyLabel}</span>;
                          if (waiting) return <span key={l.id} style={{ background: "#fbbf24", color: "#fff", borderRadius: 0, padding: "4px 12px", fontSize: 12, fontWeight: 700 }}>⏳ รอสินค้า {l.tinyLabel}</span>;
                          if (qcDone) return <span key={l.id} style={{ background: "#fff7ed", color: "#f97316", borderRadius: 0, padding: "4px 12px", fontSize: 12, fontWeight: 700, border: "1px solid #fed7aa" }}>โหลด {l.tinyLabel}</span>;
                          return null;
                        })
                    }
                    {truck?.extraStatus && <span style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 0, padding: "4px 12px", fontSize: 12, fontWeight: 700 }}>⚠️ {truck.extraStatus}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid #f3f4f6" }}>
                    {[{label:"ใบเบิก", done: truck?.pickupPrinted},{label:"ใบสรุป", done: truck?.summaryPrinted},{label:"Invoice", done: truck?.status === "invoiced"}].map(item => (
                      <span key={item.label} style={{ flex: 1, textAlign: "center", fontSize: 11, color: item.done ? "#10b981" : "#d1d5db", fontWeight: 700 }}>
                        {item.done ? "✓" : "—"} {item.label}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        : <div style={{ overflowX: "auto", overflowY: "auto", flex: 1, maxHeight: fs ? undefined : "calc(100vh - 170px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: fs ? 18 : 12, tableLayout: fs ? "fixed" : undefined }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: "#f9fafb" }}>
                  {(fs
                    ? [{l:"ทะเบียน",w:140},{l:"เวลาเข้าโรงงาน",w:160},{l:"เวลาออกจากโรงงาน",w:270},{l:"สถานะ",w:"auto"}]
                    : [{l:"ทะเบียน",w:60},{l:"กลุ่มลูกค้า",w:100},{l:"เวลาเข้าโรงงาน",w:90},{l:"เวลาออกจากโรงงาน",w:200},{l:"สถานะ",w:"auto"},{l:"ใบเบิกสินค้า",w:60},{l:"ใบสรุปจ่าย",w:60},{l:"ใบ Invoice",w:60}]
                  ).map(h => (
                    <th key={h.l} style={{ width: h.w, padding: fs ? "10px 20px" : "9px 12px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb", background: "#f9fafb", fontSize: fs ? 16 : undefined }}>{h.l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(({ key, date, plate, customerGroup, entryTime, exitTime, truck }) => {
                  const rem = getRemMins({ date, exitTime });
                  const urgent = rem < 20 && truck?.status !== "invoiced";
                  return (
                    <tr key={key} className={urgent ? "row-urgent" : ""} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: tdP, fontWeight: 800, fontSize: fs ? 22 : undefined }}>{plate}</td>
                      {!fs && <td style={{ padding: tdP, color: "#374151", maxWidth: 100, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{customerGroup}</td>}
                      <td style={{ padding: tdP, whiteSpace: "nowrap", verticalAlign: "top" }}>
                        <div style={{ fontWeight: 700, color: "#3b82f6", fontSize: fs ? 16 : 13, lineHeight: "18px" }}>{entryTime || "—"}</div>
                        {truck?.arrivedAt
                          ? <div style={{ fontSize: fs ? 13 : 10, color: "#6b7280", marginTop: 2, lineHeight: "16px" }}>เข้าจริง {truck.arrivedAt}</div>
                          : <div style={{ fontSize: fs ? 13 : 10, color: "#6b7280", marginTop: 2, lineHeight: "16px" }}>(รถยังไม่เข้าโรงงาน)</div>}
                      </td>
                      <td style={{ padding: tdP, verticalAlign: "top" }}><TimeBar exitTime={exitTime} date={date} done={truck?.status === "invoiced"} invoicedAt={truck?.invoicedAt} fs={fs} /></td>
                      <td style={{ padding: tdP }}>
                        {!truck
                          ? <span style={{ fontSize: fs ? 16 : 11, color: "#9ca3af" }}>รอเช็คอิน</span>
                          : (() => {
                              const anyQC = LOADING_LANES.some(l => truck.qcLanes?.[l.id]?.done);
                              if (!anyQC) return <span style={{ fontSize: fs ? 16 : 11, color: "#6b7280", fontWeight: 600 }}>รอเข้าโหลด</span>;
                              return (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: fs ? 6 : 4 }}>
                                  {LOADING_LANES.map(l => {
                                    const loaded = truck.loadLanes?.[l.id]?.done;
                                    const qcDone = truck.qcLanes?.[l.id]?.done;
                                    const waiting = truck.loadLanes?.[l.id]?.waiting && !loaded;
                                    if (loaded) return (
                                      <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#10b981", color: "#fff", borderRadius: 0, padding: fs ? "5px 14px 7px 12px" : "3px 10px 5px 8px", fontSize: fs ? 16 : 11, fontWeight: 700, lineHeight: 1.4 }}>
                                        {l.tinyLabel}
                                        <span style={{ position: "absolute", bottom: -4, right: -4, background: "#059669", border: "2px solid #fff", borderRadius: "50%", width: fs ? 18 : 14, height: fs ? 18 : 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: fs ? 10 : 8, fontWeight: 900 }}>✓</span>
                                      </div>
                                    );
                                    if (waiting) return (
                                      <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#fbbf24", color: "#fff", borderRadius: 0, padding: fs ? "5px 14px 7px 12px" : "3px 10px 5px 8px", fontSize: fs ? 16 : 11, fontWeight: 700, lineHeight: 1.4, whiteSpace: "nowrap" }}>
                                        รอสินค้า {l.tinyLabel}
                                        <span style={{ position: "absolute", bottom: -4, right: -4, background: "#d97706", border: "2px solid #fff", borderRadius: "50%", width: fs ? 18 : 14, height: fs ? 18 : 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: fs ? 10 : 8 }}>⏳</span>
                                      </div>
                                    );
                                    if (qcDone) return <span key={l.id} style={{ fontSize: fs ? 16 : 11, color: "#f97316", fontWeight: 700, whiteSpace: "nowrap" }}>กำลังโหลด {l.tinyLabel}</span>;
                                    return null;
                                  })}
                                </div>
                              );
                            })()
                        }
                        {truck?.extraStatus && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ display: "inline-block", background: "#fee2e2", color: "#991b1b", borderRadius: 0, padding: fs ? "3px 10px" : "2px 8px", fontSize: fs ? 14 : 10, fontWeight: 700 }}>⚠️ {truck.extraStatus}</span>
                          </div>
                        )}
                      </td>
                      {!fs && <td style={{ padding: tdP }}>{truck?.pickupPrinted ? <Tick/> : <Dash/>}</td>}
                      {!fs && <td style={{ padding: tdP }}>{truck?.summaryPrinted ? <Tick/> : <Dash/>}</td>}
                      {!fs && <td style={{ padding: tdP }}>{truck?.status === "invoiced" ? <Tick/> : <Dash/>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
      }
    </div>
  );
};

const Dashboard = ({ trucks, queue, onReset, lane, detailMap }) => {
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const [searchPlate, setSearchPlate] = useState("");
  const isMobile = useIsMobile();
  useEffect(() => {
    const id = setInterval(() => setClock(new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    return () => clearInterval(id);
  }, []);
  const cnt = (s) => trucks.filter(t => t.status === s).length;
  const stats = [
    { label: "คิวรอเข้า",         value: queue.filter(q => !trucks.find(t => t.queueId === q.id)).length, color: "#3b82f6", icon: "list"    },
    { label: "รถเข้าโรงงานแล้ว", value: trucks.length,                                                    color: "#22c55e", icon: "truck"   },
    { label: "กำลังโหลด",         value: cnt("arrived") + cnt("picking"),                                  color: "#f97316", icon: "loader"  },
    { label: "Invoice แล้ว",      value: cnt("invoiced"),                                                  color: "#6b7280", icon: "invoice" },
  ];

  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const toMins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const getRemMins = (row) => {
    const dt = parseExitDatetime(row.date, row.exitTime);
    return dt ? Math.round((dt - Date.now()) / 60000) : Infinity;
  };
  const usedDash = new Set();
  const matchTruckDash = q => {
    let t = trucks.find(t => t.queueId === q.id && !usedDash.has(t.id));
    if (!t) t = trucks.find(t => !t.queueId && plateNum(t.plate) === plateNum(q.plate) && plateNum(q.plate) !== "" && !usedDash.has(t.id));
    if (t) usedDash.add(t.id);
    return t;
  };
  const dashQueueRows = queue.map(q => ({ key: q.id, date: q.date || "", plate: q.plate, customerGroup: q.customerGroup, entryTime: q.entryTime, exitTime: q.exitTime, truck: matchTruckDash(q) }));
  const walkIns = trucks.filter(t => !usedDash.has(t.id));
  const allRows = [
    ...dashQueueRows,
    ...walkIns.map(t => ({ key: t.id, date: t.date || "", plate: t.plate, customerGroup: t.customerGroup || "–", entryTime: t.entryTime || "", exitTime: t.exitTime || "", truck: t })),
  ].filter(row => row.customerGroup !== "CPFTH")
  .filter(row => !lane || !row.truck?.loadLanes?.[lane]?.done)
  .sort((a, b) => {
    const rank = row => {
      if (["invoiced", "summary_printed"].includes(row.truck?.status)) return 5;

      if (lane) {
        const qcDone = row.truck?.qcLanes?.[lane]?.done;
        const waiting = row.truck?.loadLanes?.[lane]?.waiting;
        if (qcDone || waiting) return 0;   // กำลังโหลดอยู่ → บนสุด
      } else {
        const anyActive = LOADING_LANES.some(l =>
          row.truck?.qcLanes?.[l.id]?.done && !row.truck?.loadLanes?.[l.id]?.done
        );
        if (anyActive) return 0;           // กำลังโหลดอยู่ → บนสุด
      }

      if (!row.truck) return 2;            // 2.2 ยังไม่เข้าโรงงาน
      return 1;                            // 2.1 เข้าโรงงานแล้ว แต่ไม่ได้โหลดอยู่
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return getRemMins(a) - getRemMins(b);
  });
  const visibleRows = searchPlate.trim()
    ? allRows.filter(r => r.plate?.toLowerCase().includes(searchPlate.trim().toLowerCase()))
    : allRows;

  return (
    <div>
      {/* Sticky header */}
      <div style={{ position: "sticky", top: 80, zIndex: 40, background: "#f1f5f9", paddingBottom: isMobile ? 6 : 8, paddingTop: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: isMobile ? 16 : 22, fontWeight: 900 }}>{lane ? LANE_LABEL[lane] : "Main Dashboard"}</h2>
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.07)", overflow: "hidden", marginTop: 8 }}>
        <TruckTable visibleRows={visibleRows} allRows={allRows} searchPlate={searchPlate} setSearchPlate={setSearchPlate} getRemMins={getRemMins} />
      </div>
    </div>
  );
};

// ── 1. LG UPLOAD (Excel → parse → queue) ─────────────────────────────────────
const COL_MAP = {
  date:          ["วันที่","date"],
  plate:         ["ทะเบียนรถ","ทะเบียน","plate"],
  customerGroup: ["กลุ่มลูกค้า","customergroup"],
  zone:          ["zone","โซน","ลาน"],
  entryTime:     ["เวลารถเข้าโรงงาน","เวลาเข้าโรงงาน","เข้าโรงงาน","entrytime"],
  exitTime:      ["เวลาออกจากโรงงาน","ออกจากโรงงาน","exittime"],
};

const norm = (s) => String(s).normalize("NFC").toLowerCase().replace(/\s+/g, "").trim();

const matchCol = (header) => {
  const h = norm(header);
  for (const [field, aliases] of Object.entries(COL_MAP)) {
    if (aliases.some(a => h.includes(norm(a)))) return field;
  }
  return null;
};

const parseQueueDateToISO = (dateStr) => {
  if (!dateStr) return DATE_STR();
  const parts = dateStr.split("/");
  if (parts.length !== 3) return DATE_STR();
  const [d, m, y] = parts.map(Number);
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
};

const toDateStr = (val) => {
  if (val === "" || val == null) return "";
  if (typeof val === "string" && /\d/.test(val)) return val.trim();
  const num = typeof val === "number" ? val : parseFloat(val);
  if (!isNaN(num) && num > 1000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
  }
  return String(val).trim();
};

const toHHMM = (val) => {
  if (val === "" || val == null) return "";
  // already looks like time string
  if (typeof val === "string" && /^\d{1,2}:\d{2}/.test(val.trim())) return val.trim().slice(0,5);
  // Excel stores time as fraction of a day (0.875 = 21:00)
  const num = typeof val === "number" ? val : parseFloat(val);
  if (!isNaN(num)) {
    const frac = num - Math.floor(num); // strip date part
    const mins = Math.round(frac * 1440);
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  return String(val);
};

// ถ้า exitTime อยู่ในช่วง 00:00–09:00 → วันที่จริงคือ dateStr + 1 (กะข้ามคืน)
const displayDate = (dateStr, exitTime) => {
  if (!dateStr || !exitTime) return dateStr || "";
  const [hStr, minStr] = exitTime.split(":");
  const h = parseInt(hStr, 10); const min = parseInt(minStr, 10);
  if (isNaN(h) || isNaN(min) || h * 60 + min > 9 * 60) return dateStr;
  const parts = dateStr.split("/");
  if (parts.length !== 3) return dateStr;
  let [d, m, y] = parts.map(Number);
  if (m > 12) { [d, m] = [m, d]; }
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
};

const LGUpload = ({ queue, onSetQueue }) => {
  const isMobile = useIsMobile();
  const [fileName, setFileName] = useState("");
  const [status,   setStatus]   = useState("idle"); // idle | preview | uploading | done | error
  const [extracted, setExtracted] = useState([]);
  const [errMsg,   setErrMsg]   = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [editId,   setEditId]   = useState(null);
  const [editData, setEditData] = useState({});

  const [addingManual, setAddingManual] = useState(false);
  const [manualData, setManualData] = useState({ date: "", plate: "", customerGroup: "", zone: "", entryTime: "", exitTime: "" });
  const [searchQuery, setSearchQuery] = useState("");

  const startEdit = (q) => { setEditId(q.id); setEditData({ plate: q.plate, customerGroup: q.customerGroup, zone: q.zone || "", entryTime: q.entryTime, exitTime: q.exitTime }); };
  const cancelEdit = () => { setEditId(null); setEditData({}); };
  const saveEdit = () => {
    onSetQueue(queue.map(q => q.id === editId ? { ...q, ...editData, zone: editData.zone, time: editData.entryTime } : q));
    setEditId(null); setEditData({});
  };
  const deleteRow = (id) => { if (window.confirm("ลบรถคันนี้ออกจากคิว?")) onSetQueue(queue.filter(q => q.id !== id)); };
  const saveManual = () => {
    if (!manualData.plate) return;
    onSetQueue([...queue, { id: `M${Date.now()}`, ...manualData, date: manualData.date || SHORT_DATE, time: manualData.entryTime, driver: "", zone: manualData.zone || "", product: "", destination: "", qty: 0, unit: "กก.", loadTime: "" }]);
    setManualData({ date: "", plate: "", customerGroup: "", zone: "", entryTime: "", exitTime: "" });
    setAddingManual(false);
  };

  const inputStyle = { border: "1px solid #d1d5db", borderRadius: 0, padding: "4px 8px", fontSize: 12, width: "100%", boxSizing: "border-box" };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setErrMsg("");
    setStatus("idle");

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb   = XLSX.read(ev.target.result, { type: "array", cellDates: false });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });

        if (rows.length < 2) throw new Error("ไม่พบข้อมูลในไฟล์");

        // หา header row จริง (row แรกที่มี column match ได้ >= 2 ช่อง)
        let headerIdx = 0;
        for (let i = 0; i < Math.min(rows.length, 15); i++) {
          if (rows[i].filter(h => matchCol(h) !== null).length >= 2) { headerIdx = i; break; }
        }
        // map headers — แต่ละ field ใช้ column แรกที่เจอเท่านั้น
        const seenFields = new Set();
        const headers = rows[headerIdx].map(matchCol).map(f => {
          if (!f || seenFields.has(f)) return null;
          seenFields.add(f);
          return f;
        });

        const timeFields = new Set(["entryTime","exitTime"]);
        const dateFields = new Set(["date"]);
        const trucks = [];
        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          const obj = {};
          headers.forEach((field, ci) => {
            if (!field) return;
            obj[field] = timeFields.has(field) ? toHHMM(row[ci]) : dateFields.has(field) ? toDateStr(row[ci]) : String(row[ci] ?? "").trim();
          });
          if (obj.plate) trucks.push(obj);
        }

        if (trucks.length === 0) throw new Error("ไม่พบข้อมูลทะเบียนรถ — ตรวจสอบชื่อ column");
        setExtracted(trucks);
        setStatus("preview");
      } catch (err) {
        setErrMsg(err.message);
        setStatus("error");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleConfirm = async () => {
    const newQueue = extracted.map((t, i) => ({
      id:            `Q${Date.now()}-${i}`,
      seq:           i,
      date:          t.date          || "",
      plate:         t.plate        || "",
      driver:        "",
      customerGroup: t.customerGroup || "",
      zone:          t.zone          || "",
      product:       t.customerGroup || "",
      destination:   t.zone          || "",
      qty:           0,
      unit:          "กก.",
      time:          t.entryTime    || "",
      entryTime:     t.entryTime    || "",
      loadTime:      t.loadTime     || "",
      exitTime:      t.exitTime     || "",
    }));
    setStatus("uploading");
    setErrMsg("");
    try {
      await onSetQueue(newQueue);
      setSavedCount(newQueue.length);
      setStatus("done");
      setExtracted([]);
      setFileName("");
    } catch (err) {
      setErrMsg("บันทึกไม่สำเร็จ: " + err.message);
      setStatus("error");
    }
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>🤝 LG → Upload ตารางคิวรถ</h2>

      {/* Upload zone */}
      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, background: fileName ? "#f0fdf4" : "#fafafa", border: `2px dashed ${fileName ? "#6ee7b7" : "#d1d5db"}`, borderRadius: 0, padding: 30, textAlign: "center", cursor: "pointer", marginBottom: 14 }}>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display: "none" }} />
        <Icon name="upload" size={36} />
        {fileName
          ? <><div style={{ fontWeight: 800, color: "#065f46", fontSize: 14 }}>📄 {fileName}</div><div style={{ fontSize: 12, color: "#6b7280" }}>แตะเพื่อเปลี่ยนไฟล์</div></>
          : <><div style={{ fontWeight: 700, color: "#374151" }}>แตะเพื่ออัปโหลดไฟล์ Excel</div><div style={{ fontSize: 12, color: "#9ca3af" }}>รองรับ .xlsx, .xls, .csv</div></>
        }
      </label>

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", background: "#fee2e2", borderRadius: 0, color: "#991b1b", fontWeight: 600, fontSize: 13, marginBottom: 14 }}>
          ❌ {errMsg}
          <div style={{ marginTop: 8, fontWeight: 400, fontSize: 12 }}>
            Column ที่รองรับ: <b>ทะเบียนรถ · กลุ่มลูกค้า · Zone · เข้าโรงงาน · เข้าโหลด · ออก</b>
          </div>
        </div>
      )}

      {/* Preview */}
      {status === "preview" && extracted.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", marginBottom: 14, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>✅ อ่านข้อมูลได้ {extracted.length} คัน</div>
            <span style={{ fontSize: 12, color: "#6b7280" }}>ตรวจสอบแล้วกด "ยืนยัน"</span>
          </div>
          <div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 11 : 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  {(isMobile ? ["ทะเบียนรถ","กลุ่มลูกค้า","Zone","เวลา"] : ["วันที่","ทะเบียนรถ","กลุ่มลูกค้า","Zone","เวลาเข้าโรงงาน","เวลาออกจากโรงงาน"]).map(h => (
                    <th key={h} style={{ padding: isMobile ? "6px 6px" : "8px 12px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {extracted.map((t, i) => isMobile ? (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 6px", fontWeight: 800 }}>
                      {t.plate}
                      <div style={{ fontWeight: 400, color: "#9ca3af", fontSize: 10 }}>{displayDate(t.date, t.exitTime)}</div>
                    </td>
                    <td style={{ padding: "6px 6px" }}>{t.customerGroup}</td>
                    <td style={{ padding: "6px 6px", fontWeight: 700, color: "#7c3aed" }}>{t.zone}</td>
                    <td style={{ padding: "6px 6px" }}>
                      <div style={{ fontWeight: 700, color: "#3b82f6" }}>{t.entryTime}</div>
                      <div style={{ fontWeight: 700, color: "#6b7280" }}>{t.exitTime}</div>
                    </td>
                  </tr>
                ) : (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "8px 12px", color: "#6b7280" }}>{displayDate(t.date, t.exitTime)}</td>
                    <td style={{ padding: "8px 12px", fontWeight: 800 }}>{t.plate}</td>
                    <td style={{ padding: "8px 12px" }}>{t.customerGroup}</td>
                    <td style={{ padding: "8px 12px", fontWeight: 700, color: "#7c3aed" }}>{t.zone}</td>
                    <td style={{ padding: "8px 12px", fontWeight: 700, color: "#3b82f6" }}>{t.entryTime}</td>
                    <td style={{ padding: "8px 12px", fontWeight: 700, color: "#6b7280" }}>{t.exitTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: 16 }}>
            <button onClick={handleConfirm} disabled={status === "uploading"}
              style={{ width: "100%", background: status === "uploading" ? "#6ee7b7" : "#10b981", color: "#fff", border: "none", borderRadius: 0, padding: "13px 0", fontWeight: 700, fontSize: 15, cursor: status === "uploading" ? "not-allowed" : "pointer" }}>
              {status === "uploading" ? "⏳ กำลังบันทึก..." : `✅ ยืนยัน — ตั้งคิวรถ ${extracted.length} คัน`}
            </button>
          </div>
        </div>
      )}

      {status === "done" && (
        <div style={{ padding: "13px 16px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 14 }}>
          ✅ ตั้งคิวรถเรียบร้อย {savedCount} คัน — พร้อมให้คนขับ Scan เข้า
        </div>
      )}

      {/* Current queue list */}
      {queue.length > 0 && (() => {
        const filteredQueue = queue.filter(q => q.plate.includes(searchQuery));
        return (
        <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.07)", overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              คิวรถวันนี้ <span style={{ background: "#111", color: "#fff", borderRadius: 0, padding: "2px 8px", fontSize: 11, marginLeft: 4 }}>{filteredQueue.length}</span>
            </div>
            <input type="text" placeholder="🔍 ค้นหาทะเบียนรถ..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              style={{ border: "1px solid #d1d5db", borderRadius: 0, padding: "6px 12px", fontSize: 12, outline: "none", width: isMobile ? "100%" : 160 }} />
          </div>
          <div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 11 : 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  {(isMobile ? ["ทะเบียนรถ","กลุ่มลูกค้า","Zone","เวลา",""] : ["วันที่","ทะเบียนรถ","กลุ่มลูกค้า","Zone","เวลาเข้าโรงงาน","เวลาออกจากโรงงาน",""]).map(h => (
                    <th key={h} style={{ padding: isMobile ? "6px 6px" : "8px 12px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredQueue.map(q => {
                  const isEditing = editId === q.id;
                  const actions = isEditing ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={saveEdit} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>บันทึก</button>
                      <button onClick={cancelEdit} style={{ background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>ยกเลิก</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => startEdit(q)} style={{ background: "#eff6ff", color: "#1d4ed8", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>แก้ไข</button>
                      <button onClick={() => deleteRow(q.id)} style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 0, padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>ลบ</button>
                    </div>
                  );
                  return isMobile ? (
                    <tr key={q.id} style={{ borderBottom: "1px solid #f3f4f6", background: isEditing ? "#fffbeb" : undefined }}>
                      <td style={{ padding: "6px 6px", fontWeight: 800 }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.plate} onChange={e => setEditData(d => ({ ...d, plate: e.target.value }))} />
                          : <>{q.plate}<div style={{ fontWeight: 400, color: "#9ca3af", fontSize: 10 }}>{displayDate(q.date, q.exitTime)}</div></>}
                      </td>
                      <td style={{ padding: "6px 6px" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.customerGroup} onChange={e => setEditData(d => ({ ...d, customerGroup: e.target.value }))} />
                          : q.customerGroup}
                      </td>
                      <td style={{ padding: "6px 6px", fontWeight: 700, color: "#7c3aed" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.zone} placeholder="Zone" onChange={e => setEditData(d => ({ ...d, zone: e.target.value }))} />
                          : q.zone}
                      </td>
                      <td style={{ padding: "6px 6px" }}>
                        {isEditing
                          ? <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <input style={inputStyle} value={editData.entryTime} placeholder="เข้า HH:MM" onChange={e => setEditData(d => ({ ...d, entryTime: e.target.value }))} />
                              <input style={inputStyle} value={editData.exitTime} placeholder="ออก HH:MM" onChange={e => setEditData(d => ({ ...d, exitTime: e.target.value }))} />
                            </div>
                          : <>
                              <div style={{ fontWeight: 700, color: "#3b82f6" }}>{q.entryTime}</div>
                              <div style={{ fontWeight: 700, color: "#6b7280" }}>{q.exitTime}</div>
                            </>}
                      </td>
                      <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{actions}</td>
                    </tr>
                  ) : (
                    <tr key={q.id} style={{ borderBottom: "1px solid #f3f4f6", background: isEditing ? "#fffbeb" : undefined }}>
                      <td style={{ padding: "8px 12px", color: "#6b7280" }}>{displayDate(q.date, q.exitTime)}</td>
                      <td style={{ padding: "8px 12px", fontWeight: 800 }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.plate} onChange={e => setEditData(d => ({ ...d, plate: e.target.value }))} />
                          : q.plate}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.customerGroup} onChange={e => setEditData(d => ({ ...d, customerGroup: e.target.value }))} />
                          : q.customerGroup}
                      </td>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: "#7c3aed" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.zone} placeholder="Zone" onChange={e => setEditData(d => ({ ...d, zone: e.target.value }))} />
                          : q.zone}
                      </td>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: "#3b82f6" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.entryTime} placeholder="HH:MM" onChange={e => setEditData(d => ({ ...d, entryTime: e.target.value }))} />
                          : q.entryTime}
                      </td>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: "#6b7280" }}>
                        {isEditing
                          ? <input style={inputStyle} value={editData.exitTime} placeholder="HH:MM" onChange={e => setEditData(d => ({ ...d, exitTime: e.target.value }))} />
                          : q.exitTime}
                      </td>
                      <td style={{ padding: "8px 8px", whiteSpace: "nowrap" }}>{actions}</td>
                    </tr>
                  );
                })}
                {addingManual && (isMobile ? (
                  <tr style={{ borderBottom: "1px solid #f3f4f6", background: "#f0fdf4" }}>
                    <td style={{ padding: "6px 6px" }}>
                      <input style={{ ...inputStyle, marginBottom: 3 }} placeholder="24/4/2026" value={manualData.date} onChange={e => setManualData(d => ({ ...d, date: e.target.value }))} />
                      <input style={inputStyle} placeholder="กข-1234" value={manualData.plate} onChange={e => setManualData(d => ({ ...d, plate: e.target.value }))} />
                    </td>
                    <td style={{ padding: "6px 6px" }}><input style={inputStyle} placeholder="กลุ่มลูกค้า" value={manualData.customerGroup} onChange={e => setManualData(d => ({ ...d, customerGroup: e.target.value }))} /></td>
                    <td style={{ padding: "6px 6px" }}><input style={inputStyle} placeholder="Zone" value={manualData.zone} onChange={e => setManualData(d => ({ ...d, zone: e.target.value }))} /></td>
                    <td style={{ padding: "6px 6px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <input style={inputStyle} placeholder="เข้า HH:MM" value={manualData.entryTime} onChange={e => setManualData(d => ({ ...d, entryTime: e.target.value }))} />
                        <input style={inputStyle} placeholder="ออก HH:MM" value={manualData.exitTime} onChange={e => setManualData(d => ({ ...d, exitTime: e.target.value }))} />
                      </div>
                    </td>
                    <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={saveManual} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>บันทึก</button>
                        <button onClick={() => setAddingManual(false)} style={{ background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>ยกเลิก</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr style={{ borderBottom: "1px solid #f3f4f6", background: "#f0fdf4" }}>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="24/4/2026" value={manualData.date} onChange={e => setManualData(d => ({ ...d, date: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="กข-1234" value={manualData.plate} onChange={e => setManualData(d => ({ ...d, plate: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="กลุ่มลูกค้า" value={manualData.customerGroup} onChange={e => setManualData(d => ({ ...d, customerGroup: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="Zone" value={manualData.zone} onChange={e => setManualData(d => ({ ...d, zone: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="HH:MM" value={manualData.entryTime} onChange={e => setManualData(d => ({ ...d, entryTime: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px" }}><input style={inputStyle} placeholder="HH:MM" value={manualData.exitTime} onChange={e => setManualData(d => ({ ...d, exitTime: e.target.value }))} /></td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={saveManual} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>บันทึก</button>
                        <button onClick={() => setAddingManual(false)} style={{ background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>ยกเลิก</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "12px 16px", borderTop: "1px solid #f3f4f6" }}>
            <button onClick={() => setAddingManual(true)} style={{ background: "#eff6ff", color: "#1d4ed8", border: "1px dashed #93c5fd", borderRadius: 0, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", width: "100%" }}>
              + เพิ่มทะเบียนรถ Manual
            </button>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

// ── 2. DRIVER SCAN ────────────────────────────────────────────────────────────
const DriverScan = ({ queue, trucks, onScan, skipGeofence }) => {
  const [plate, setPlate] = useState("");
  const [step, setStep] = useState("input"); // "input" | "confirm"
  const [pendingEntry, setPendingEntry] = useState(null);
  const [selectedZone, setSelectedZone] = useState("");
  const [msg, setMsg] = useState(null);
  const geo = useGeofence();

  // ── Geofence Gate ──
  if (!skipGeofence && geo.status !== "inside") {
    return (
      <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#fff", borderRadius: 0, padding: "40px 28px", boxShadow: "0 4px 24px rgba(0,0,0,0.10)", textAlign: "center", maxWidth: 380, width: "100%" }}>
          {geo.status === "idle" && (
            <>
              <div style={{ fontSize: 56, marginBottom: 16 }}>📍</div>
              <h2 style={{ margin: "0 0 8px", fontWeight: 900, fontSize: 20 }}>เช็คอินเข้าโรงงาน</h2>
              <p style={{ color: "#6b7280", fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>
                กรุณาอนุญาตการเข้าถึงตำแหน่ง<br />เพื่อยืนยันว่าคุณอยู่ใกล้โรงงาน
              </p>
              <button onClick={geo.start}
                style={{ width: "100%", background: "linear-gradient(135deg, #111 0%, #374151 100%)", color: "#fff", border: "none", borderRadius: 0, padding: "15px 0", fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,0.2)" }}>
                📍 ตรวจสอบตำแหน่ง
              </button>
            </>
          )}
          {geo.status === "loading" && (
            <>
              <div style={{ fontSize: 48, marginBottom: 16, animation: "pulse 1.5s infinite" }}>🛰️</div>
              <h2 style={{ margin: "0 0 8px", fontWeight: 900, fontSize: 20 }}>กำลังหาตำแหน่ง...</h2>
              <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>รอสักครู่ระบบกำลังตรวจสอบ GPS</p>
              <style>{`@keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }`}</style>
            </>
          )}
          {geo.status === "outside" && (
            <>
              <div style={{ fontSize: 56, marginBottom: 12 }}>🚫</div>
              <h2 style={{ margin: "0 0 8px", fontWeight: 900, fontSize: 20, color: "#dc2626" }}>อยู่นอกพื้นที่โรงงาน</h2>
              <div style={{ background: "#fef2f2", border: "1.5px solid #fecaca", borderRadius: 0, padding: "16px 20px", marginBottom: 20 }}>
                <div style={{ fontSize: 32, fontWeight: 900, color: "#dc2626", marginBottom: 4 }}>
                  {geo.distance >= 1000 ? `${(geo.distance / 1000).toFixed(1)} กม.` : `${geo.distance} เมตร`}
                </div>
                <div style={{ fontSize: 13, color: "#991b1b", fontWeight: 600 }}>
                  ระยะห่างจากโรงงาน
                </div>
              </div>
              <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
                กรุณาเดินทางเข้าใกล้โรงงานแล้วลองใหม่<br />ระบบจะตรวจสอบตำแหน่งอัตโนมัติ
              </p>
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 0, padding: 12, fontSize: 12, color: "#166534" }}>
                💡 ระบบกำลังติดตามตำแหน่งอยู่ — เมื่อเข้าใกล้โรงงานจะเปิดอัตโนมัติ
              </div>
            </>
          )}
          {geo.status === "error" && (
            <>
              <div style={{ fontSize: 56, marginBottom: 12 }}>⚠️</div>
              <h2 style={{ margin: "0 0 8px", fontWeight: 900, fontSize: 20, color: "#d97706" }}>ไม่สามารถตรวจสอบตำแหน่งได้</h2>
              <div style={{ background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 0, padding: "14px 18px", marginBottom: 20, fontSize: 14, color: "#92400e", fontWeight: 600 }}>
                {geo.error}
              </div>
              <button onClick={geo.start}
                style={{ width: "100%", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "14px 0", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                🔄 ลองใหม่
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const matchPlate = (a, b) => plateNum(a) === plateNum(b) && plateNum(a) !== "";

  const handleSearch = () => {
    const p = plate.trim();
    if (!p) return;
    const queueEntries = queue.filter(q => matchPlate(q.plate, p));
    const usedIds = new Set(trucks.map(t => t.queueId).filter(Boolean));
    const nextEntry = queueEntries.find(q => !usedIds.has(q.id));
    if (queueEntries.length > 0 && !nextEntry) {
      setMsg({ t: "warn", text: "⚠️ รถคันนี้เช็คอินครบทุก trip แล้ว" }); return;
    }
    const entry = nextEntry || { id: `WALK-${Date.now()}`, plate: p, driver: "", customerGroup: "", zone: "", product: "", destination: "", qty: 0, unit: "กก.", time: TIME_NOW(), entryTime: TIME_NOW(), loadTime: "", exitTime: "" };
    setPendingEntry(entry);
    setSelectedZone(entry.zone || "");
    setStep("confirm");
    setMsg(null);
  };

  const handleConfirm = () => {
    onScan({ ...pendingEntry, zone: selectedZone, status: "arrived", arrivedAt: TIME_NOW(), queueId: pendingEntry.id, pickupPrinted: false, summaryPrinted: false });
    const isWalkIn = pendingEntry.id.startsWith("WALK-");
    setMsg({ t: isWalkIn ? "walk" : "ok", text: `✅ เช็คอินสำเร็จ! ${pendingEntry.plate}${selectedZone ? ` — ${selectedZone}` : ""}` });
    setPlate(""); setPendingEntry(null); setSelectedZone(""); setStep("input");
  };

  if (step === "confirm" && pendingEntry) return (
    <div>
      <h2 style={{ margin: "0 0 6px", fontWeight: 900, fontSize: 22 }}>🚛 ยืนยันการเช็คอิน</h2>
      <p style={{ margin: "0 0 18px", color: "#6b7280", fontSize: 13 }}>ตรวจสอบข้อมูลแล้วกดยืนยัน</p>
      <div style={{ background: "#fff", borderRadius: 0, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", marginBottom: 16 }}>
        <div style={{ background: "#f9fafb", borderRadius: 0, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 2, marginBottom: 4 }}>{pendingEntry.plate}</div>
          {pendingEntry.customerGroup && <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>กลุ่มลูกค้า: {pendingEntry.customerGroup}</div>}
        </div>
        {selectedZone && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontWeight: 700, fontSize: 14, marginBottom: 8 }}>📍 Zone</label>
            <div style={{ width: "100%", border: "2px solid #e5e7eb", borderRadius: 0, padding: "12px 14px", fontSize: 16, fontWeight: 700, boxSizing: "border-box", background: "#f9fafb", color: "#7c3aed" }}>
              {selectedZone}
            </div>
          </div>
        )}
        <button onClick={handleConfirm}
          style={{ width: "100%", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
          ✅ ยืนยันเช็คอิน
        </button>
        <button onClick={() => { setStep("input"); setMsg(null); }}
          style={{ width: "100%", background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "12px 0", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
          ← กลับ
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>🚛 คนขับ → เช็คอินเข้าโรงงาน</h2>
      <div style={{ background: "#fff", borderRadius: 0, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", marginBottom: 16 }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ width: 80, height: 80, background: "#111", borderRadius: 0, margin: "0 auto 10px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icon name="check" size={40} />
          </div>
          <p style={{ fontWeight: 700, fontSize: 15, margin: 0 }}>เช็คอินเข้าโรงงาน</p>
        </div>
        <input value={plate} onChange={e => setPlate(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === "Enter" && handleSearch()}
          placeholder="กรอกเลขทะเบียนของท่าน เช่น 1234"
          type="tel" inputMode="numeric" pattern="[0-9]*"
          style={{ width: "100%", border: "2px solid #e5e7eb", borderRadius: 0, padding: "14px 16px", fontSize: 18, fontWeight: 800, textAlign: "center", outline: "none", boxSizing: "border-box" }} />
        <button onClick={handleSearch} style={{ marginTop: 10, width: "100%", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
          ค้นหา
        </button>
        {msg && (
          <div style={{ marginTop: 12, padding: "12px 16px", borderRadius: 0, fontWeight: 600, fontSize: 14,
            background: msg.t === "ok" ? "#d1fae5" : msg.t === "walk" ? "#eff6ff" : msg.t === "warn" ? "#fef3c7" : "#fee2e2",
            color:      msg.t === "ok" ? "#065f46" : msg.t === "walk" ? "#1d4ed8" : msg.t === "warn" ? "#92400e" : "#991b1b" }}>
            {msg.text}
          </div>
        )}
      </div>

    </div>
  );
};

// ── 3+6. PICKING ──────────────────────────────────────────────────────────────
const Picking = ({ trucks, queue, onUpdate, detailMap = {} }) => {
  const isMobile = useIsMobile();

  // รวม queue + walk-in (รถที่เข้าแล้วแต่ยังไม่มีในคิว)
  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const usedPick = new Set();
  const matchTruckPick = q => {
    let t = trucks.find(t => t.queueId === q.id && !usedPick.has(t.id));
    if (!t) t = trucks.find(t => !t.queueId && plateNum(t.plate) === plateNum(q.plate) && plateNum(q.plate) !== "" && !usedPick.has(t.id));
    if (t) usedPick.add(t.id);
    return t;
  };
  const pickQueueRows = queue.map(q => ({ key: q.id, plate: q.plate, customerGroup: q.customerGroup, entryTime: q.entryTime, truck: matchTruckPick(q) }));
  const walkIns = trucks.filter(t => !usedPick.has(t.id));
  const allRows = [
    ...pickQueueRows,
    ...walkIns.map(t => ({ key: t.id, plate: t.plate, customerGroup: t.customerGroup || "–", entryTime: "", truck: t })),
  ].sort((a, b) => {
    const rank = t => {
      if (!t) return 1;                          // รอเช็คอิน
      if (t.summaryPrinted) return 3;            // เสร็จแล้ว → ล่าง
      const can3 = t.status === "arrived";
      const can6 = t.status === "picking" &&
        LOADING_LANES.some(l => t.loadLanes?.[l.id]?.done) &&
        !LOADING_LANES.some(l => t.qcLanes?.[l.id]?.done && !t.loadLanes?.[l.id]?.done);
      if (can3 || can6) return 0;                // กดได้เลย → บน
      return 2;                                  // รอขั้นตอนอื่น
    };
    return rank(a.truck) - rank(b.truck);
  }).filter(row => row.customerGroup !== "CPFTH");

  const [searchQuery, setSearchQuery] = useState("");
  const filteredRows = allRows.filter(r => r.plate.includes(searchQuery));

  const canStep3 = t => t?.status === "arrived";
  const doneStep3 = t => t && ["picking","summary_printed","invoiced"].includes(t.status);
  const canStep6 = t =>
    t?.status === "picking" &&
    LOADING_LANES.some(l => t.loadLanes?.[l.id]?.done) &&
    !LOADING_LANES.some(l => t.qcLanes?.[l.id]?.done && !t.loadLanes?.[l.id]?.done);
  const doneStep6 = t => t && ["summary_printed","invoiced"].includes(t.status);

  const ExtraStatusCell = ({ truck }) => {
    if (!truck) return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
    const [isEditing, setIsEditing] = useState(false);
    const [val, setVal] = useState("");

    if (truck.extraStatus) {
      return (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fee2e2", color: "#991b1b", padding: "4px 8px", borderRadius: 0, fontSize: 11, fontWeight: 700 }}>
          <span>⚠️ {truck.extraStatus}</span>
          <button onClick={() => onUpdate(truck.id, { extraStatus: "" })} style={{ background: "transparent", border: "none", color: "#991b1b", cursor: "pointer", padding: 0, fontWeight: 900, fontSize: 12 }}>×</button>
        </div>
      );
    }
    if (isEditing) {
      return (
        <div style={{ display: "flex", gap: 4 }}>
          <input list={`extraStatusOptions-${truck.id}`} autoFocus value={val} onChange={e => setVal(e.target.value)} placeholder="พิมพ์หรือเลือก..." style={{ border: "1px solid #d1d5db", borderRadius: 0, padding: "2px 6px", fontSize: 11, width: 100 }} />
          <datalist id={`extraStatusOptions-${truck.id}`}>
            <option value="รอแปรสินค้า" />
            <option value="ติดปัญหา IT" />
          </datalist>
          <button onClick={() => { if(val) onUpdate(truck.id, { extraStatus: val, extraStatusAt: TIME_NOW() }); setIsEditing(false); }} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 0, padding: "2px 6px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>บันทึก</button>
          <button onClick={() => setIsEditing(false)} style={{ background: "#f3f4f6", color: "#374151", border: "none", borderRadius: 0, padding: "2px 6px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>ยกเลิก</button>
        </div>
      );
    }
    return (
      <button onClick={() => { setIsEditing(true); setVal(""); }} style={{ background: "#f3f4f6", color: "#4b5563", border: "1px dashed #9ca3af", borderRadius: 0, padding: "4px 8px", fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}>
        + เพิ่มสถานะ
      </button>
    );
  };

  const laneMatch = plate => {
    const num = plateNum(plate);
    const matched = num ? Object.entries(detailMap).find(([k]) => plateNum(k) === num) : null;
    return matched ? matched[1] : new Set();
  };

  const StatusCell = ({ truck, compact }) => {
    if (!truck) return <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>รอเช็คอิน</span>;
    const anyQC = LOADING_LANES.some(l => truck.qcLanes?.[l.id]?.done);
    if (!anyQC) return <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>รอเข้าโหลด</span>;
    const fSize = compact ? 10 : 11;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: compact ? 3 : 5, alignItems: "center" }}>
        {LOADING_LANES.map(l => {
          const loaded = truck.loadLanes?.[l.id]?.done;
          const qcDone = truck.qcLanes?.[l.id]?.done;
          const waiting = truck.loadLanes?.[l.id]?.waiting && !loaded;
          if (loaded) return (
            <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#10b981", color: "#fff", borderRadius: 0, padding: compact ? "2px 7px 4px 6px" : "3px 10px 5px 8px", fontSize: fSize, fontWeight: 700, lineHeight: 1.4 }}>
              {l.tinyLabel}
              <span style={{ position: "absolute", bottom: -4, right: -4, background: "#059669", border: "2px solid #fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 900 }}>✓</span>
            </div>
          );
          if (waiting) return (
            <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#fbbf24", color: "#fff", borderRadius: 0, padding: compact ? "2px 7px 4px 6px" : "3px 10px 5px 8px", fontSize: fSize, fontWeight: 700, lineHeight: 1.4, whiteSpace: "nowrap" }}>
              รอสินค้า {l.tinyLabel}
              <span style={{ position: "absolute", bottom: -4, right: -4, background: "#d97706", border: "2px solid #fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8 }}>⏳</span>
            </div>
          );
          if (qcDone) return (
            <span key={l.id} style={{ fontSize: fSize, color: "#f97316", fontWeight: 700, whiteSpace: "nowrap" }}>กำลังโหลด {l.tinyLabel}</span>
          );
          return null;
        })}
      </div>
    );
  };

  const Step3Cell = ({ truck }) => {
    if (!truck) return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
    if (doneStep3(truck)) return <span style={{ color: "#10b981", fontWeight: 700, fontSize: 13 }}>✓</span>;
    if (canStep3(truck)) return (
      <button onClick={() => onUpdate(truck.id, { pickupPrinted: true, status: "picking", pickingAt: TIME_NOW() })}
        style={{ background: "#c2410c", color: "#fff", border: "none", borderRadius: 0, padding: "5px 8px", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>
        🖨️ เบิก
      </button>
    );
    return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
  };

  const Step6Cell = ({ truck }) => {
    if (!truck) return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
    if (doneStep6(truck)) return <span style={{ color: "#10b981", fontWeight: 700, fontSize: 13 }}>✓</span>;
    if (canStep6(truck)) return (
      <button onClick={() => onUpdate(truck.id, { summaryPrinted: true, summaryPrintedAt: TIME_NOW(), status: "summary_printed" })}
        style={{ background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 0, padding: "5px 8px", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>
        🖨️ สรุป
      </button>
    );
    return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>📦 ห้อง Picking</h2>

      <div style={{ background: "#fff", borderRadius: 0, overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            📋 คิวรถวันนี้ <span style={{ background: "#111", color: "#fff", borderRadius: 0, padding: "2px 8px", fontSize: 11, marginLeft: 4 }}>{filteredRows.length}</span>
          </div>
          <input type="text" placeholder="🔍 ค้นหาทะเบียนรถ..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 0, padding: "6px 12px", fontSize: 12, outline: "none", width: isMobile ? "100%" : 160 }} />
        </div>
        {filteredRows.length === 0
          ? <div style={{ padding: 36, textAlign: "center", color: "#9ca3af" }}>ยังไม่มีคิวรถ</div>
          : (
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 190px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 11 : 12 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: "#f9fafb" }}>
                  {(isMobile
                    ? ["ทะเบียน","ลาน","เวลา / สถานะ","Action"]
                    : ["ทะเบียน","กลุ่มลูกค้า", ...LOADING_LANES.map(l => l.tinyLabel), "เวลาเข้าโรงงาน","สถานะ","สถานะเพิ่มเติม","③ พิมพ์ใบเบิกสินค้า","⑥ พิมพ์ใบสรุปจ่าย"]
                  ).map(h => (
                    <th key={h} style={{ padding: isMobile ? "7px 6px" : "9px 12px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(({ key, plate, customerGroup, entryTime, truck }) => {
                  const lanes = laneMatch(plate);
                  return isMobile ? (
                    <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "8px 6px", fontWeight: 800 }}>
                        {plate}
                        <div style={{ fontWeight: 400, color: "#6b7280", fontSize: 10 }}>{customerGroup}</div>
                      </td>
                      <td style={{ padding: "8px 6px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {LOADING_LANES.map(l => (
                            <span key={l.id} style={{ fontSize: 10, fontWeight: 800, color: lanes.has(l.id) ? l.color : "#d1d5db" }}>
                              {l.tinyLabel}{lanes.has(l.id) ? "✓" : ""}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ padding: "8px 6px" }}>
                        <div style={{ fontWeight: 700, color: "#3b82f6" }}>{entryTime || "—"}</div>
                        <div style={{ marginTop: 4 }}><StatusCell truck={truck} compact /></div>
                        <div style={{ marginTop: 4 }}><ExtraStatusCell truck={truck} /></div>
                      </td>
                      <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                          <Step3Cell truck={truck} />
                          <Step6Cell truck={truck} />
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 800 }}>{plate}</td>
                      <td style={{ padding: "10px 12px", color: "#374151" }}>{customerGroup}</td>
                      {LOADING_LANES.map(l => (
                        <td key={l.id} style={{ padding: "10px 12px", textAlign: "center" }}>
                          {lanes.has(l.id)
                            ? <span style={{ color: l.color, fontWeight: 900, fontSize: 16 }}>✓</span>
                            : <span style={{ color: "#e5e7eb" }}>—</span>}
                        </td>
                      ))}
                      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700, color: "#3b82f6" }}>{entryTime || "—"}</div>
                        {truck?.arrivedAt
                          ? <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>เข้าจริง {truck.arrivedAt}</div>
                          : <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>(รถยังไม่เข้าโรงงาน)</div>}
                      </td>
                      <td style={{ padding: "10px 12px" }}><StatusCell truck={truck} /></td>
                      <td style={{ padding: "10px 12px" }}><ExtraStatusCell truck={truck} /></td>
                      <td style={{ padding: "10px 12px" }}><Step3Cell truck={truck} /></td>
                      <td style={{ padding: "10px 12px" }}><Step6Cell truck={truck} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
};

// ── 4. QC (per-lane) ──────────────────────────────────────────────────────────
const QC = ({ trucks, onUpdate, laneId }) => {
  const [selId,     setSelId]     = useState("");
  const lane = laneId;
  const [temp,      setTemp]      = useState("");
  const [photo,     setPhoto]     = useState(null);
  const [flashLane, setFlashLane] = useState(null);
  const [uploading, setUploading] = useState(false);

  // รับทุกรถที่สถานะ "picking" (พิมพ์เบิกแล้ว)
  const eligible = trucks.filter(t => ["arrived", "picking"].includes(t.status) && t.customerGroup !== "CPFTH");
  const sel      = trucks.find(t => t.id === selId) || null;
  const actLane  = LOADING_LANES.find(l => l.id === lane);
  const thisLaneQCd = sel?.qcLanes?.[lane]?.done;

  const handlePhoto = e => {
    const files = Array.from(e.target.files).slice(0, 15); if (!files.length) return;
    Promise.all(files.map(compressImage)).then(newPhotos => {
      setPhoto(prev => {
        const p = Array.isArray(prev) ? prev : (prev ? [prev] : []);
        return [...p, ...newPhotos].slice(0, 15);
      });
    });
  };

  const handleSubmit = async () => {
    if (!sel || !temp || uploading) return;
    setUploading(true);
    try {
      const photoUrls = await uploadPhotos(`qc`, sel.plate, Array.isArray(photo) ? photo : (photo ? [photo] : []));
      const qcLanes = { ...(sel.qcLanes || {}), [lane]: { done: true, temp, photos: photoUrls, doneAt: TIME_NOW() } };
      onUpdate(sel.id, { qcLanes });
      setFlashLane(lane); setTemp(""); setPhoto(null);
      setTimeout(() => setFlashLane(null), 2500);
    } catch (e) {
      alert("อัพโหลดรูปไม่สำเร็จ: " + e.message);
    } finally {
      setUploading(false);
    }
  };

  const hasAnyQC = t => t.qcLanes && Object.values(t.qcLanes).some(l => l.done);

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>ลานโหลด → {actLane.label}</h2>

      {flashLane && (
        <div style={{ padding: "13px 16px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 14, display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="check" size={18} /> QC ผ่าน → พร้อมเข้า {LOADING_LANES.find(l => l.id === flashLane)?.label}
        </div>
      )}
      {/* เลือกรถ */}
      <div style={{ background: "#fff", borderRadius: 0, padding: 18, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 }}>เลือกทะเบียนรถ</label>
        <select value={selId} onChange={e => { setSelId(e.target.value); setTemp(""); setPhoto(null); }}
          style={{ width: "100%", border: "1.5px solid #e5e7eb", borderRadius: 0, padding: "11px 12px", fontSize: 15, outline: "none", boxSizing: "border-box" }}>
          <option value="">-- เลือกทะเบียนรถที่รอเข้าโหลด --</option>
          {eligible.map(t => <option key={t.id} value={t.id}>{t.loadLanes?.[lane]?.waiting ? "⏳ " : ""}{t.plate} · {t.customerGroup || t.product}</option>)}
        </select>
        {sel && (
          <div style={{ marginTop: 10 }}>
            <div style={{ background: "#f9fafb", borderRadius: 0, padding: "8px 12px", fontSize: 13, marginBottom: 8 }}>
              <b>{sel.product}</b>{sel.destination ? ` → ${sel.destination}` : ""}
            </div>
            {/* สรุป QC รายลาน */}
            <div style={{ display: "flex", gap: 6 }}>
              {LOADING_LANES.map(l => {
                const qc = sel.qcLanes?.[l.id];
                return (
                  <div key={l.id} style={{ flex: 1, background: qc?.done ? l.bg : "#f3f4f6", border: `1px solid ${qc?.done ? l.border : "#e5e7eb"}`, borderRadius: 0, padding: "6px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: qc?.done ? l.color : "#9ca3af", lineHeight: 1.4 }}>{l.shortLabel}</div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: qc?.done ? l.color : "#9ca3af" }}>
                      {qc?.done ? `${qc.temp}°C ✓` : "รอ QC"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ฟอร์มลาน */}
      <div style={{ background: actLane.bg, border: `2px solid ${actLane.border}`, borderRadius: 0, padding: 18, marginBottom: 12 }}>
        {thisLaneQCd && (
          <div style={{ padding: "9px 12px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 12, fontSize: 13 }}>
            ✅ {actLane.label} QC แล้ว: {sel.qcLanes[lane].temp}°C — สามารถวัดซ้ำได้
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: actLane.color }}>{actLane.label}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>วัดอุณหภูมิก่อนรถเข้าลานนี้</div>
        </div>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 5 }}>อุณหภูมิ (°C)</label>
        <input value={temp} onChange={e => setTemp(e.target.value)} type="number" placeholder="-4"
          style={{ width: "100%", border: `2px solid ${actLane.border}`, borderRadius: 0, padding: "12px 14px", fontSize: 26, fontWeight: 900, outline: "none", boxSizing: "border-box", color: actLane.color, background: "#fff", textAlign: "center", marginBottom: 12 }} />
        <PhotoUploader label="📷 ถ่ายรูปอุณหภูมิ" value={photo} onChange={handlePhoto} onRemove={setPhoto} />
      </div>

      <button onClick={handleSubmit} disabled={!sel || !temp || uploading}
        style={{ width: "100%", background: sel && temp && !uploading ? actLane.color : "#e5e7eb", color: sel && temp && !uploading ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "14px 0", fontWeight: 700, fontSize: 15, cursor: sel && temp && !uploading ? "pointer" : "default", marginBottom: 20 }}>
        {uploading ? "⏳ กำลังอัพโหลดรูป..." : !sel ? "เลือกทะเบียนรถก่อน" : !temp ? "กรอกอุณหภูมิก่อน" : `✅ บันทึก QC → ${actLane.label}`}
      </button>

    </div>
  );
};

// ── 4b. RANDOM SAMPLE CHECK (per-lane, photo only, no temp) ───────────────────
const RandomSampleCheck = ({ trucks, onUpdate, laneId }) => {
  const [selId,     setSelId]     = useState("");
  const lane = laneId;
  const [photo,     setPhoto]     = useState(null);
  const [note,      setNote]      = useState("");
  const [flashLane, setFlashLane] = useState(null);
  const [uploading, setUploading] = useState(false);

  const eligible = trucks.filter(t => ["arrived", "picking"].includes(t.status) && t.customerGroup !== "CPFTH");
  const sel      = trucks.find(t => t.id === selId) || null;
  const actLane  = LOADING_LANES.find(l => l.id === lane);
  const photos   = Array.isArray(photo) ? photo : (photo ? [photo] : []);
  const thisLaneChecked = sel?.sampleLanes?.[lane]?.done;

  const handlePhoto = e => {
    const files = Array.from(e.target.files).slice(0, 15); if (!files.length) return;
    Promise.all(files.map(compressImage)).then(newPhotos => {
      setPhoto(prev => {
        const p = Array.isArray(prev) ? prev : (prev ? [prev] : []);
        return [...p, ...newPhotos].slice(0, 15);
      });
    });
  };

  const handleSubmit = async () => {
    if (!sel || !photos.length || uploading) return;
    setUploading(true);
    try {
      const photoUrls = await uploadPhotos(`sample`, sel.plate, photos);
      const sampleLanes = { ...(sel.sampleLanes || {}), [lane]: { done: true, photos: photoUrls, note, doneAt: TIME_NOW() } };
      onUpdate(sel.id, { sampleLanes });
      setFlashLane(lane); setPhoto(null); setNote("");
      setTimeout(() => setFlashLane(null), 2500);
    } catch (e) {
      alert("อัพโหลดรูปไม่สำเร็จ: " + e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>ตรวจอุณหภูมิ → {actLane.label}</h2>

      {flashLane && (
        <div style={{ padding: "13px 16px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 14, display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="check" size={18} /> บันทึกตรวจแล้ว → {actLane.label}
        </div>
      )}
      {/* เลือกรถ */}
      <div style={{ background: "#fff", borderRadius: 0, padding: 18, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 }}>เลือกทะเบียนรถ</label>
        <select value={selId} onChange={e => { setSelId(e.target.value); setPhoto(null); setNote(""); }}
          style={{ width: "100%", border: "1.5px solid #e5e7eb", borderRadius: 0, padding: "11px 12px", fontSize: 15, outline: "none", boxSizing: "border-box" }}>
          <option value="">-- เลือกทะเบียนรถ --</option>
          {eligible.map(t => <option key={t.id} value={t.id}>{t.plate} · {t.customerGroup || t.product}</option>)}
        </select>
        {sel && (
          <div style={{ marginTop: 10 }}>
            <div style={{ background: "#f9fafb", borderRadius: 0, padding: "8px 12px", fontSize: 13, marginBottom: 8 }}>
              <b>{sel.product}</b>{sel.destination ? ` → ${sel.destination}` : ""}
            </div>
            {/* สรุปตรวจรายลาน */}
            <div style={{ display: "flex", gap: 6 }}>
              {LOADING_LANES.map(l => {
                const sc = sel.sampleLanes?.[l.id];
                return (
                  <div key={l.id} style={{ flex: 1, background: sc?.done ? l.bg : "#f3f4f6", border: `1px solid ${sc?.done ? l.border : "#e5e7eb"}`, borderRadius: 0, padding: "6px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: sc?.done ? l.color : "#9ca3af", lineHeight: 1.4 }}>{l.shortLabel}</div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: sc?.done ? l.color : "#9ca3af" }}>
                      {sc?.done ? "📷 ตรวจแล้ว" : "รอตรวจ"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ฟอร์มลาน */}
      <div style={{ background: actLane.bg, border: `2px solid ${actLane.border}`, borderRadius: 0, padding: 18, marginBottom: 12 }}>
        {thisLaneChecked && (
          <div style={{ padding: "9px 12px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 12, fontSize: 13 }}>
            ✅ {actLane.label} ตรวจแล้ว — สามารถตรวจซ้ำได้
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: actLane.color }}>{actLane.label}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>ตรวจอุณหภูมิสินค้าก่อนโหลดขึ้นรถ — ถ่ายรูปยืนยัน</div>
        </div>
        <textarea
          placeholder="Note (ถ้ามี)"
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          style={{ width: "100%", border: `1.5px solid ${actLane.border}`, borderRadius: 0, padding: "10px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 12, resize: "vertical", fontFamily: "inherit" }}
        />
        <PhotoUploader label="📷 ถ่ายรูปอุณหภูมิ" value={photo} onChange={handlePhoto} onRemove={setPhoto} />
      </div>

      <button onClick={handleSubmit} disabled={!sel || !photos.length || uploading}
        style={{ width: "100%", background: sel && photos.length && !uploading ? actLane.color : "#e5e7eb", color: sel && photos.length && !uploading ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "14px 0", fontWeight: 700, fontSize: 15, cursor: sel && photos.length && !uploading ? "pointer" : "default", marginBottom: 20 }}>
        {uploading ? "⏳ กำลังอัพโหลดรูป..." : !sel ? "เลือกทะเบียนรถก่อน" : !photos.length ? "แนบรูปก่อน" : `✅ บันทึกตรวจ → ${actLane.label}`}
      </button>

    </div>
  );
};

// ── 5. LOADING YARD (per-lane gate) ───────────────────────────────────────────
const LoadingYard = ({ trucks, onUpdate, laneId }) => {
  const [activeLane, setActiveLane] = useState(laneId ?? "lane_parts");
  const [forms, setForms] = useState({
    lane_parts: { selId: "", photo: null, note: "", flash: false, uploading: false },
    lane_head:  { selId: "", photo: null, note: "", flash: false, uploading: false },
    lane_pork:  { selId: "", photo: null, note: "", flash: false, uploading: false },
  });
  const setF = (lId, upd) => setForms(p => ({ ...p, [lId]: { ...p[lId], ...upd } }));
  const curLane = LOADING_LANES.find(l => l.id === activeLane);
  const form    = forms[activeLane];

  // รถที่ QC ลานนี้ผ่านแล้ว และยังไม่ได้โหลดลานนี้
  const eligibleForLane = (laneId) => trucks.filter(t =>
    ["arrived", "picking"].includes(t.status) &&
    t.customerGroup !== "CPFTH" &&
    t.qcLanes?.[laneId]?.done &&
    !t.loadLanes?.[laneId]?.done
  );
  const eligible = eligibleForLane(activeLane);
  const sel = trucks.find(t => t.id === form.selId) || null;

  const handlePhoto = lId => e => {
    const files = Array.from(e.target.files).slice(0, 15); if (!files.length) return;
    Promise.all(files.map(compressImage)).then(newPhotos => {
      setForms(prev => {
        const f = prev[lId];
        const curPhotos = Array.isArray(f.photo) ? f.photo : (f.photo ? [f.photo] : []);
        return { ...prev, [lId]: { ...f, photo: [...curPhotos, ...newPhotos].slice(0, 15) } };
      });
    });
  };

  const handleWaiting = () => {
    if (!sel) return;
    if (!window.confirm(`ยืนยัน: ${sel.plate} — รอเติมสินค้า?`)) return;
    const loadLanes = { ...(sel.loadLanes || {}), [activeLane]: { ...(sel.loadLanes?.[activeLane] || {}), waiting: true, waitingAt: TIME_NOW(), note: form.note } };
    onUpdate(sel.id, { loadLanes });
    setF(activeLane, { selId: "", photo: null, note: "" });
  };

  const handleLoad = async () => {
    if (!sel) return;
    if (!window.confirm(`ยืนยัน: บันทึกโหลดเสร็จ ${sel.plate}?`)) return;
    setF(activeLane, { uploading: true });
    try {
      const photos = Array.isArray(form.photo) ? form.photo : (form.photo ? [form.photo] : []);
      const photoUrls = await uploadPhotos(`loading/${activeLane}`, sel.plate, photos);
      const existing = sel.loadLanes?.[activeLane] || {};
      const loadLanes = { ...(sel.loadLanes || {}), [activeLane]: { ...existing, done: true, photos: photoUrls, note: form.note, doneAt: TIME_NOW() } };
      onUpdate(sel.id, { loadLanes });
      setF(activeLane, { selId: "", photo: null, note: "", flash: true, uploading: false });
      setTimeout(() => setF(activeLane, { flash: false }), 2500);
    } catch (e) {
      alert("อัพโหลดรูปไม่สำเร็จ: " + e.message);
      setF(activeLane, { uploading: false });
    }
  };

  const doneTrucks = trucks.filter(t => ["summary_printed","invoiced"].includes(t.status));

  const LaneSummary = ({ t }) => (
    <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
      {LOADING_LANES.map(l => {
        const qc  = t.qcLanes?.[l.id];
        const ld  = t.loadLanes?.[l.id];
        const bg  = ld?.done ? l.bg : qc?.done ? "#fef9c3" : "#f9fafb";
        const bdr = ld?.done ? l.border : qc?.done ? "#fde047" : "#e5e7eb";
        return (
          <div key={l.id} style={{ flex: 1, background: bg, border: `1px solid ${bdr}`, borderRadius: 0, padding: "5px 4px", textAlign: "center" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: ld?.done ? l.color : qc?.done ? "#713f12" : "#9ca3af" }}>{l.tinyLabel}</div>
            <div style={{ fontSize: 9, fontWeight: 800, color: ld?.done ? l.color : qc?.done ? "#713f12" : "#9ca3af", lineHeight: 1.3 }}>
              {ld?.done ? `✓ ${ld.doneAt}` : qc?.done ? `QC ${qc.temp}°C` : "–"}
            </div>
            {ld?.photo && <img src={ld.photo} alt="" style={{ width: "100%", borderRadius: 0, marginTop: 2, height: 28, objectFit: "cover" }} />}
          </div>
        );
      })}
    </div>
  );

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>Checker {curLane.label}</h2>

      {/* ฟอร์มลาน */}
      <div style={{ background: curLane.bg, border: `2px solid ${curLane.border}`, borderRadius: 0, padding: 20, marginBottom: 16 }}>
        {form.flash && (
          <div style={{ padding: "11px 14px", background: "#d1fae5", borderRadius: 0, color: "#065f46", fontWeight: 700, marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <Icon name="check" size={16} /> บันทึกโหลดเสร็จ → Checker {curLane.label}
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 16, color: curLane.color }}>Checker {curLane.label}</div>
        </div>
        <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>เลือกทะเบียนรถ</label>
        <select value={form.selId} onChange={e => setF(activeLane, { selId: e.target.value })}
          style={{ width: "100%", border: `1.5px solid ${curLane.border}`, borderRadius: 0, padding: "11px 12px", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12, background: "#fff" }}>
          <option value="">-- เลือกทะเบียนรถ --</option>
          {eligible.map(t => <option key={t.id} value={t.id}>{t.loadLanes?.[activeLane]?.waiting ? "⏳ " : ""}{t.plate} · {t.customerGroup || t.product}</option>)}
        </select>
        {sel && (
          <div style={{ background: "#fff", borderRadius: 0, padding: "9px 12px", fontSize: 13, marginBottom: 12, border: `1px solid ${curLane.border}`, display: "flex", flexDirection: "column", gap: 4 }}>
            <span><b>กลุ่มลูกค้า:</b> {sel.customerGroup || sel.product}</span>
            {sel.destination && <span><b>ปลายทาง:</b> {sel.destination}</span>}
          </div>
        )}
        <textarea
          placeholder="Note (ถ้ามี)"
          value={form.note}
          onChange={e => setF(activeLane, { note: e.target.value })}
          rows={2}
          style={{ width: "100%", border: `1.5px solid ${curLane.border}`, borderRadius: 0, padding: "10px 12px", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 12, resize: "vertical", fontFamily: "inherit" }}
        />
        <PhotoUploader label="📷 ถ่ายรูปหลังโหลดเสร็จ" value={form.photo} onChange={handlePhoto(activeLane)} onRemove={photos => setF(activeLane, { photo: photos })} />
        <button onClick={handleWaiting} disabled={!sel || form.uploading}
          style={{ width: "100%", background: sel && !form.uploading ? "#f59e0b" : "#e5e7eb", color: sel && !form.uploading ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "13px 0", fontWeight: 700, fontSize: 15, cursor: sel && !form.uploading ? "pointer" : "default", marginBottom: 8 }}>
          ⏳ รอเติมสินค้า
        </button>
        <button onClick={handleLoad} disabled={!sel || form.uploading}
          style={{ width: "100%", background: sel && !form.uploading ? curLane.color : "#e5e7eb", color: sel && !form.uploading ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "13px 0", fontWeight: 700, fontSize: 15, cursor: sel && !form.uploading ? "pointer" : "default" }}>
          {form.uploading ? "⏳ กำลังอัพโหลดรูป..." : "✅ บันทึกโหลดเสร็จ"}
        </button>
      </div>

    </div>
  );
};

// ── 6.5 LOADING LOG (chat-style feed of completed loads) ─────────────────────
// the work-day rolls over at 10:00, not midnight — must stay in sync everywhere
// a "which work-day does this belong to" decision is made (cycleDateStr,
// handleReset's archive-date calc, and the two helpers below), otherwise a time
// or date can get filed under the wrong work-day in one place but not another.
const WORK_DAY_CUTOFF_HOUR = 10;

const cycleDateStr = () => {
  const d = new Date();
  if (d.getHours() < WORK_DAY_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// doneAt is just "HH:mm"; events before the cutoff belong to the work-day's
// *next* calendar date (truck loaded after midnight, e.g. 00:14, still files under
// the previous work-day) — show that real date next to the time so it's not confusing.
const formatLogTime = (doneAt, workDate) => {
  const hour = parseInt(doneAt.split(":")[0], 10);
  if (hour >= WORK_DAY_CUTOFF_HOUR) return doneAt;
  const [y, m, d] = workDate.split("-").map(Number);
  const realDate = new Date(y, m - 1, d + 1);
  const dd = String(realDate.getDate()).padStart(2, "0");
  const mm = String(realDate.getMonth() + 1).padStart(2, "0");
  return `${doneAt} (${dd}/${mm})`;
};

// converts "HH:mm" into a sortable minute value that respects the work-day
// cutoff: times before the cutoff belong to the *next* calendar day, so they must
// sort after evening times of the same work-day (e.g. 18:00 < 00:14 next day).
const workTimeValue = (doneAt) => {
  const [h, m] = doneAt.split(":").map(Number);
  return (h < WORK_DAY_CUTOFF_HOUR ? h + 24 : h) * 60 + m;
};

const buildLaneEvents = (list, sources) => {
  const events = [];
  for (const t of list || []) {
    for (const src of sources) {
      for (const lane of LOADING_LANES) {
        const ld = t[src.field]?.[lane.id];
        if (ld?.done && ld?.doneAt) {
          events.push({
            key: `${t.id}_${src.field}_${lane.id}`,
            truckId: t.id,
            field: src.field,
            laneId: lane.id,
            plate: t.plate,
            customerGroup: t.customerGroup || "",
            zone: t.zone || "",
            laneLabel: lane.tinyLabel,
            laneColor: lane.color,
            laneBg: lane.bg,
            doneAt: ld.doneAt,
            photos: ld.photos || [],
            doneLabel: src.doneLabel,
            note: src.field === "qcLanes" ? (ld.temp != null ? `${ld.temp}°C` : "") : ld.note,
          });
        }
      }
    }
  }
  return events.sort((a, b) => workTimeValue(a.doneAt) - workTimeValue(b.doneAt));
};

const EventLog = ({ trucks, title, emptyMsg }) => {
  const isMobile = useIsMobile();
  const today = cycleDateStr();
  const [date, setDate] = useState(today);
  const [sourceFilter, setSourceFilter] = useState("");
  const [plateFilter, setPlateFilter] = useState("");
  const [extraFilter, setExtraFilter] = useState("");
  const [archiveTrucks, setArchiveTrucks] = useState(null);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const [zoomUrl, setZoomUrl] = useState(null);

  // always check the archive for the selected date — even when it equals "today" by
  // the wall-clock cutoff — because pressing "ล้างวันใหม่" archives that work-day and
  // empties the live trucks table before the work-day cutoff passes; without this check
  // the Log would keep showing the now-empty live data instead of the archived snapshot
  useEffect(() => {
    setArchiveTrucks(null);
    setLoadingArchive(date !== today);
    supabase.from("wh_archive").select("trucks").eq("archive_date", date).single()
      .then(({ data }) => setArchiveTrucks(data?.trucks ?? null))
      .finally(() => setLoadingArchive(false));
  }, [date, today]);

  const allSources = Object.values(LOG_SOURCES);
  const activeSources = sourceFilter ? allSources.filter(s => s.field === sourceFilter) : allSources;
  const sourceTrucks = archiveTrucks ?? (date === today ? trucks : []);
  const events = buildLaneEvents(sourceTrucks, activeSources).filter(ev => {
    const matchesPlate = !plateFilter.trim() || ev.plate?.toLowerCase().includes(plateFilter.trim().toLowerCase());
    const extraQuery = extraFilter.trim().toLowerCase();
    const matchesExtra = !extraQuery
      || ev.zone?.toLowerCase().includes(extraQuery)
      || ev.customerGroup?.toLowerCase().includes(extraQuery)
      || ev.note?.toLowerCase().includes(extraQuery);
    return matchesPlate && matchesExtra;
  });

  const truckById = new Map((sourceTrucks || []).map(t => [t.id, t]));
  const latestLoadDoneAt = truckId => {
    const t = truckById.get(truckId);
    let latest = null;
    for (const lane of LOADING_LANES) {
      const ld = t?.loadLanes?.[lane.id];
      if (ld?.done && ld?.doneAt && (latest == null || workTimeValue(ld.doneAt) > workTimeValue(latest))) latest = ld.doneAt;
    }
    return latest;
  };

  const groupsByTruck = [];
  const groupIndex = new Map();
  for (const ev of events) {
    let group = groupIndex.get(ev.truckId);
    if (!group) {
      group = { truckId: ev.truckId, plate: ev.plate, customerGroup: ev.customerGroup, zone: ev.zone, doneAt: ev.doneAt, loadDoneAt: latestLoadDoneAt(ev.truckId), lanes: [] };
      groupIndex.set(ev.truckId, group);
      groupsByTruck.push(group);
    }
    group.lanes.push(ev);
    if (workTimeValue(ev.doneAt) > workTimeValue(group.doneAt)) group.doneAt = ev.doneAt;
  }
  // trucks with a "โหลดเสร็จ" action (any lane) always rank above trucks without one,
  // sorted by recency within each bucket
  groupsByTruck.sort((a, b) => {
    if (!!a.loadDoneAt !== !!b.loadDoneAt) return a.loadDoneAt ? -1 : 1;
    const aTime = a.loadDoneAt ? workTimeValue(a.loadDoneAt) : workTimeValue(a.doneAt);
    const bTime = b.loadDoneAt ? workTimeValue(b.loadDoneAt) : workTimeValue(b.doneAt);
    return bTime - aTime;
  });
  // within each truck, group entries by physical lane (ลานชิ้นส่วน/หัวเครื่องใน/หมูซีก) first —
  // a truck using multiple lanes shows each lane's full sequence together instead of interleaved —
  // lane groups are ordered by their most recent activity (the lane that finished first sinks
  // to the bottom), then by work step (ลานโหลด → QC → Checker), then by time
  const FIELD_ORDER = { qcLanes: 0, sampleLanes: 1, loadLanes: 2 };
  for (const group of groupsByTruck) {
    const laneLatest = {};
    for (const ev of group.lanes) {
      const t = workTimeValue(ev.doneAt);
      if (laneLatest[ev.laneId] == null || t > laneLatest[ev.laneId]) laneLatest[ev.laneId] = t;
    }
    group.lanes.sort((a, b) =>
      laneLatest[b.laneId] - laneLatest[a.laneId]
      || FIELD_ORDER[a.field] - FIELD_ORDER[b.field]
      || workTimeValue(a.doneAt) - workTimeValue(b.doneAt)
    );
  }

  const inp = { border: "1.5px solid #d1d5db", borderRadius: 0, padding: "9px 12px", fontSize: 14, fontWeight: 600, boxSizing: "border-box", outline: "none", width: isMobile ? "100%" : undefined };

  return (
    <div style={{ maxWidth: 560, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
      <h2 style={{ margin: "0 0 14px", fontWeight: 900, fontSize: isMobile ? 18 : 22 }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: 8 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} />
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={{ ...inp, flex: isMobile ? undefined : 1, minWidth: isMobile ? undefined : 160 }}>
          <option value="">ทั้งหมด</option>
          {allSources.map(s => <option key={s.field} value={s.field}>{s.filterLabel}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: 16 }}>
        <input type="text" placeholder="ค้นหาทะเบียนรถ" value={plateFilter} onChange={e => setPlateFilter(e.target.value)} style={{ ...inp, flex: isMobile ? undefined : 1, minWidth: isMobile ? undefined : 140 }} />
        <input type="text" placeholder="ค้นหา Zone / กลุ่มลูกค้า / Note" value={extraFilter} onChange={e => setExtraFilter(e.target.value)} style={{ ...inp, flex: isMobile ? undefined : 1, minWidth: isMobile ? undefined : 160 }} />
      </div>

      {loadingArchive && <div style={{ textAlign: "center", color: "#9ca3af", padding: 30 }}>กำลังโหลด...</div>}

      {!loadingArchive && groupsByTruck.length === 0 && (
        <div style={{ textAlign: "center", color: "#9ca3af", padding: 30 }}>{emptyMsg}</div>
      )}

      {!loadingArchive && groupsByTruck.map(group => (
        <div key={group.truckId} style={{ background: "#fff", borderRadius: 0, padding: isMobile ? 12 : 14, marginBottom: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", border: "1px solid #e5e7eb" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
            <b style={{ fontSize: 15 }}>{group.plate}</b>
          </div>
          {(group.customerGroup || group.zone) && (
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
              {group.customerGroup && <span>กลุ่มลูกค้า: {group.customerGroup}</span>}
              {group.customerGroup && group.zone && <span> · </span>}
              {group.zone && <span>Zone: {group.zone}</span>}
            </div>
          )}
          {group.lanes.map((ev, i) => (
            <div key={ev.key} style={{ borderTop: i === 0 ? "none" : "1px dashed #e5e7eb", paddingTop: i === 0 ? 0 : 10, marginTop: i === 0 ? 0 : 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ev.photos.length || ev.note ? 8 : 0, flexWrap: "wrap", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ background: ev.laneBg, color: ev.laneColor, borderRadius: 0, padding: "3px 8px", fontSize: 12, fontWeight: 700 }}>
                    {ev.laneLabel}
                  </span>
                  <span style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}>{ev.doneLabel}</span>
                </div>
                <span style={{ fontSize: 12, color: "#9ca3af" }}>{formatLogTime(ev.doneAt, date)}</span>
              </div>
              {ev.note && <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>{ev.note}</div>}
              {ev.photos.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 64 : 80}px, 1fr))`, gap: 6 }}>
                  {ev.photos.map((url, idx) => (
                    <img key={idx} src={url} alt="" onClick={() => setZoomUrl(url)}
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 0, cursor: "pointer" }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {zoomUrl && (
        <div onClick={() => setZoomUrl(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 20, cursor: "zoom-out" }}>
          <img src={zoomUrl} alt="" onClick={e => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "75vh", borderRadius: 0, cursor: "default" }} />
          <button onClick={e => { e.stopPropagation(); saveImageToDevice(zoomUrl, `photo-${Date.now()}.jpg`); }}
            style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 0, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            💾 บันทึกรูปลงเครื่อง
          </button>
        </div>
      )}
    </div>
  );
};

const LOG_SOURCES = {
  loadLanes:   { field: "loadLanes",   filterLabel: "การโหลดจ่ายสินค้า",      doneLabel: "✅ Checker นับตะกร้าและโหลดเสร็จแล้ว" },
  qcLanes:     { field: "qcLanes",     filterLabel: "การตรวจอุณหภูมิรถขนส่ง", doneLabel: "🌡️ ลานโหลด ตรวจสอบอุณหภูมิรถแล้ว" },
  sampleLanes: { field: "sampleLanes", filterLabel: "การตรวจอุณหภูมิสินค้า",   doneLabel: "📷 QC สุ่มตรวจอุณหภูมิสินค้าแล้ว" },
};

const OverviewLog = ({ trucks }) => (
  <EventLog trucks={trucks} title="💬 Log ภาพรวมการทำงาน" emptyMsg="ยังไม่มีรายการทำงาน" />
);

// ── 7. PLANNING ───────────────────────────────────────────────────────────────
const Planning = ({ trucks, queue, onUpdate }) => {
  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const usedPlan = new Set();
  const matchTruckPlan = q => {
    let t = trucks.find(t => t.queueId === q.id && !usedPlan.has(t.id));
    if (!t) t = trucks.find(t => !t.queueId && plateNum(t.plate) === plateNum(q.plate) && plateNum(q.plate) !== "" && !usedPlan.has(t.id));
    if (t) usedPlan.add(t.id);
    return t;
  };
  const planQueueRows = queue.map(q => ({ key: q.id, plate: q.plate, customerGroup: q.customerGroup, truck: matchTruckPlan(q) }));
  const walkIns = trucks.filter(t => !usedPlan.has(t.id));
  const allRows = [
    ...planQueueRows,
    ...walkIns.map(t => ({ key: t.id, plate: t.plate, customerGroup: t.customerGroup || "–", truck: t })),
  ].sort((a, b) => {
    const rank = t => {
      if (!t) return 1;
      if (t.status === "invoiced") return 3;     // ออกแล้ว → ล่าง
      if (t.status === "summary_printed") return 0; // ออกได้เลย → บน
      return 2;
    };
    return rank(a.truck) - rank(b.truck);
  }).filter(row => row.customerGroup !== "CPFTH");

  const Tick = () => <span style={{ color: "#10b981", fontWeight: 700, fontSize: 13 }}>✓</span>;
  const Dash = () => <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;

  return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontWeight: 900, fontSize: 22 }}>📄 ห้องวางแผน</h2>

      <div style={{ background: "#fff", borderRadius: 0, overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", fontWeight: 700, fontSize: 14 }}>
          📋 คิวรถวันนี้ <span style={{ background: "#111", color: "#fff", borderRadius: 0, padding: "2px 8px", fontSize: 11, marginLeft: 4 }}>{allRows.length}</span>
        </div>
        {allRows.length === 0
          ? <div style={{ padding: 36, textAlign: "center", color: "#9ca3af" }}>ยังไม่มีคิวรถ</div>
          : (
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 190px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: "#f9fafb" }}>
                  {["ทะเบียน","กลุ่มลูกค้า","เวลาเข้าโรงงาน","สถานะ","③ ใบเบิกสินค้า","⑥ ใบสรุปจ่าย","⑦ ใบ Invoice"].map(h => (
                    <th key={h} style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allRows.map(({ key, plate, customerGroup, entryTime, truck }) => (
                  <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 800 }}>{plate}</td>
                    <td style={{ padding: "10px 12px", color: "#374151" }}>{customerGroup}</td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700, color: "#3b82f6" }}>{entryTime || "—"}</div>
                      {truck?.arrivedAt
                        ? <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>เข้าจริง {truck.arrivedAt}</div>
                        : <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>(รถยังไม่เข้าโรงงาน)</div>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {!truck
                        ? <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>รอเช็คอิน</span>
                        : (() => {
                            const anyQC = LOADING_LANES.some(l => truck.qcLanes?.[l.id]?.done);
                            return (
                              <div>
                                {!anyQC
                                  ? <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>รอเข้าโหลด</span>
                                  : <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
                                      {LOADING_LANES.map(l => {
                                        const loaded = truck.loadLanes?.[l.id]?.done;
                                        const qcDone = truck.qcLanes?.[l.id]?.done;
                                        const waiting = truck.loadLanes?.[l.id]?.waiting && !loaded;
                                        if (loaded) return (
                                          <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#10b981", color: "#fff", borderRadius: 0, padding: "3px 10px 5px 8px", fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
                                            {l.tinyLabel}
                                            <span style={{ position: "absolute", bottom: -4, right: -4, background: "#059669", border: "2px solid #fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 900 }}>✓</span>
                                          </div>
                                        );
                                        if (waiting) return (
                                          <div key={l.id} style={{ position: "relative", display: "inline-block", background: "#fbbf24", color: "#fff", borderRadius: 0, padding: "3px 10px 5px 8px", fontSize: 11, fontWeight: 700, lineHeight: 1.4, whiteSpace: "nowrap" }}>
                                            รอสินค้า {l.tinyLabel}
                                            <span style={{ position: "absolute", bottom: -4, right: -4, background: "#d97706", border: "2px solid #fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8 }}>⏳</span>
                                          </div>
                                        );
                                        if (qcDone) return (
                                          <span key={l.id} style={{ fontSize: 11, color: "#f97316", fontWeight: 700, whiteSpace: "nowrap" }}>กำลังโหลด {l.tinyLabel}</span>
                                        );
                                        return null;
                                      })}
                                    </div>
                                }
                              </div>
                            );
                          })()
                      }
                    </td>
                    <td style={{ padding: "10px 12px" }}>{truck?.pickupPrinted ? <Tick/> : <Dash/>}</td>
                    <td style={{ padding: "10px 12px" }}>{truck?.summaryPrinted ? <Tick/> : <Dash/>}</td>
                    <td style={{ padding: "10px 12px" }}>
                      {!truck || !["summary_printed","invoiced"].includes(truck.status)
                        ? <Dash/>
                        : truck.status === "invoiced"
                        ? <Tick/>
                        : <button onClick={() => onUpdate(truck.id, { invoiceDone: true, status: "invoiced", invoicedAt: TIME_NOW() })}
                            style={{ background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "5px 8px", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>
                            ออก Invoice
                          </button>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ── DOWNLOAD ─────────────────────────────────────────────────────────────────
const Download = ({ onReset }) => {
  const [exportDate, setExportDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [archives, setArchives] = useState([]);
  const [deleteDate, setDeleteDate] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadArchives = () => {
    supabase.from("wh_archive").select("archive_date").order("archive_date", { ascending: false })
      .then(({ data }) => setArchives((data || []).map(r => r.archive_date)));
  };

  useEffect(() => { loadArchives(); }, []);

  const handleDownload = async () => {
    if (!exportDate) return;
    setLoading(true);
    await exportArchiveExcel(exportDate);
    setLoading(false);
  };

  const handleDeleteArchive = async () => {
    if (!deleteDate) return;
    if (!window.confirm(`ลบข้อมูล Archive วันที่ ${deleteDate} ถาวร?`)) return;
    setDeleting(true);
    await supabase.from("wh_archive").delete().eq("archive_date", deleteDate);
    setDeleteDate("");
    loadArchives();
    setDeleting(false);
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontWeight: 900, fontSize: 22 }}>จบการทำงาน</h2>

      <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 24, maxWidth: 480, marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>🗑️ ล้างวันใหม่</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>ล้างข้อมูลรถและคิวทั้งหมด แล้วเริ่มต้นวันใหม่ ข้อมูลจะถูก archive ไว้ก่อน</div>
        <button onClick={onReset}
          style={{ background: "#fee2e2", color: "#991b1b", border: "1.5px solid #fca5a5", borderRadius: 0, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", width: "100%" }}>
          🗑️ ล้างวันใหม่
        </button>
      </div>

      <h3 style={{ margin: "0 0 12px", fontWeight: 800, fontSize: 16 }}>📥 ดาวน์โหลดข้อมูลย้อนหลัง</h3>
      <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 24, maxWidth: 480 }}>
        <label style={{ display: "block", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>เลือกวันที่</label>
        <input
          type="date"
          value={exportDate}
          onChange={e => setExportDate(e.target.value)}
          style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 0, padding: "10px 12px", fontSize: 14, boxSizing: "border-box", marginBottom: 12 }}
        />
        <button
          onClick={handleDownload}
          disabled={!exportDate || loading}
          style={{ width: "100%", background: exportDate ? "#111" : "#e5e7eb", color: exportDate ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "13px 0", fontSize: 15, fontWeight: 700, cursor: exportDate ? "pointer" : "default" }}
        >
          {loading ? "กำลังดาวน์โหลด..." : "⬇️ ดาวน์โหลด Excel"}
        </button>
        {archives.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 8 }}>ข้อมูลที่มีใน Archive</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {archives.map(d => (
                <button key={d} onClick={() => setExportDate(d)}
                  style={{ background: exportDate === d ? "#111" : "#f3f4f6", color: exportDate === d ? "#fff" : "#374151", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <h3 style={{ margin: "24px 0 12px", fontWeight: 800, fontSize: 16 }}>🗑️ ลบข้อมูลย้อนหลัง</h3>
      <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 24, maxWidth: 480 }}>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>เลือกวันที่แล้วลบข้อมูล Archive — การลบจะไม่สามารถกู้คืนได้</div>
        {archives.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 8 }}>เลือกจาก Archive ที่มี</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {archives.map(d => (
                <button key={d} onClick={() => setDeleteDate(d)}
                  style={{ background: deleteDate === d ? "#991b1b" : "#f3f4f6", color: deleteDate === d ? "#fff" : "#374151", border: "none", borderRadius: 0, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
        <input
          type="date"
          value={deleteDate}
          onChange={e => setDeleteDate(e.target.value)}
          style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 0, padding: "10px 12px", fontSize: 14, boxSizing: "border-box", marginBottom: 12 }}
        />
        <button
          onClick={handleDeleteArchive}
          disabled={!deleteDate || deleting}
          style={{ width: "100%", background: deleteDate ? "#fee2e2" : "#e5e7eb", color: deleteDate ? "#991b1b" : "#9ca3af", border: deleteDate ? "1.5px solid #fca5a5" : "none", borderRadius: 0, padding: "13px 0", fontSize: 15, fontWeight: 700, cursor: deleteDate ? "pointer" : "default" }}
        >
          {deleting ? "กำลังลบ..." : `🗑️ ลบ Archive${deleteDate ? ` วันที่ ${deleteDate}` : ""}`}
        </button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────────────────────
const Admin = ({ trucks, queue, onUpdate, onDeleteTruck }) => {
  const [selId,   setSelId]   = useState("");
  const [form,    setForm]    = useState(null);
  const [msg,     setMsg]     = useState("");
  const [mergeId, setMergeId] = useState("");

  const truck  = trucks.find(t => t.id === selId);

  // unique values from queue entries matching this truck's plate
  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const matchedQueue   = truck ? queue.filter(q => plateNum(q.plate) === plateNum(truck.plate)) : [];
  const duplicateTrucks = truck ? trucks.filter(t => t.id !== selId && plateNum(t.plate) === plateNum(truck.plate)) : [];
  const queueZones  = [...new Set(matchedQueue.map(q => q.zone).filter(Boolean))];
  const queueGroups = [...new Set(matchedQueue.map(q => q.customerGroup).filter(Boolean))];

  useEffect(() => {
    if (!truck) { setForm(null); setMsg(""); return; }
    setForm({
      queueId:       truck.queueId       || "",
      customerGroup: truck.customerGroup || "",
      zone:          truck.zone          || "",
      entryTime:     truck.entryTime     || "",
      exitTime:      truck.exitTime      || "",
      status:        truck.status        || "arrived",
      qcLanes:       JSON.parse(JSON.stringify(truck.qcLanes   || {})),
      loadLanes:     JSON.parse(JSON.stringify(truck.loadLanes || {})),
    });
    setMsg("");
  }, [selId]);

  const linkQueue = (qid) => {
    const q = matchedQueue.find(q => q.id === qid);
    if (!q) return;
    setForm(f => ({ ...f, queueId: q.id, zone: q.zone || "", customerGroup: q.customerGroup || "", entryTime: q.entryTime || "", exitTime: q.exitTime || "" }));
  };

  const save = async () => {
    await onUpdate(selId, form);
    setMsg("✅ บันทึกแล้ว");
    setTimeout(() => setMsg(""), 2500);
  };

  const handleMerge = async () => {
    const src = trucks.find(t => t.id === mergeId);
    if (!src || !truck) return;
    if (!window.confirm(`Merge ข้อมูลจาก ${src.plate} (zone: ${src.zone || "–"}) เข้า ${truck.plate} (zone: ${truck.zone || "–"}) แล้วลบรถต้นทางออก?`)) return;
    // merge lane-by-lane: T-1 (target) มีสิทธิ์ก่อน ถ้า T-1 ไม่มีค่อยเอาของ T-2
    const mergedQC   = { ...(src.qcLanes   || {}) };
    const mergedLoad = { ...(src.loadLanes  || {}) };
    for (const l of LOADING_LANES) {
      if (truck.qcLanes?.[l.id]?.done)   mergedQC[l.id]   = truck.qcLanes[l.id];
      if (truck.loadLanes?.[l.id]?.done)  mergedLoad[l.id] = truck.loadLanes[l.id];
    }
    await onUpdate(selId, { qcLanes: mergedQC, loadLanes: mergedLoad });
    await onDeleteTruck(mergeId);
    setMergeId("");
    setMsg("✅ Merge สำเร็จ — ลบรถซ้ำแล้ว");
    setTimeout(() => setMsg(""), 3000);
  };

  const setQC   = (lid, key, val) => setForm(f => ({ ...f, qcLanes:   { ...f.qcLanes,   [lid]: { ...(f.qcLanes[lid]   || {}), [key]: val } } }));
  const setLoad = (lid, key, val) => setForm(f => ({ ...f, loadLanes: { ...f.loadLanes, [lid]: { ...(f.loadLanes[lid] || {}), [key]: val } } }));
  const resetQC   = (lid) => setForm(f => ({ ...f, qcLanes:   { ...f.qcLanes,   [lid]: {} } }));
  const resetLoad = (lid) => setForm(f => ({ ...f, loadLanes: { ...f.loadLanes, [lid]: {} } }));

  const card  = { background: "#fff", borderRadius: 0, padding: "16px 20px", marginBottom: 14, boxShadow: "0 1px 6px rgba(0,0,0,0.07)" };
  const lbl   = { display: "block", fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 6 };
  const inp   = { width: "100%", border: "1.5px solid #d1d5db", borderRadius: 0, padding: "9px 12px", fontSize: 14, fontWeight: 600, boxSizing: "border-box", outline: "none" };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ fontWeight: 900, fontSize: 22, marginBottom: 16 }}>⚙️ Admin — แก้ไขข้อมูล</h2>

      {/* Truck selector */}
      <div style={card}>
        <label style={lbl}>เลือกทะเบียนรถ</label>
        <select value={selId} onChange={e => setSelId(e.target.value)} style={{ ...inp, fontSize: 15 }}>
          <option value="">— เลือกรถ —</option>
          {trucks.map(t => (
            <option key={t.id} value={t.id}>{t.plate}</option>
          ))}
        </select>
      </div>

      {/* Merge — แสดงเฉพาะเมื่อมีรถ plate เดียวกันในระบบ */}
      {truck && duplicateTrucks.length > 0 && (
        <div style={{ ...card, border: "1.5px solid #fde047", background: "#fefce8" }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>🔀 Merge รถซ้ำ</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
            พบทะเบียน <b>{truck.plate}</b> ในระบบ {duplicateTrucks.length + 1} คัน — เลือกรถที่จะดูดข้อมูล (source) เข้ามารวมกับตัวนี้ แล้วรถ source จะถูกลบ
          </div>
          <select value={mergeId} onChange={e => setMergeId(e.target.value)} style={{ ...inp, marginBottom: 10 }}>
            <option value="">— เลือกรถ source —</option>
            {duplicateTrucks.map(t => (
              <option key={t.id} value={t.id}>
                {t.plate} · zone: {t.zone || "–"} · {STATUS_META[t.status]?.label || t.status}
                {t.qcLanes ? ` · QC: ${LOADING_LANES.filter(l => t.qcLanes[l.id]?.done).map(l => l.tinyLabel).join(", ") || "ยังไม่มี"}` : ""}
              </option>
            ))}
          </select>
          <button onClick={handleMerge} disabled={!mergeId}
            style={{ width: "100%", background: mergeId ? "#854d0e" : "#e5e7eb", color: mergeId ? "#fff" : "#9ca3af", border: "none", borderRadius: 0, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: mergeId ? "pointer" : "default" }}>
            🔀 Merge และลบรถ source
          </button>
        </div>
      )}

      {truck && form && (
        <>
          {/* ผูก Queue Entry */}
          <div style={card}>
            <label style={lbl}>🔗 ผูก Queue Entry (เปลี่ยนข้อมูลจาก LG)</label>
            <select value={form.queueId} onChange={e => linkQueue(e.target.value)} style={{ ...inp, fontSize: 13 }}>
              <option value="">— เลือก Queue Entry —</option>
              {matchedQueue.map(q => (
                <option key={q.id} value={q.id}>
                  {q.zone || "–"} · {q.customerGroup || "–"} · เข้า {q.entryTime || "–"} · ออก {q.exitTime || "–"}
                </option>
              ))}
            </select>
            {form.queueId && (
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
                ผูกอยู่กับ: Zone <b>{form.zone || "–"}</b> · กลุ่ม <b>{form.customerGroup || "–"}</b> · ออก <b>{form.exitTime || "–"}</b>
              </div>
            )}
          </div>

          {/* กลุ่มลูกค้า + Zone */}
          <div style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={lbl}>👥 กลุ่มลูกค้า</label>
                <select value={form.customerGroup} onChange={e => setForm(f => ({ ...f, customerGroup: e.target.value }))} style={inp}>
                  <option value="">— ไม่ระบุ —</option>
                  {queueGroups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>📍 Zone</label>
                <select value={form.zone} onChange={e => setForm(f => ({ ...f, zone: e.target.value }))} style={inp}>
                  <option value="">— ไม่ระบุ —</option>
                  {queueZones.map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Status */}
          <div style={card}>
            <label style={lbl}>🚦 สถานะ</label>
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>
              {Object.entries(STATUS_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>

          {/* QC Lanes */}
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>🌡️ QC ลานโหลด</div>
            {LOADING_LANES.map(l => {
              const qc = form.qcLanes[l.id] || {};
              return (
                <div key={l.id} style={{ borderRadius: 0, border: `1.5px solid ${l.border}`, background: l.bg, padding: "12px 14px", marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: l.color }}>{l.tinyLabel}</div>
                    <button onClick={() => resetQC(l.id)}
                      style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 0, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      ↩ Reset QC
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: "0 0 auto" }}>
                      <label style={{ ...lbl, marginBottom: 4 }}>อุณหภูมิ (°C)</label>
                      <input value={qc.temp || ""} onChange={e => setQC(l.id, "temp", e.target.value)}
                        style={{ ...inp, width: 110 }} placeholder="เช่น -18" />
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, cursor: "pointer", marginTop: 18 }}>
                      <input type="checkbox" checked={!!qc.done} onChange={e => setQC(l.id, "done", e.target.checked)} style={{ width: 16, height: 16 }} />
                      QC แล้ว
                    </label>
                  </div>
                  {qc.doneAt && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>บันทึกเมื่อ: {qc.doneAt}</div>}
                </div>
              );
            })}
          </div>

          {/* Load Lanes */}
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>🏗️ สถานะลานโหลด</div>
            {LOADING_LANES.map(l => {
              const ld = form.loadLanes[l.id] || {};
              return (
                <div key={l.id} style={{ borderRadius: 0, border: `1.5px solid ${l.border}`, background: l.bg, padding: "12px 14px", marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: l.color }}>{l.tinyLabel}</div>
                    <button onClick={() => resetLoad(l.id)}
                      style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 0, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      ↩ Reset
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 20 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                      <input type="checkbox" checked={!!ld.waiting} onChange={e => setLoad(l.id, "waiting", e.target.checked)} style={{ width: 16, height: 16 }} />
                      รอสินค้า
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                      <input type="checkbox" checked={!!ld.done} onChange={e => setLoad(l.id, "done", e.target.checked)} style={{ width: 16, height: 16 }} />
                      โหลดเสร็จ
                    </label>
                  </div>
                  {(ld.waitingAt || ld.doneAt) && (
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
                      {ld.waitingAt && <span>รอ: {ld.waitingAt} </span>}
                      {ld.doneAt   && <span>เสร็จ: {ld.doneAt}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {msg && <div style={{ textAlign: "center", color: "#10b981", fontWeight: 700, marginBottom: 12, fontSize: 15 }}>{msg}</div>}
          <button onClick={save}
            style={{ width: "100%", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
            💾 บันทึกการแก้ไข
          </button>
          <button onClick={() => { if (window.confirm(`ลบรถ ${truck.plate} ออกจากระบบ?`)) onDeleteTruck(truck.id); }}
            style={{ width: "100%", background: "#fee2e2", color: "#991b1b", border: "1.5px solid #fca5a5", borderRadius: 0, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
            🗑️ ลบรถออกจากระบบ (กรณีสแกนทะเบียนผิด)
          </button>
        </>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL LOADING
// ─────────────────────────────────────────────────────────────────────────────
const DETAIL_SOURCES = [
  { id: "wet_market",    label: "ตลาดสด",       emoji: "🛒", color: "#10b981", bg: "#d1fae5" },
  { id: "modern_trade", label: "Makro",  emoji: "🏪", color: "#3b82f6", bg: "#dbeafe" },
  { id: "others",       label: "LOTUS",          emoji: "📦", color: "#f97316", bg: "#fff7ed" },
];

// Map Thai lane names from Master file → lane IDs used in system
const LANE_NAME_MAP = {
  "ชิ้นส่วน":         "lane_parts",
  "หัว/เครื่องใน":   "lane_head",
  "หัวเครื่องใน":   "lane_head",
  "หัว/เครื่องใน":  "lane_head",
  "หมูซีก":          "lane_pork",
  // fallback: if value already is a lane ID, pass through
  "lane_parts":       "lane_parts",
  "lane_head":        "lane_head",
  "lane_pork":        "lane_pork",
};
const normalizeLaneKey = (raw) => {
  const t = String(raw || "").trim();
  if (!t) return null;
  if (LANE_NAME_MAP[t]) return LANE_NAME_MAP[t];
  // partial match fallback
  if (t.includes("ชิ้นส่วน")) return "lane_parts";
  if (t.includes("หัว") || t.includes("เครื่องใน")) return "lane_head";
  if (t.includes("หมูซีก") || t.includes("ซีก") || t.includes("หมู")) return "lane_pork";
  return null;
};
const normalizeProductCode = (val) => String(val || "").replace(/\.0+$/, "").trim().replace(/^0+(\d)/, "$1");

const DETAIL_LS_VER = "v2"; // bump when encoding/format changes — forces re-upload

const DetailLoading = ({ masterLane, onMasterChange, onDetailChange }) => {
  const initSrc = () => {
    try {
      if (localStorage.getItem("wh_detail_ver") !== DETAIL_LS_VER) {
        ["wh_detail_src", "wh_detail_names"].forEach(k => localStorage.removeItem(k));
        localStorage.setItem("wh_detail_ver", DETAIL_LS_VER);
        return {};
      }
      return JSON.parse(localStorage.getItem("wh_detail_src") || "{}");
    } catch { return {}; }
  };
  const initNames = () => {
    try { return JSON.parse(localStorage.getItem("wh_detail_names") || "{}"); } catch { return {}; }
  };

  const [srcData,     setSrcData]     = useState(() => ({ wet_market: [], modern_trade: [], others: [], ...initSrc() }));
  const [fileNames,   setFileNames]   = useState(initNames);
  const [showDebug,   setShowDebug]   = useState(false);
  const [masterDebug, setMasterDebug] = useState(null); // { total, parsed, sampleCol3 }

  // On mount: fetch from Supabase (shared), fallback to localStorage
  useEffect(() => {
    fetchDetailSrc().then(remote => {
      if (remote) {
        const merged = {};
        const names = { ...initNames() };
        for (const [srcId, { rows, fileName }] of Object.entries(remote)) {
          merged[srcId] = rows;
          if (fileName) names[srcId] = fileName;
        }
        setSrcData(prev => {
          const next = { ...prev, ...merged };
          localStorage.setItem("wh_detail_src", JSON.stringify(next));
          return next;
        });
        setFileNames(prev => {
          const next = { ...prev, ...names };
          localStorage.setItem("wh_detail_names", JSON.stringify(next));
          return next;
        });
        Object.entries(merged).forEach(([srcId, rows]) => {
          if (rows?.length) onDetailChange(srcId, rows);
        });
      } else {
        const stored = initSrc();
        Object.entries(stored).forEach(([srcId, rows]) => {
          if (rows?.length) onDetailChange(srcId, rows);
        });
      }
    });

    const channel = supabase.channel("detail-src-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "wh_master" }, async (payload) => {
        const row = payload.new;
        if (!row?.id?.startsWith("detail_")) return;
        const srcId = row.id.replace(/^detail_/, "");
        // Re-fetch แทนการอ่านจาก payload เพราะ JSONB ขนาดใหญ่อาจถูกตัดใน realtime
        const { data: fresh } = await supabase.from("wh_master").select("data").eq("id", row.id).single();
        const payload2 = fresh?.data || row.data || {};
        const rows = Array.isArray(payload2) ? payload2 : (payload2.rows || []);
        const fileName = payload2.file_name || "";
        setSrcData(prev => {
          const next = { ...prev, [srcId]: rows };
          localStorage.setItem("wh_detail_src", JSON.stringify(next));
          return next;
        });
        if (fileName) {
          setFileNames(prev => {
            const next = { ...prev, [srcId]: fileName };
            localStorage.setItem("wh_detail_names", JSON.stringify(next));
            return next;
          });
        }
        onDetailChange(srcId, rows);
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse source file (col U=index20=productCode, col BN=index65=plate)
  const parseSourceFile = (file, srcId) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      let parsed;
      try {
        let wb;
        if (/\.csv$/i.test(file.name)) {
          // CSV with Thai Windows-874 encoding: decode bytes manually
          const text = new TextDecoder("windows-874").decode(new Uint8Array(ev.target.result));
          wb = XLSX.read(text, { type: "string" });
        } else {
          wb = XLSX.read(ev.target.result, { type: "array", raw: true, codepage: 874 });
        }
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
        const dataRows = rows.slice(1).filter(r => r[65] && String(r[65]).trim() !== "");
        parsed = dataRows.map(r => ({
          plate:        String(r[65] || "").trim(),
          productCode:  normalizeProductCode(r[20]),
          groupFlag:    String(r[11] || "").trim(),
        })).filter(r => r.plate && r.productCode);

        setSrcData(prev => {
          const next = { ...prev, [srcId]: parsed };
          localStorage.setItem("wh_detail_src", JSON.stringify(next));
          return next;
        });
        setFileNames(prev => {
          const next = { ...prev, [srcId]: file.name };
          localStorage.setItem("wh_detail_names", JSON.stringify(next));
          return next;
        });
        onDetailChange(srcId, parsed);
      } catch(e) {
        alert("อ่านไฟล์ไม่สำเร็จ: " + e.message);
        return;
      }

      try {
        const { error } = await supabase.from("wh_master").upsert({ id: `detail_${srcId}`, data: { rows: parsed, file_name: file.name } });
        if (error) throw error;
      } catch (e) {
        alert("บันทึกขึ้นเซิร์ฟเวอร์ไม่สำเร็จ — เครื่องอื่นจะไม่เห็นข้อมูลนี้: " + e.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Parse master file (col A=index0=productCode, col D=index3=laneId)
  const parseMasterFile = (file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: "array", raw: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
        const dataRows = rows.slice(1).filter(r => r[0] && String(r[0]).trim() !== "" && String(r[0]).trim() !== "SAP");
        const mapped = dataRows.map(r => ({
          productCode: normalizeProductCode(r[0]),
          laneKey:     normalizeLaneKey(r[3]),
          rawCol3:     String(r[3] || "").trim(),
        }));
        const parsed = mapped.filter(r => r.productCode && r.laneKey);
        setMasterDebug({
          total:    dataRows.length,
          matched:  parsed.length,
          sampleCol3: [...new Set(mapped.map(r => r.rawCol3))].slice(0, 6),
        });
        setFileNames(prev => {
          const next = { ...prev, master: file.name };
          localStorage.setItem("wh_detail_names", JSON.stringify(next));
          return next;
        });
        onMasterChange(parsed);
      } catch(e) {
        alert("อ่านไฟล์ Master ไม่สำเร็จ: " + e.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Compute plate → lanes mapping from all sources + master
  const plateLaneMap = {};
  const allDetail = [...(srcData.wet_market || []), ...(srcData.modern_trade || []), ...(srcData.others || [])];
  for (const row of allDetail) {
    const rowCode = normalizeProductCode(row.productCode);
    const match = (masterLane || []).find(m => normalizeProductCode(m.productCode) === rowCode);
    if (!match) continue;
    const plateKey = String(row.plate).replace(/\s/g, "").toUpperCase();
    if (!plateLaneMap[plateKey]) plateLaneMap[plateKey] = new Set();
    plateLaneMap[plateKey].add(match.laneKey);
  }

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 900 }}>📋 Detail Loading</h2>

      {/* Source upload buttons (1-3) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 24 }}>
        {DETAIL_SOURCES.map(src => (
          <div key={src.id} style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 28 }}>{src.emoji}</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{src.label}</div>
                {fileNames[src.id] && (
                  <div style={{ fontSize: 11, color: src.color, fontWeight: 700, marginTop: 2 }}>
                    ✅ {fileNames[src.id]}
                  </div>
                )}
              </div>
            </div>
            <label style={{ display: "block", background: src.bg, color: src.color, border: `1.5px dashed ${src.color}`, borderRadius: 0, padding: "12px 0", textAlign: "center", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "opacity 0.2s" }}
              onMouseOver={e => e.currentTarget.style.opacity = "0.8"}
              onMouseOut={e => e.currentTarget.style.opacity = "1"}>
              {fileNames[src.id] ? "🔄 เปลี่ยนไฟล์" : "⬆️ อัปโหลดไฟล์"} {src.label}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
                onChange={e => { if (e.target.files[0]) parseSourceFile(e.target.files[0], src.id); e.target.value = ""; }} />
            </label>
          </div>
        ))}

        {/* Master button (4) - persistent */}
        <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 20, border: "2px solid #111" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 28 }}>🗂️</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Master ลานโหลด</div>
              {fileNames.master && (
                <div style={{ fontSize: 11, color: "#111", fontWeight: 700, marginTop: 2 }}>
                  ✅ {fileNames.master}
                </div>
              )}
            </div>
          </div>
          <label style={{ display: "block", background: "#111", color: "#fff", border: "none", borderRadius: 0, padding: "12px 0", textAlign: "center", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "opacity 0.2s" }}
            onMouseOver={e => e.currentTarget.style.opacity = "0.8"}
            onMouseOut={e => e.currentTarget.style.opacity = "1"}>
            {fileNames.master ? "🔄 เปลี่ยน Master" : "⬆️ อัปโหลด Master"}
            <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
              onChange={e => { if (e.target.files[0]) parseMasterFile(e.target.files[0]); e.target.value = ""; }} />
          </label>
          {masterDebug && (
            <div style={{ marginTop: 10, fontSize: 11, padding: "8px 10px", borderRadius: 0, background: masterDebug.matched === 0 ? "#fee2e2" : "#d1fae5", color: masterDebug.matched === 0 ? "#991b1b" : "#065f46" }}>
              {masterDebug.matched === 0
                ? <>❌ Match 0/{masterDebug.total} — ค่าใน col D: {masterDebug.sampleCol3.map(v => `"${v}"`).join(", ")}</>
                : <>✅ Match {masterDebug.matched}/{masterDebug.total} รหัส</>}
            </div>
          )}
        </div>
      </div>

      {/* Result table: plate → lanes */}
      {Object.keys(plateLaneMap).length > 0 && (
        <div style={{ background: "#fff", borderRadius: 0, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", fontWeight: 700, fontSize: 14 }}>
            📊 สรุป ทะเบียนรถ → ลานโหลด
            <span style={{ background: "#111", color: "#fff", borderRadius: 0, padding: "2px 8px", fontSize: 11, marginLeft: 8 }}>{Object.keys(plateLaneMap).length} คัน</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  {["ทะเบียนรถ", ...LOADING_LANES.map(l => l.tinyLabel)].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontWeight: 700, color: "#374151", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(plateLaneMap).map(([plate, lanes]) => (
                  <tr key={plate} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "8px 16px", fontWeight: 800, fontFamily: "monospace" }}>{plate}</td>
                    {LOADING_LANES.map(l => (
                      <td key={l.id} style={{ padding: "8px 16px", textAlign: "center" }}>
                        {lanes.has(l.id)
                          ? <span style={{ color: l.color, fontWeight: 800, fontSize: 16 }}>✓</span>
                          : <span style={{ color: "#e5e7eb", fontSize: 14 }}>—</span>
                        }
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {Object.keys(plateLaneMap).length === 0 && (masterLane || []).length > 0 && allDetail.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 0, padding: 20, color: "#92400e", fontWeight: 600, fontSize: 14 }}>
          ⚠️ ไม่พบรหัสสินค้าที่ Match กับ Master — ตรวจสอบว่า Product Code ในไฟล์ตรงกับ Master หรือไม่
          <button onClick={() => setShowDebug(v => !v)} style={{ marginLeft: 12, background: "#92400e", color: "#fff", border: "none", borderRadius: 0, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>
            {showDebug ? "ซ่อน" : "🔍 ดู Debug"}
          </button>
        </div>
      )}

      {showDebug && (masterLane || []).length > 0 && allDetail.length > 0 && (
        <div style={{ background: "#1e1e2e", borderRadius: 0, padding: 16, marginTop: 12, fontFamily: "monospace", fontSize: 12 }}>
          <div style={{ color: "#cba6f7", fontWeight: 700, marginBottom: 8 }}>🔍 Debug: เปรียบเทียบรหัสสินค้า</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div style={{ color: "#a6e3a1", fontWeight: 700, marginBottom: 4 }}>Master (5 แรก)</div>
              {(masterLane || []).slice(0, 5).map((m, i) => (
                <div key={i} style={{ color: "#cdd6f4", padding: "2px 0" }}>
                  <span style={{ color: "#f9e2af" }}>[{typeof m.productCode}]</span> "{m.productCode}" → {m.laneKey || <span style={{ color: "#f38ba8" }}>null (lane ไม่ match)</span>}
                </div>
              ))}
            </div>
            <div>
              <div style={{ color: "#89b4fa", fontWeight: 700, marginBottom: 4 }}>Source (5 แรก)</div>
              {allDetail.slice(0, 5).map((r, i) => (
                <div key={i} style={{ color: "#cdd6f4", padding: "2px 0" }}>
                  <span style={{ color: "#f9e2af" }}>[{typeof r.productCode}]</span> "{r.productCode}" → plate: {r.plate}
                </div>
              ))}
            </div>
          </div>
          <div style={{ color: "#6c7086", marginTop: 8, fontSize: 11 }}>
            ถ้า type ต่างกัน (number vs string) หรือ leading zeros หาย → นั่นคือสาเหตุ
          </div>
        </div>
      )}

      {(masterLane || []).length === 0 && (
        <div style={{ background: "#f9fafb", border: "1.5px dashed #d1d5db", borderRadius: 0, padding: 20, color: "#9ca3af", fontWeight: 600, fontSize: 14, textAlign: "center" }}>
          🗂️ กรุณาอัปโหลดไฟล์ Master ลานโหลดก่อน
        </div>
      )}
    </div>
  );
};

// ─── WORK TRACKING (Power BI–style matrix table) ─────────────────────────────
const WT_GROUPS = [
  { id: "info",  label: "",                       span: 2, dark: "#0f172a", mid: "#1e293b" },
  { id: "entry", label: "เข้าโรงงาน / เบิกสินค้า", span: 3, dark: "#1d4ed8", mid: "#2563eb" },
  { id: "parts", label: "🥩 ลานชิ้นส่วน",         span: 2, dark: "#c2410c", mid: "#ea580c" },
  { id: "head",  label: "🐷 ลานหัว/เครื่องใน",     span: 2, dark: "#6d28d9", mid: "#7c3aed" },
  { id: "pork",  label: "🐖 ลานหมูซีก",            span: 2, dark: "#9f1239", mid: "#be123c" },
  { id: "docs",  label: "เอกสาร",                 span: 2, dark: "#0d9488", mid: "#0f766e" },
];
const WT_GROUP_MAP = Object.fromEntries(WT_GROUPS.map(g => [g.id, g]));
const WT_CELL_BG  = { info: "#f8fafc", entry: "#eff6ff", parts: "#fff7ed", head: "#f5f3ff", pork: "#fff1f2", docs: "#f0fdfa" };

const WorkTracking = ({ trucks, queue }) => {
  const today = cycleDateStr();
  const [date, setDate]       = useState(today);
  const [archiveData, setArchiveData] = useState(null);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const [sortCol, setSortCol] = useState("arrivedAt");
  const [sortDir, setSortDir] = useState(1);

  useEffect(() => {
    setArchiveData(null);
    setLoadingArchive(date !== today);
    supabase.from("wh_archive").select("trucks, queue").eq("archive_date", date).single()
      .then(({ data }) => setArchiveData(data ?? null))
      .finally(() => setLoadingArchive(false));
  }, [date, today]);

  const activeTrucks = archiveData?.trucks ?? (date === today ? trucks : []);
  const activeQueue  = archiveData?.queue  ?? (date === today ? queue  : []);
  const pNum = s => (String(s).match(/\d+/g) || []).pop() || "";
  const getQ = t => activeQueue.find(q => q.id === t.queueId) || activeQueue.find(q => pNum(q.plate) === pNum(t.plate) && pNum(q.plate) !== "");

  const COLS = [
    { id: "plate",            grp: "info",   label: "ทะเบียน",    align: "left",   get: t => t.plate },
    { id: "customerGroup",    grp: "info",   label: "กลุ่มลูกค้า", align: "left",   get: t => t.customerGroup || "—" },
    { id: "entrySTD",         grp: "entry",  label: "STD เข้า",   align: "center", get: t => getQ(t)?.entryTime },
    { id: "arrivedAt",        grp: "entry",  label: "ACT เข้า",   align: "center", get: t => t.arrivedAt },
    { id: "pickingAt",        grp: "entry",  label: "พิมพ์ใบเบิก", align: "center", get: t => t.pickingAt },
    { id: "qc_parts",         grp: "parts",  label: "QC",           align: "center", get: t => t.qcLanes?.lane_parts?.doneAt },
    { id: "load_parts",       grp: "parts",  label: "โหลดเสร็จ",   align: "center", get: t => t.loadLanes?.lane_parts?.doneAt },
    { id: "qc_head",          grp: "head",   label: "QC",           align: "center", get: t => t.qcLanes?.lane_head?.doneAt },
    { id: "load_head",        grp: "head",   label: "โหลดเสร็จ",   align: "center", get: t => t.loadLanes?.lane_head?.doneAt },
    { id: "qc_pork",          grp: "pork",   label: "QC",           align: "center", get: t => t.qcLanes?.lane_pork?.doneAt },
    { id: "load_pork",        grp: "pork",   label: "โหลดเสร็จ",   align: "center", get: t => t.loadLanes?.lane_pork?.doneAt },
    { id: "summaryPrintedAt", grp: "docs",   label: "ใบสรุป",      align: "center", get: t => t.summaryPrintedAt },
    { id: "invoicedAt",       grp: "docs",   label: "Invoice",      align: "center", get: t => t.invoicedAt },
  ];

  const isTimeCol = id => !["plate","customerGroup"].includes(id);

  const handleSort = (id) => {
    if (!isTimeCol(id) && id !== "plate" && id !== "customerGroup") return;
    setSortCol(c => { if (c === id) { setSortDir(d => d === 1 ? -1 : 1); return c; } setSortDir(1); return id; });
  };

  const sortVal = (t, colId) => {
    const col = COLS.find(c => c.id === colId);
    const v = col?.get(t);
    if (!v) return sortDir === 1 ? "zz" : "";
    if (isTimeCol(colId) && colId !== "customerGroup") {
      const n = workTimeValue(v);
      return String(n).padStart(5, "0");
    }
    return v;
  };

  const sorted = [...activeTrucks].sort((a, b) => {
    const va = sortVal(a, sortCol), vb = sortVal(b, sortCol);
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });

  const thBase = { padding: "7px 10px", fontWeight: 700, whiteSpace: "nowrap", userSelect: "none", borderRight: "1px solid rgba(255,255,255,0.18)" };

  const exportExcel = () => {
    const rows = sorted.map(t => {
      const q = getQ(t);
      const stdDiff = q?.entryTime && t.arrivedAt ? workTimeValue(t.arrivedAt) - workTimeValue(q.entryTime) : null;
      return {
        "ทะเบียน":               t.plate || "",
        "กลุ่มลูกค้า":           t.customerGroup || "",
        "STD เข้า":              q?.entryTime || "",
        "ACT เข้า":              t.arrivedAt || "",
        "ต่าง STD (นาที)":       stdDiff ?? "",
        "พิมพ์ใบเบิก":           t.pickingAt || "",
        "QC ชิ้นส่วน":           t.qcLanes?.lane_parts?.doneAt || "",
        "โหลด ชิ้นส่วน":         t.loadLanes?.lane_parts?.doneAt || "",
        "QC หัว/เครื่องใน":      t.qcLanes?.lane_head?.doneAt || "",
        "โหลด หัว/เครื่องใน":    t.loadLanes?.lane_head?.doneAt || "",
        "QC หมูซีก":             t.qcLanes?.lane_pork?.doneAt || "",
        "โหลด หมูซีก":           t.loadLanes?.lane_pork?.doneAt || "",
        "ใบสรุป":                t.summaryPrintedAt || "",
        "Invoice":               t.invoicedAt || "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, date);
    XLSX.writeFile(wb, `Tracking_${date}.xlsx`);
  };

  return (
    <div>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontWeight: 900, fontSize: 20 }}>📊 Tracking การทำงาน</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ border: "1.5px solid #d1d5db", borderRadius: 0, padding: "7px 11px", fontSize: 13, fontWeight: 600, outline: "none" }} />
          <button onClick={exportExcel}
            style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 0, padding: "7px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            ⬇️ Export Excel
          </button>
        </div>
      </div>

      {loadingArchive && <div style={{ textAlign: "center", color: "#9ca3af", padding: 40 }}>กำลังโหลด...</div>}

      {!loadingArchive && (
        <div style={{ overflowX: "auto", boxShadow: "0 4px 16px rgba(0,0,0,0.12)", borderRadius: 0 }}>
          <table style={{ borderCollapse: "collapse", minWidth: 980, width: "100%", fontSize: 12 }}>
            <thead>
              {/* Group header row */}
              <tr>
                {WT_GROUPS.map(g => (
                  <th key={g.id} colSpan={g.span}
                    style={{ ...thBase, background: g.dark, color: "#fff", fontSize: 11, textAlign: "center", padding: "9px 10px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                    {g.label}
                  </th>
                ))}
              </tr>
              {/* Column header row */}
              <tr>
                {COLS.map(col => {
                  const g = WT_GROUP_MAP[col.grp];
                  const sorted_ = sortCol === col.id;
                  return (
                    <th key={col.id} onClick={() => handleSort(col.id)}
                      style={{ ...thBase, background: g.mid, color: "#fff", fontSize: 11, textAlign: col.align, cursor: "pointer", padding: "7px 10px" }}>
                      {col.label}{sorted_ ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr><td colSpan={COLS.length} style={{ textAlign: "center", color: "#9ca3af", padding: 40, background: "#fff" }}>ยังไม่มีข้อมูลในวันนี้</td></tr>
              )}
              {sorted.map((t, i) => {
                const q = getQ(t);
                const stdDiff = q?.entryTime && t.arrivedAt ? workTimeValue(t.arrivedAt) - workTimeValue(q.entryTime) : null;
                return (
                  <tr key={t.id} style={{ borderBottom: "1px solid #e5e7eb" }}
                    onMouseEnter={e => e.currentTarget.style.filter = "brightness(0.96)"}
                    onMouseLeave={e => e.currentTarget.style.filter = ""}>
                    {COLS.map(col => {
                      const cellBg = i % 2 === 0 ? WT_CELL_BG[col.grp] : "#fff";
                      const val = col.get(t);

                      if (col.id === "plate") return (
                        <td key={col.id} style={{ padding: "9px 12px", background: cellBg, borderRight: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                          <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: 0.5 }}>{val}</span>
                        </td>
                      );

                      if (col.id === "customerGroup") return (
                        <td key={col.id} style={{ padding: "9px 10px", background: cellBg, borderRight: "1px solid #e5e7eb", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ fontSize: 12, color: "#374151" }}>{val || "—"}</span>
                        </td>
                      );

                      if (col.id === "arrivedAt") {
                        const late = stdDiff != null && stdDiff > 0;
                        const early = stdDiff != null && stdDiff < 0;
                        return (
                          <td key={col.id} style={{ padding: "7px 10px", background: cellBg, borderRight: "1px solid #e5e7eb", textAlign: "center", whiteSpace: "nowrap" }}>
                            {val
                              ? <span>
                                  <span style={{ fontWeight: 700, color: late ? "#dc2626" : early ? "#16a34a" : "#1d4ed8", fontSize: 13 }}>{val}</span>
                                  {stdDiff != null && <span style={{ fontSize: 10, color: late ? "#dc2626" : "#16a34a", marginLeft: 3 }}>
                                    {late ? `+${stdDiff}′` : stdDiff < 0 ? `${stdDiff}′` : ""}
                                  </span>}
                                </span>
                              : <span style={{ color: "#d1d5db" }}>—</span>}
                          </td>
                        );
                      }

                      // Generic time cell
                      const g = WT_GROUP_MAP[col.grp];
                      return (
                        <td key={col.id} style={{ padding: "7px 10px", background: cellBg, borderRight: "1px solid #e5e7eb", textAlign: "center", whiteSpace: "nowrap" }}>
                          {val
                            ? <span style={{ fontWeight: 700, color: g.mid, fontSize: 13 }}>{val}</span>
                            : <span style={{ color: "#e5e7eb" }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ─── ROLE SELECT (landing page: เลือกตำแหน่งงานก่อนเข้าระบบ) ──────────────────
const ROLE_OPTIONS = [
  { id: "qc",          label: "ลานโหลด",        emoji: "🌡️" },
  { id: "checker",     label: "QC",            emoji: "🥩" },
  { id: "loading",     label: "Checker",       img: "/basket.png" },
  { id: "office_wh",   label: "Office คลัง",    emoji: "🖨️" },
  { id: "office_plan", label: "Office วางแผน",  emoji: "🧾" },
  { id: "lg",          label: "LG",            emoji: "⬆️" },
  { id: "dashboard_only", label: "Dashboard" },
  { id: "loading_data", label: "ข้อมูลการโหลดสินค้า" },
  { id: "tracking",    label: "Tracking การทำงาน",  emoji: "📊" },
  { id: "all",         label: "ทั้งหมด" },
];

const LOADING_TABS = ["loading_parts", "loading_head", "loading_pork"];

// roles that land on a lane-picker card screen instead of auto-opening a tab
const LANE_SELECT_ROLES = ["qc", "loading", "checker", "office_wh", "office_plan", "lg"];

const ROLE_TABS = {
  qc:           ["qc_parts", "qc_head", "qc_pork"],
  loading:      LOADING_TABS,
  checker:      ["sample_parts", "sample_head", "sample_pork"],
  office_wh:    ["picking"],
  office_plan:  ["planning", "detail_loading"],
  lg:           ["lg"],
  dashboard_only: ["dashboard"],
  loading_data: ["overview_log"],
  tracking:     ["work_tracking"],
  all:          null,
};

const RoleSelect = ({ onSelect }) => {
  const squareOptions = ROLE_OPTIONS.slice(0, 6);
  const wideOptions   = ROLE_OPTIONS.slice(6);
  return (
    <div style={{ height: "100dvh", overflow: "hidden", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 20px", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
      <div style={{ maxWidth: 420, width: "100%" }}>
        <h2 style={{ textAlign: "center", fontWeight: 900, fontSize: 20, margin: "0 0 4px" }}>เลือกตำแหน่งงาน</h2>
        <p style={{ textAlign: "center", color: "#6b7280", fontSize: 12, margin: "0 0 28px" }}>ระบบจะแสดงเฉพาะเมนูที่เกี่ยวข้องกับตำแหน่งงานของคุณ</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {squareOptions.map(r => (
            <button key={r.id} onClick={() => onSelect(r.id)}
              style={{ background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 0, aspectRatio: "1 / 1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: 8, fontSize: 15, fontWeight: 700, cursor: "pointer", textAlign: "center" }}>
              {r.img ? <img src={r.img} alt="" style={{ width: 36, height: "auto" }} /> : r.icon ? <Icon name={r.icon} size={26} /> : <span style={{ fontSize: 26 }}>{r.emoji}</span>}
              {r.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}>
          {wideOptions.map(r => (
            <button key={r.id} onClick={() => onSelect(r.id)}
              style={{ background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 0, padding: "14px 8px", fontSize: 15, fontWeight: 700, cursor: "pointer", textAlign: "center" }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── LANE SELECT (เลือกเมนูย่อยหลังเลือกตำแหน่งงาน) ───────────────────────────
const LaneSelect = ({ tabs, roleLabel, onSelect, onBack }) => (
  <div style={{ height: "100dvh", overflow: "hidden", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 20px", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
    <div style={{ maxWidth: 420, width: "100%" }}>
      <h2 style={{ textAlign: "center", fontWeight: 900, fontSize: 20, margin: "0 0 4px" }}>{roleLabel}</h2>
      <p style={{ textAlign: "center", color: "#6b7280", fontSize: 12, margin: "0 0 28px" }}>เลือกเมนูที่ต้องการเข้าใช้งาน</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => onSelect(t.id)}
            style={{ background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 0, padding: "16px 14px", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
            <Icon name={t.icon} size={22} />
            {t.label}
          </button>
        ))}
      </div>
      <button onClick={onBack} style={{ marginTop: 24, width: "100%", background: "transparent", border: "none", color: "#6b7280", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "center" }}>
        ← กลับหน้าเลือกตำแหน่งงาน
      </button>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
const fetchQueue  = async () => { const { data } = await supabase.from("wh_queue").select("*");  return (data || []).map(r => r.data).sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity)); };
const fetchTrucks = async () => { const { data } = await supabase.from("wh_trucks").select("*"); return (data || []).map(r => r.data); };
const fetchMaster = async () => { const { data } = await supabase.from("wh_master").select("*").eq("id", "master"); return data && data[0] ? (data[0].data || []) : []; };
const fetchDetailSrc = async () => {
  const ids = DETAIL_SOURCES.map(s => `detail_${s.id}`);
  const { data } = await supabase.from("wh_master").select("*").in("id", ids);
  if (!data || data.length === 0) return null;
  const result = {};
  for (const row of data) {
    const srcId = row.id.replace(/^detail_/, "");
    const payload = row.data || {};
    result[srcId] = {
      rows:     Array.isArray(payload) ? payload : (payload.rows || []),
      fileName: payload.file_name || "",
    };
  }
  return result;
};

export default function App() {
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();
  const defaultTabForRole = (r) => {
    if (LANE_SELECT_ROLES.includes(r)) {
      const allowed = ROLE_TABS[r];
      return allowed?.length === 1 ? allowed[0] : "";
    }
    const allowed = ROLE_TABS[r];
    return (allowed && !allowed.includes("dashboard")) ? allowed[0] : "dashboard";
  };
  const [role,       setRole]       = useState("");
  const handleSelectRole = (r) => { setRole(r); setTab(defaultTabForRole(r)); };
  const handleChangeRole = () => { setRole(""); setTab("dashboard"); };
  const [queue,      setQueue]      = useState([]);
  const [trucks,     setTrucks]     = useState([]);
  const [masterLane, setMasterLane] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wh_master_cache") || "[]"); } catch { return []; }
  });
  const [detailMap,  setDetailMap]  = useState({}); // plate→Set(lanes) computed
  const [srcVersion, setSrcVersion] = useState(0);  // bumped when source files change
  const [tab,        setTab]        = useState("dashboard");
  const [dashLane,   setDashLane]   = useState("main");
  const [time,       setTime]       = useState(TIME_NOW());
  const [loading,    setLoading]    = useState(true);
  const [headerClock, setHeaderClock] = useState(() => new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));

  // Kiosk modes via URL parameter ?mode=<role>
  const _urlMode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("mode") : null;
  const isDriverMode      = _urlMode === "driver";
  const isQcPartsMode      = _urlMode === "qc_parts";
  const isQcHeadMode       = _urlMode === "qc_head";
  const isQcPorkMode       = _urlMode === "qc_pork";
  const isLoadingPartsMode = _urlMode === "loading_parts";
  const isLoadingHeadMode  = _urlMode === "loading_head";
  const isLoadingPorkMode  = _urlMode === "loading_pork";
  const isSamplePartsMode  = _urlMode === "sample_parts";
  const isSampleHeadMode   = _urlMode === "sample_head";
  const isSamplePorkMode   = _urlMode === "sample_pork";

  useEffect(() => { const id = setInterval(() => setTime(TIME_NOW()), 15000); return () => clearInterval(id); }, []);
  useEffect(() => { const id = setInterval(() => setHeaderClock(new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    fetchQueue().then(setQueue);
    fetchTrucks().then(setTrucks);
    fetchMaster().then(rows => {
      if (rows.length > 0) {
        setMasterLane(rows);
        localStorage.setItem("wh_master_cache", JSON.stringify(rows));
      }
    });

    const channel = supabase.channel("app-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "wh_queue" },  () => fetchQueue().then(setQueue))
      .on("postgres_changes", { event: "*", schema: "public", table: "wh_trucks" }, () => fetchTrucks().then(setTrucks))
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  // Recompute detailMap whenever masterLane or source files change
  useEffect(() => {
    if (!masterLane.length) return;
    try {
      const stored = JSON.parse(localStorage.getItem("wh_detail_src") || "{}");
      const allDetail = Object.values(stored).flat();
      const map = {};
      for (const row of allDetail) {
        const rowCode = normalizeProductCode(row.productCode);
        const match = masterLane.find(m => normalizeProductCode(m.productCode) === rowCode);
        if (!match) continue;
        const k = String(row.plate).replace(/\s/g, "").toUpperCase();
        if (!map[k]) map[k] = new Set();
        map[k].add(match.laneKey);
      }
      setDetailMap(map);
    } catch {}
  }, [masterLane, srcVersion]);

  const handleMasterChange = async (rows) => {
    setMasterLane(rows);
    localStorage.setItem("wh_master_cache", JSON.stringify(rows));
    await supabase.from("wh_master").upsert({ id: "master", data: rows });
  };

  const handleDetailChange = () => {
    setSrcVersion(v => v + 1);
  };

  const plateNum = s => (String(s).match(/\d+/g) || []).pop() || "";

  const calcTimeDiffStr = (std, actual) => {
    if (!std || !actual) return "";
    const [h1, m1] = std.split(":").map(Number);
    const [h2, m2] = actual.split(":").map(Number);
    if (isNaN(h1) || isNaN(h2)) return "";
    const diffMin = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (diffMin === 0) return "(ตรงเวลา)";
    const absDiff = Math.abs(diffMin);
    const hrs = Math.floor(absDiff / 60);
    const mins = absDiff % 60;
    const str = `${hrs}:${mins.toString().padStart(2, '0')} ชม.`;
    return diffMin < 0 ? `(ก่อน ${str})` : `(สาย ${str})`;
  };

  const handleScan = async (t) => {
    if (t.id.startsWith("WALK-")) {
      const qData = {
        id: t.id,
        seq: queue.length + 1,
        date: SHORT_DATE,
        plate: t.plate,
        customerGroup: t.customerGroup || "",
        zone: t.zone || "",
        entryTime: t.entryTime || TIME_NOW(),
        exitTime: t.exitTime || "",
        time: t.entryTime || TIME_NOW()
      };
      await supabase.from("wh_queue").upsert({ id: t.id, data: qData });
      setQueue(prev => [...prev.filter(q => q.id !== t.id), qData]);
    }
    await supabase.from("wh_trucks").upsert({ id: t.id, data: t });
    setTrucks(prev => [...prev.filter(tr => tr.id !== t.id), t]);

    const actualTime = TIME_NOW();
    const diffStr = calcTimeDiffStr(t.entryTime, actualTime);
  };

  const handleUpdate = async (id, upd) => {
    const truck = trucks.find(t => t.id === id);
    if (!truck) return;

    if (upd.loadLanes) {
       for (const lane of Object.keys(upd.loadLanes)) {
         if (upd.loadLanes[lane].done && (!truck.loadLanes || !truck.loadLanes[lane] || !truck.loadLanes[lane].done)) {
           const lName = LOADING_LANES.find(l => l.id === lane)?.tinyLabel || lane;
           const imgs = upd.loadLanes[lane].photos || [];
           sendTeamsNotification(`✅ โหลดเสร็จ — รถ ${truck.plate}`, { "ลานโหลด": lName, "เวลาโหลดเสร็จ": upd.loadLanes[lane].doneAt || TIME_NOW() }, imgs);
         }
       }
    }

    const updated = { ...truck, ...upd };
    await supabase.from("wh_trucks").upsert({ id, data: updated });
    setTrucks(prev => prev.map(t => t.id === id ? updated : t));
  };

  const handleDeleteTruck = async (id) => {
    await supabase.from("wh_trucks").delete().eq("id", id);
  };

  const handleReset = async () => {
    if (!window.confirm("ล้างข้อมูลทั้งหมดสำหรับวันใหม่?")) return;
    // archive date = วันรอบงานที่เพิ่งปิด (same work-day cutoff as cycleDateStr, kept in sync via that helper)
    const archiveDate = cycleDateStr();
    await supabase.from("wh_archive").upsert({ archive_date: archiveDate, queue, trucks });
    await supabase.from("wh_queue").delete().neq("id", "");
    await supabase.from("wh_trucks").delete().neq("id", "");
  };

  const handleSetQueue = async (newQueue) => {
    const { error: delErr } = await supabase.from("wh_queue").delete().neq("id", "");
    if (delErr) throw new Error(delErr.message);
    if (newQueue.length > 0) {
      const { error: upErr } = await supabase.from("wh_queue").upsert(newQueue.map(q => ({ id: q.id, data: q })));
      if (upErr) throw new Error(upErr.message);
    }
    setQueue(newQueue);
    // merge walk-in trucks กับ queue entries แบบ one-to-one เรียงตาม seq
    const sortedQueue = [...newQueue].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const usedQueueIds = new Set();
    for (const truck of trucks) {
      const match = sortedQueue.find(q => plateNum(q.plate) === plateNum(truck.plate) && plateNum(q.plate) !== "" && !usedQueueIds.has(q.id));
      if (!match) continue;
      usedQueueIds.add(match.id);
      await supabase.from("wh_trucks").upsert({ id: truck.id, data: { ...truck, plate: match.plate, customerGroup: match.customerGroup, zone: match.zone, queueId: match.id, entryTime: match.entryTime, exitTime: match.exitTime } });
    }
  };

  const badge = {
    driver:        queue.filter(q => !trucks.find(t => t.queueId === q.id)).length,
    picking:       trucks.filter(t => t.status === "arrived").length,
    qc_parts:      trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.qcLanes?.lane_parts?.done).length,
    qc_head:       trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.qcLanes?.lane_head?.done).length,
    qc_pork:       trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.qcLanes?.lane_pork?.done).length,
    loading_parts: trucks.filter(t => t.status === "picking" && t.qcLanes?.lane_parts?.done && !t.loadLanes?.lane_parts?.done).length,
    loading_head:  trucks.filter(t => t.status === "picking" && t.qcLanes?.lane_head?.done  && !t.loadLanes?.lane_head?.done).length,
    loading_pork:  trucks.filter(t => t.status === "picking" && t.qcLanes?.lane_pork?.done  && !t.loadLanes?.lane_pork?.done).length,
    sample_parts:  trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.sampleLanes?.lane_parts?.done).length,
    sample_head:   trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.sampleLanes?.lane_head?.done).length,
    sample_pork:   trucks.filter(t => ["arrived","picking"].includes(t.status) && !t.sampleLanes?.lane_pork?.done).length,
    planning:      trucks.filter(t => t.status === "summary_printed").length,
  };

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "chart"     },
    { id: "lg",        label: "LG",      icon: "upload"    },
    { id: "driver",    label: "คนขับ",   icon: "scan"      },
    { id: "picking",   label: "Picking", icon: "clipboard" },
    { id: "qc_parts",      label: "ลานโหลด ชิ้นส่วน",      icon: "temp"      },
    { id: "qc_head",       label: "ลานโหลด หัว/เครื่องใน", icon: "temp"      },
    { id: "qc_pork",       label: "ลานโหลด หมูซีก",       icon: "temp"      },
    { id: "loading_parts", label: "Checker ลานโหลดชิ้นส่วน", icon: "pig_cuts"  },
    { id: "loading_head",  label: "Checker ลานโหลดหัว/เครื่องใน",  icon: "pig_head"  },
    { id: "loading_pork",  label: "Checker ลานโหลดหมูซีก",  icon: "pig_side"  },
    { id: "sample_parts",  label: "QC ชิ้นส่วน",          icon: "camera"    },
    { id: "sample_head",   label: "QC หัว/เครื่องใน",     icon: "camera"    },
    { id: "sample_pork",   label: "QC หมูซีก",           icon: "camera"    },
    { id: "overview_log",   label: "Log ภาพรวมการทำงาน",  icon: "list"  },
    { id: "work_tracking",  label: "Tracking การทำงาน",  icon: "chart" },
    { id: "planning",      label: "Invoice",       icon: "plan"      },
    { id: "detail_loading", label: "อัพโหลด PO", icon: "clipboard" },
    { id: "download",       label: "จบการทำงาน",       icon: "invoice"   },
    { id: "admin",          label: "Admin",          icon: "plan"      },
    { id: "qr",             label: "QR Code",       icon: "scan"      },
  ];

  // ── Kiosk header helper ──
  const KioskHeader = ({ emoji, title, color = "#111" }) => (
    <div style={{ background: color, color: "#fff", padding: "0 14px", position: "sticky", top: 0, zIndex: 100, height: 56, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      <span style={{ fontSize: 22 }}>{emoji}</span>
      <div style={{ fontWeight: 800, fontSize: 16 }}>{title}</div>
    </div>
  );

  const isKioskMode = isDriverMode || isQcPartsMode || isQcHeadMode || isQcPorkMode
    || isLoadingPartsMode || isLoadingHeadMode || isLoadingPorkMode
    || isSamplePartsMode || isSampleHeadMode || isSamplePorkMode;
  const allowedTabIds = ROLE_TABS[role] || null;
  const visibleTabs = allowedTabIds ? tabs.filter(t => allowedTabIds.includes(t.id)) : tabs;

  // ── Role select (เลือกตำแหน่งงานก่อนเข้าระบบ) ──
  if (!isKioskMode && !role) {
    return <RoleSelect onSelect={handleSelectRole} />;
  }

  // ── Lane select (เลือกเมนูย่อยหลังเลือกตำแหน่งงาน) ──
  if (!isKioskMode && role && !tab) {
    const roleLabel = ROLE_OPTIONS.find(r => r.id === role)?.label || "";
    return <LaneSelect tabs={visibleTabs} roleLabel={roleLabel} onSelect={setTab} onBack={handleChangeRole} />;
  }

  // ── Driver-only mode ──
  if (isDriverMode) {
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🚛" title="เช็คอินคนขับ" />
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 14px 60px" }}>
          <DriverScan queue={queue} trucks={trucks} onScan={handleScan} />
        </div>
      </div>
    );
  }

  // ── QC kiosk modes ──
  if (isQcPartsMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🌡️" title="ลานโหลด ชิ้นส่วน" color="#0369a1" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />
        </div>
      </div>
    );
  }

  if (isQcHeadMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🌡️" title="ลานโหลด หัว/เครื่องใน" color="#0369a1" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />
        </div>
      </div>
    );
  }

  if (isQcPorkMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🌡️" title="ลานโหลด หมูซีก" color="#0369a1" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />
        </div>
      </div>
    );
  }

  // ── Loading lane kiosk modes ──
  if (isLoadingPartsMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🥩" title="Checker ลานโหลดชิ้นส่วน" color="#c2410c" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />
        </div>
      </div>
    );
  }

  if (isLoadingHeadMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🐷" title="Checker ลานโหลดหัว/เครื่องใน" color="#7c3aed" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />
        </div>
      </div>
    );
  }

  if (isLoadingPorkMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="🐖" title="Checker ลานโหลดหมูซีก" color="#be123c" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />
        </div>
      </div>
    );
  }

  // ── Random sample temp-check kiosk modes ──
  if (isSamplePartsMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="📷" title="QC ชิ้นส่วน" color="#0d9488" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />
        </div>
      </div>
    );
  }

  if (isSampleHeadMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="📷" title="QC หัว/เครื่องใน" color="#0d9488" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />
        </div>
      </div>
    );
  }

  if (isSamplePorkMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
        <KioskHeader emoji="📷" title="QC หมูซีก" color="#0d9488" />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 14px 60px" }}>
          <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "'Sarabun','Noto Sans Thai',sans-serif" }}>
      <div style={{ background: "#111", color: "#fff", padding: "0 14px", position: "sticky", top: 0, zIndex: 100, height: 80, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: isMobile ? 1 : "none" }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontWeight: 800, fontSize: isMobile ? 12 : 14, lineHeight: 1.2 }}>ระบบโหลดสินค้าโรงงานพระพุทธบาท</div>
            {isNarrow && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>{TODAY} {headerClock}</div>}
          </div>
          <select value={tab} onChange={e => {
              const v = e.target.value;
              if (v === "__change_role__") { handleChangeRole(); return; }
              setTab(v); setDashLane("main");
            }}
            style={{ flex: "none", background: "#1f2937", color: "#f9fafb", border: "1px solid #374151", borderRadius: 0, padding: isMobile ? "6px 10px" : "6px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer", outline: "none", marginLeft: isMobile ? "auto" : 6 }}>
            {visibleTabs.map(t => {
              const n = badge[t.id] || 0;
              return <option key={t.id} value={t.id}>{t.label}{n > 0 ? ` · ${n}` : ""}</option>;
            })}
            <option value="__change_role__">(กลับหน้าหลัก)</option>
          </select>
          {!isMobile && tab === "dashboard" && (
            <div style={{ display: "flex", gap: 2 }}>
              {[
                { id: "main",       label: "Main"           },
                { id: "lane_parts", label: "ชิ้นส่วน"       },
                { id: "lane_head",  label: "หัว/เครื่องใน"  },
                { id: "lane_pork",  label: "หมูซีก"         },
              ].map(l => {
                const active = dashLane === l.id;
                return (
                  <button key={l.id} onClick={() => setDashLane(l.id)}
                    style={{ background: "transparent", color: active ? "#fff" : "#9ca3af", border: "none", borderBottom: active ? "2px solid #fff" : "2px solid transparent", padding: "4px 10px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    {l.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!isNarrow && <div style={{ color: "#f9fafb", fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{TODAY} {headerClock}</div>}
      </div>
      <div style={{ maxWidth: tab === "dashboard" || tab === "work_tracking" ? "none" : tab === "picking" ? 1400 : 960, margin: "0 auto", padding: tab === "dashboard" ? (isMobile ? "8px 10px 80px" : "8px 14px 14px") : (isMobile ? "16px 12px 80px" : "20px 14px 100px") }}>
        {tab === "dashboard" && <Dashboard trucks={trucks} queue={queue} onReset={handleReset} lane={dashLane === "main" ? null : dashLane} detailMap={detailMap} />}
        {tab === "qr"        && <QRCodePage />}
        {tab === "lg"        && <LGUpload queue={queue} onSetQueue={handleSetQueue} />}
        {tab === "driver"    && <DriverScan queue={queue} trucks={trucks} onScan={handleScan} skipGeofence />}
        {tab === "picking"   && <Picking trucks={trucks} queue={queue} onUpdate={handleUpdate} detailMap={detailMap} />}
        {tab === "qc_parts"  && <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />}
        {tab === "qc_head"   && <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />}
        {tab === "qc_pork"   && <QC trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />}
        {tab === "loading_parts" && <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />}
        {tab === "loading_head"  && <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />}
        {tab === "loading_pork"  && <LoadingYard trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />}
        {tab === "sample_parts"  && <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_parts" />}
        {tab === "sample_head"   && <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_head" />}
        {tab === "sample_pork"   && <RandomSampleCheck trucks={trucks} onUpdate={handleUpdate} laneId="lane_pork" />}
        {tab === "overview_log"  && <OverviewLog trucks={trucks} />}
        {tab === "work_tracking" && <WorkTracking trucks={trucks} queue={queue} />}
        {tab === "planning"      && <Planning trucks={trucks} queue={queue} onUpdate={handleUpdate} />}
        {tab === "detail_loading" && <DetailLoading masterLane={masterLane} onMasterChange={handleMasterChange} onDetailChange={handleDetailChange} />}
        {tab === "download"       && <Download onReset={handleReset} />}
        {tab === "admin"          && <Admin trucks={trucks} queue={queue} onUpdate={handleUpdate} onDeleteTruck={handleDeleteTruck} />}
      </div>

      {/* QR Code Modal */}
    </div>
  );
}
