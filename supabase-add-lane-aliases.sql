-- ============================================================
-- เพิ่มตาราง wh_lane_aliases — ชื่อเรียกลานแบบอื่นๆ ที่พบในไฟล์ Master
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id = ข้อความ alias ตรงตัว (เช่น "หัวเครื่องในหมู"), data = { laneKey }
-- laneKey ต้องเป็นหนึ่งใน: lane_parts | lane_head | lane_pork
-- ใช้เสริม LANE_NAME_MAP ที่ hardcode ไว้ในโค้ด (ยังใช้เป็น default อยู่)
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปจะ fallback ไปใช้ค่า default ในโค้ด
-- ============================================================

create table if not exists wh_lane_aliases (
  id   text primary key,
  data jsonb
);

alter table wh_lane_aliases enable row level security;
drop policy if exists "allow all" on wh_lane_aliases;
create policy "allow all" on wh_lane_aliases for all using (true) with check (true);
