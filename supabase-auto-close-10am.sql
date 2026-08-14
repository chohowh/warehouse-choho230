-- ============================================================
-- Auto-close work day ที่ 10:00 น. (Asia/Bangkok)
-- รันสคริปต์นี้ครั้งเดียวใน Supabase SQL Editor ของ project จริง
-- (ต้องรันด้วยสิทธิ์ owner/admin — anon key ของแอปทำแบบนี้ไม่ได้)
--
-- ทำสิ่งเดียวกับปุ่ม "ล้างวันใหม่" ใน Dashboard (handleReset ใน App.jsx):
--   1. archive แถวปัจจุบันของ wh_queue + wh_trucks ไปที่ wh_archive
--   2. ลบ wh_queue และ wh_trucks ให้ว่างสำหรับรอบใหม่
-- ปุ่ม "ล้างวันใหม่" ในแอปยังใช้งานได้ตามปกติ (เผื่อกดปิดงานนอกรอบ/เร็วกว่า 10:00)
-- ============================================================

-- 1) เปิด extension pg_cron (ถ้ายังไม่เปิด)
--    ถ้ารันแล้ว error เรื่องสิทธิ์ ให้ไปเปิดผ่าน
--    Dashboard → Database → Extensions → ค้นหา "pg_cron" → Enable
create extension if not exists pg_cron;

-- 2) ฟังก์ชันปิดงาน — คำนวณ archive_date จากเวลา Bangkok ตรง ๆ
--    (งานนี้ตั้งให้รันตอน 10:00 Bangkok พอดี จึงไม่ต้องมี logic ก่อน/หลังเที่ยงแบบ cycleDateStr)
create or replace function close_work_day() returns void as $$
declare
  v_archive_date date := (now() at time zone 'Asia/Bangkok')::date;
  v_queue        jsonb;
  v_trucks       jsonb;
begin
  select coalesce(jsonb_agg(data order by (data->>'seq')::numeric nulls last), '[]'::jsonb)
    into v_queue
    from wh_queue;

  select coalesce(jsonb_agg(data), '[]'::jsonb)
    into v_trucks
    from wh_trucks;

  insert into wh_archive (archive_date, queue, trucks)
  values (v_archive_date, v_queue, v_trucks)
  on conflict (archive_date) do update
    set queue  = excluded.queue,
        trucks = excluded.trucks;

  delete from wh_queue;
  delete from wh_trucks;
end;
$$ language plpgsql security definer;

-- 3) ตั้งเวลา — pg_cron ของ Supabase รันตาม UTC
--    03:00 UTC = 10:00 Asia/Bangkok (UTC+7, ไทยไม่มี DST จึงไม่ขยับ)
--    รันซ้ำได้ปลอดภัย: ถ้ามี job ชื่อนี้อยู่แล้ว cron.schedule จะอัปเดตให้ ไม่สร้างซ้ำ
select cron.schedule(
  'close-work-day-10am',
  '0 3 * * *',
  $$ select close_work_day(); $$
);

-- ============================================================
-- ตรวจสอบหลังรัน
-- ============================================================
-- ดูว่า job ถูกตั้งไว้จริง:
--   select * from cron.job;
-- ดู log การรันแต่ละครั้ง (เช็คตอนเช้าวันถัดไปหลัง 10:00 ว่า status = 'succeeded'):
--   select * from cron.job_run_details order by start_time desc limit 5;
--
-- ⚠️ ห้ามรัน `select close_work_day();` ทดสอบตรง ๆ ในเวลาทำงานจริง
--   เพราะมันจะ archive + ลบ wh_queue/wh_trucks ทันทีเหมือนกดปุ่ม "ล้างวันใหม่" จริง
--
-- ยกเลิก automation (ถ้าต้องการ):
--   select cron.unschedule('close-work-day-10am');
-- ============================================================
