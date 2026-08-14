-- ============================================================
-- เพิ่มตาราง wh_master_upload_log สำหรับฟีเจอร์ "ประวัติการอัพโหลด Master"
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- log ทุกครั้งที่มีการอัปโหลด/เปลี่ยนไฟล์ Master ลานโหลด หนึ่งแถวต่อครั้ง
-- สะสมตลอดไป ใช้แสดงในหน้า "อัพโหลด Master" เป็นประวัติการอัพโหลด
-- ============================================================

create table if not exists wh_master_upload_log (
  id   text primary key,
  data jsonb
);

alter table wh_master_upload_log enable row level security;
drop policy if exists "allow all" on wh_master_upload_log;
create policy "allow all" on wh_master_upload_log for all using (true) with check (true);
