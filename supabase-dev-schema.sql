-- ============================================================
-- Warehouse Phraputthabath — Dev Schema Setup
-- รันใน Supabase SQL Editor ของ dev project
--
-- หมายเหตุ: แอปเก็บข้อมูลทั้งหมดในรูป id + data (jsonb) เพียง 4 ตาราง
-- ไม่มีตารางแยกคอลัมน์ราย field (trucks/qc_records/loading_records แบบเก่า
-- ไม่ได้ใช้งานจริงแล้ว ตัดออกจากไฟล์นี้)
--
-- รูปสินค้า/อุณหภูมิไม่ได้เก็บใน Supabase Storage — อัปโหลดไป Cloudflare R2
-- ผ่าน src/lib/r2.js แทน ต้องตั้งค่า VITE_R2_* แยกชุดสำหรับ dev ใน Vercel
-- (Environment: Preview) ไม่ใช้ตัวเดียวกับ production
-- ============================================================

-- ─── wh_queue ──────────────────────────────────────────────
-- คิวรถจาก LG (ตารางคิวที่ LG อัปโหลด)
create table if not exists wh_queue (
  id   text primary key,
  data jsonb
);

alter table wh_queue enable row level security;
drop policy if exists "allow all" on wh_queue;
create policy "allow all" on wh_queue for all using (true) with check (true);

-- ─── wh_trucks ─────────────────────────────────────────────
-- รถแต่ละคัน หนึ่งแถวต่อคัน — data.qcLanes / data.loadLanes / data.sampleLanes
-- เก็บแยกกันคนละ field ในก้อน JSON เดียวกัน ไม่ชนกัน:
--   data.qcLanes.<lane_id>     = { done, temp, photos[], doneAt }   — QC ตรวจอุณหภูมิรถ
--   data.loadLanes.<lane_id>   = { done, waiting, photos[], note, doneAt, waitingAt } — Checker (ลานโหลดจริง)
--   data.sampleLanes.<lane_id> = { done, photos[], doneAt }         — ลานโหลด: สุ่มตรวจอุณหภูมิสินค้า (ไม่มี temp, แนบรูปอย่างเดียว)
-- lane_id คือหนึ่งใน: lane_parts | lane_head | lane_pork
create table if not exists wh_trucks (
  id   text primary key,
  data jsonb
);

alter table wh_trucks enable row level security;
drop policy if exists "allow all" on wh_trucks;
create policy "allow all" on wh_trucks for all using (true) with check (true);

-- ─── wh_master ─────────────────────────────────────────────
-- ไฟล์ Master ลานโหลด (id = 'master') และไฟล์ Detail Loading รายแหล่ง (id = 'detail_<source_id>')
create table if not exists wh_master (
  id   text primary key,
  data jsonb
);

alter table wh_master enable row level security;
drop policy if exists "allow all" on wh_master;
create policy "allow all" on wh_master for all using (true) with check (true);

-- ─── wh_archive ────────────────────────────────────────────
-- สแนปช็อตคิว/รถรายวัน เก็บไว้ดู log ย้อนหลัง (Loading Log / QC Log / Log การตรวจอุณหภูมิสินค้า)
create table if not exists wh_archive (
  archive_date date primary key,
  queue        jsonb,
  trucks       jsonb
);

alter table wh_archive enable row level security;
drop policy if exists "allow all" on wh_archive;
create policy "allow all" on wh_archive for all using (true) with check (true);
