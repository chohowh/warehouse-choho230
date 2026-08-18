-- ============================================================
-- เพิ่มตาราง wh_bays — ช่องโหลดย่อยในแต่ละลาน (override/เพิ่มเติมของ default ในโค้ด)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id   = รหัสช่องโหลด (เช่น lane_parts_bay_1) ต้องคงที่ตลอดอายุระบบเพราะผูกกับ
--        qcLanes/sampleLanes/loadLanes[...].bayId ที่บันทึกไว้แล้ว
-- data = { laneId, label, sortOrder } หรือ { deleted: true, laneId } (tombstone)
--   laneId    = lane_parts | lane_head | lane_pork (ลานที่ช่องนี้อยู่ใต้)
--   label     = ชื่อช่องที่แสดงในหน้าเลือกช่องโหลด (แก้ได้อิสระผ่าน Master Setting)
--   sortOrder = ลำดับการแสดงภายในลานเดียวกัน
--   deleted   = true เฉพาะแถวที่ใช้ "ลบ" ช่องโหลด default ในโค้ด (7/2/4 ช่องเริ่มต้น) —
--               default ไม่มีแถวจริงให้ DELETE ได้ตรงๆ เพราะ fallback มาจากโค้ดเสมอ จึงต้อง
--               insert แถว tombstone นี้แทนเพื่อให้ loadBays() รู้ว่าต้องข้าม id นี้ทุกครั้ง
--
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปจะ fallback ไปใช้ค่า default ในโค้ด
-- (ชิ้นส่วน 7 ช่อง / หัวเครื่องใน 2 ช่อง / หมูซีก 4 ช่อง)
-- ============================================================

create table if not exists wh_bays (
  id   text primary key,
  data jsonb
);

alter table wh_bays enable row level security;
drop policy if exists "allow all" on wh_bays;
create policy "allow all" on wh_bays for all using (true) with check (true);
