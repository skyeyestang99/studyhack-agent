import pg from "pg";
import pgvector from "pgvector/pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
});

// Register the pgvector type so `vector` columns marshal to/from JS arrays.
pool.on("connect", (client) => {
  pgvector.registerType(client).catch(() => {});
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}
