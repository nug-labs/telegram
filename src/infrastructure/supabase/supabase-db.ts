import { Pool } from "pg";
import dns from "node:dns";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required for Supabase analytics`);
  }
  return value;
}

export function getSupabasePool(): Pool {
  // Many container/runtime networks do not have IPv6 routes.
  // Prefer IPv4 when resolving Supabase hostnames.
  dns.setDefaultResultOrder("ipv4first");

  const connectionString = requireEnv("SUPABASE_DB_URL");
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
}

