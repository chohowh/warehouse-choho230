-- ============================================================
-- Warehouse Phraputthabath — Dev Schema Setup
-- รันใน Supabase SQL Editor ของ dev project
-- ============================================================

-- ─── trucks ────────────────────────────────────────────────
create table if not exists trucks (
  id           bigserial primary key,
  "Truck_Plate" text not null,
  "Truck_Type"  text,
  "Status"      text default 'waiting',
  "Que_Date"    date,
  "Loading_Bay" text,
  created_at   timestamptz default now()
);

alter table trucks enable row level security;
create policy "allow all" on trucks for all using (true) with check (true);

-- ─── qc_records ────────────────────────────────────────────
create table if not exists qc_records (
  id          bigserial primary key,
  truck_plate text,
  temperature numeric,
  loading_bay text,
  photo_url   text,
  created_at  timestamptz default now()
);

alter table qc_records enable row level security;
create policy "allow all" on qc_records for all using (true) with check (true);

-- ─── loading_records ───────────────────────────────────────
create table if not exists loading_records (
  id          bigserial primary key,
  truck_plate text,
  loading_bay text,
  photo_url   text,
  created_at  timestamptz default now()
);

alter table loading_records enable row level security;
create policy "allow all" on loading_records for all using (true) with check (true);

-- ─── wh_queue ──────────────────────────────────────────────
create table if not exists wh_queue (
  id   text primary key,
  data jsonb
);

alter table wh_queue enable row level security;
create policy "allow all" on wh_queue for all using (true) with check (true);

-- ─── wh_trucks ─────────────────────────────────────────────
create table if not exists wh_trucks (
  id   text primary key,
  data jsonb
);

alter table wh_trucks enable row level security;
create policy "allow all" on wh_trucks for all using (true) with check (true);

-- ─── wh_master ─────────────────────────────────────────────
create table if not exists wh_master (
  id   text primary key,
  data jsonb
);

alter table wh_master enable row level security;
create policy "allow all" on wh_master for all using (true) with check (true);

-- ─── wh_archive ────────────────────────────────────────────
create table if not exists wh_archive (
  archive_date date primary key,
  queue        jsonb,
  trucks       jsonb
);

alter table wh_archive enable row level security;
create policy "allow all" on wh_archive for all using (true) with check (true);

-- ============================================================
-- Storage buckets (รันใน SQL Editor ได้เลย)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('qc-photos', 'qc-photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('loading-photos', 'loading-photos', true)
on conflict (id) do nothing;

-- Storage policies
create policy "allow all qc-photos" on storage.objects
  for all using (bucket_id = 'qc-photos') with check (bucket_id = 'qc-photos');

create policy "allow all loading-photos" on storage.objects
  for all using (bucket_id = 'loading-photos') with check (bucket_id = 'loading-photos');
