-- ============================================================
-- เพิ่มตาราง wh_lanes — ป้ายชื่อ/สี/emoji ของลานโหลด (override ของ default ในโค้ด)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id = lane_parts | lane_head | lane_pork (ต้องตรงกับ id ที่โค้ดรู้จักเท่านั้น
-- ไม่งั้นแถวนั้นจะไม่ผูกกับ kiosk routing ที่มีอยู่แล้ว)
-- data = { label, shortLabel, tinyLabel, emoji, color, bg, border, sortOrder }
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปจะ fallback ไปใช้ค่า default ในโค้ด
-- ============================================================

create table if not exists wh_lanes (
  id   text primary key,
  data jsonb
);

alter table wh_lanes enable row level security;
drop policy if exists "allow all" on wh_lanes;
create policy "allow all" on wh_lanes for all using (true) with check (true);
