import { readFileSync } from "node:fs";
import pg from "pg";
const url = readFileSync(".env","utf8").split("\n").find(l=>l.startsWith("DATABASE_URL="))
  .slice(13).replace(/^["']|["']$/g,"");
const c = new pg.Client({ connectionString: url, ssl:{rejectUnauthorized:false} });
await c.connect();
for (const q of process.argv.slice(2)) { const r = await c.query(q); console.table(r.rows); }
await c.end();
