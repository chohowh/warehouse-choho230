-- ============================================================
-- เพิ่มตาราง wh_basket_returns สำหรับฟีเจอร์ "บันทึกการคืนตะกร้า/ตะขอ"
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- log การคืนตะกร้า หนึ่งแถวต่อการคืนหนึ่งครั้ง — สะสมตลอดไป ไม่ถูกล้าง
-- ตอนกดปิดงาน ("ล้างวันใหม่") ต่างจาก wh_queue/wh_trucks
-- หน้า "ข้อมูลยอดตะกร้า/ตะขอ" ใช้ตารางนี้เทียบกับยอดตะกร้าที่ออกไปสะสมทุกวัน
-- (จาก wh_archive.trucks ทุกวัน + คิววันนี้ที่ยังไม่ปิดงาน) เพื่อคำนวณว่า
-- แต่ละทะเบียนรถยังค้างคืนตะกร้า/ตะขอเท่าไร
-- ============================================================

create table if not exists wh_basket_returns (
  id   text primary key,
  data jsonb
);

alter table wh_basket_returns enable row level security;
drop policy if exists "allow all" on wh_basket_returns;
create policy "allow all" on wh_basket_returns for all using (true) with check (true);
