-- ============================================================
-- เพิ่มตาราง wh_waiting_reasons — รายการเหตุผล "รอสินค้าอะไร" (fallback)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- data = { label, sortOrder }
-- ใช้เฉพาะตอนไฟล์ Master ไม่มีชื่อสินค้า match กับลานนั้นเลย (ปกติ dropdown
-- จะดึงชื่อสินค้าจาก Master ก่อนเสมอ) ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปจะ
-- fallback ไปใช้รายการ default ในโค้ด
-- ============================================================

create table if not exists wh_waiting_reasons (
  id   text primary key,
  data jsonb
);

alter table wh_waiting_reasons enable row level security;
drop policy if exists "allow all" on wh_waiting_reasons;
create policy "allow all" on wh_waiting_reasons for all using (true) with check (true);
