-- ============================================================
-- เพิ่มตาราง wh_detail_sources — ช่องทาง PO (เสริม/override 3 ช่องทาง default ในโค้ด)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id = รหัสช่องทาง (ต้องคงที่ตลอดไปถ้ามีข้อมูลผูกอยู่แล้วใน wh_master:
--   detail_<id>_<date> — ห้ามเปลี่ยน/ลบ id ที่เคยอัปโหลดไฟล์ไว้แล้ว)
-- data = { label, emoji, color, bg, plateCol, productCodeCol, groupFlagCol, matchKeywords }
--   plateCol/productCodeCol/groupFlagCol = ตำแหน่งคอลัมน์ (0-based) ในไฟล์ retailer นั้น
--   matchKeywords = คำที่ใช้จับคู่จากช่อง "กลุ่มลูกค้า" ของ LG ว่ารถวิ่งช่องทางไหน
--
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปมี 3 ช่องทาง default อยู่ในโค้ดแล้ว
-- (wet_market, modern_trade, others) ตารางนี้ไว้ "เพิ่ม" ช่องทางใหม่ หรือ
-- "override" คอลัมน์/label ของช่องทางเดิมเท่านั้น ไม่ได้แทนที่ทั้งชุด
-- ============================================================

create table if not exists wh_detail_sources (
  id   text primary key,
  data jsonb
);

alter table wh_detail_sources enable row level security;
drop policy if exists "allow all" on wh_detail_sources;
create policy "allow all" on wh_detail_sources for all using (true) with check (true);
