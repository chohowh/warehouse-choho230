-- ============================================================
-- เพิ่มตาราง wh_roles — ป้ายชื่อ/emoji/รูปของตำแหน่งงาน (override ของ default ในโค้ด)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
--
-- id ต้องเป็นหนึ่งใน 10 ตำแหน่งที่โค้ดรู้จักอยู่แล้ว (qc, checker, loading, office_wh,
-- office_plan, lg, dashboard_only, loading_data, tracking, all) — แถวที่ id ไม่ตรง
-- จะถูกแอปเมิน เพราะ ROLE_TABS/LANE_SELECT_ROLES ผูก logic กับ id เดิมตรงๆ
-- data = { label, emoji, img } — แก้ได้แค่หน้าตา ไม่ใช่เพิ่ม/ลบตำแหน่งงาน
-- ไม่ต้องมีข้อมูลในตารางนี้ก็ได้ — แอปจะ fallback ไปใช้ค่า default ในโค้ด
-- ============================================================

create table if not exists wh_roles (
  id   text primary key,
  data jsonb
);

alter table wh_roles enable row level security;
drop policy if exists "allow all" on wh_roles;
create policy "allow all" on wh_roles for all using (true) with check (true);
