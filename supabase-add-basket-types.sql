-- ============================================================
-- เพิ่มตาราง wh_basket_types — ประเภทตะกร้า/ตะขอ (เสริม/override 4 ตัว default ในโค้ด)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id = key ของประเภทตะกร้า (ต้องคงที่ตลอดไปถ้ามีข้อมูลผูกอยู่แล้ว — ห้ามเปลี่ยน/ลบ
-- key ที่เคยมีรถบันทึกข้อมูลด้วย key นี้ไว้แล้ว)
-- data = { label, countsInTotal, sortOrder }
--   countsInTotal: นับรวมใน "รวมตะกร้า" ไหม (ของเดิม hooks = false เพราะเป็นคนละหน่วย)
--
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปมี 4 ประเภท default อยู่ในโค้ดแล้ว
-- (yellowBig, yellowSmall, gray, hooks) ตารางนี้ไว้ "เพิ่ม" ประเภทใหม่ หรือ
-- "override" label ของประเภทเดิมเท่านั้น ไม่ได้แทนที่ทั้งชุด
-- ============================================================

create table if not exists wh_basket_types (
  id   text primary key,
  data jsonb
);

alter table wh_basket_types enable row level security;
drop policy if exists "allow all" on wh_basket_types;
create policy "allow all" on wh_basket_types for all using (true) with check (true);
