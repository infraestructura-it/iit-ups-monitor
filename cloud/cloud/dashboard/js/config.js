// Configura con los datos de tu proyecto Supabase (Settings > API). La anon key es pública por diseño;
// la seguridad la dan las políticas RLS de schema.sql (solo usuarios autenticados leen).
export const SUPABASE_URL = 'https://jntxowiyfwhthxhuoifb.supabase.co';
export const SUPABASE_ANON_KEY = 'PEGA_AQUI_LA_ANON_KEY';
export const OFFLINE_AFTER_MS = 120_000; // sin latido en 2 min = equipo desconectado
