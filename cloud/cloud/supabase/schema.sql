-- =====================================================================
-- IIT UPS Monitor | Capa nube (Supabase)
-- Ejecutar en: Supabase > SQL Editor
-- Escritura: solo la Raspberry con service_role (salta RLS)
-- Lectura: usuarios autenticados (dashboard remoto)
-- =====================================================================

create table if not exists public.ups_devices (
  device_id    text primary key,
  name         text,
  site         text,
  manufacturer text,
  model        text,
  firmware     text,
  driver       text,
  last_seen    timestamptz,
  latest       jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists public.ups_readings (
  id        bigint generated always as identity primary key,
  device_id text not null references public.ups_devices(device_id) on delete cascade,
  ts        timestamptz not null,
  in_v real, in_f real, out_v real, out_f real, out_a real, load real,
  out_va real, out_w real, batt_v real, batt_pct real, runtime real, temp real,
  status    text
);
create index if not exists ups_readings_device_ts on public.ups_readings (device_id, ts desc);

create table if not exists public.ups_events (
  id        bigint generated always as identity primary key,
  device_id text not null references public.ups_devices(device_id) on delete cascade,
  ts        timestamptz not null,
  code      text not null,
  severity  text not null check (severity in ('info','warn','crit')),
  state     text not null check (state in ('raised','cleared')),
  message   text,
  value     real
);
create index if not exists ups_events_device_ts on public.ups_events (device_id, ts desc);

alter table public.ups_devices  enable row level security;
alter table public.ups_readings enable row level security;
alter table public.ups_events   enable row level security;

drop policy if exists "lectura autenticados" on public.ups_devices;
drop policy if exists "lectura autenticados" on public.ups_readings;
drop policy if exists "lectura autenticados" on public.ups_events;
create policy "lectura autenticados" on public.ups_devices  for select to authenticated using (true);
create policy "lectura autenticados" on public.ups_readings for select to authenticated using (true);
create policy "lectura autenticados" on public.ups_events   for select to authenticated using (true);

-- Tiempo real para el dashboard remoto
alter publication supabase_realtime add table public.ups_devices;
alter publication supabase_realtime add table public.ups_events;

-- Retención en la nube (90 días). Requiere la extensión pg_cron habilitada.
-- select cron.schedule('ups-retencion', '15 3 * * *',
--   $$delete from public.ups_readings where ts < now() - interval '90 days'$$);

-- Vista de resumen diario (útil para informes a clientes)
create or replace view public.ups_daily as
select device_id,
       date_trunc('day', ts at time zone 'America/Bogota') as dia,
       min(in_v) as in_v_min, max(in_v) as in_v_max, round(avg(in_v)::numeric, 1) as in_v_avg,
       max(load) as load_max, round(avg(load)::numeric, 1) as load_avg,
       round(avg(out_w)::numeric, 0) as out_w_avg, max(temp) as temp_max, min(batt_pct) as batt_pct_min,
       count(*) as muestras
from public.ups_readings
group by 1, 2;
alter view public.ups_daily set (security_invoker = true);
