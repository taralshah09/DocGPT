// db/client.js
// PostgreSQL via `pg` — stores sources, documents, and chunks (metadata).
// Vectors are stored in Qdrant (db/qdrant.js).

import pg from "pg";
import path from "path";
import fs from "fs";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

let _pool;

export function getPool() {
  if (_pool) return _pool;

  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL not set. Falling back to localhost:5432/postgres.");
  }

  _pool = new Pool({
    connectionString: DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres",
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  return _pool;
}

/**
 * Initialize the database schema from models.sql.
 */
export async function initDb() {
  const pool = getPool();
  const sqlFile = path.resolve("./db/models.sql");

  if (!fs.existsSync(sqlFile)) {
    throw new Error(`Schema file not found at ${sqlFile}`);
  }

  const sql = fs.readFileSync(sqlFile, "utf-8");

  console.log("[db] Initializing schema from models.sql...");

  // Strip ALL comments before splitting to avoid bare comments being sent as statements.
  const cleanSql = sql.replace(/--.*$/gm, "");

  const statements = cleanSql
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (err) {
      if (!err.message.includes("already exists")) {
        console.error(`[db] Schema error in statement: "${statement.slice(0, 60)}...":`, err.message);
      }
    }
  }

  console.log("[db] Schema ready.");
}

// ─── source ops ───────────────────────────────────────────────────────────────

export async function upsertSource({ id, name, base_url }) {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO sources (id, name, base_url)
     VALUES ($1, $2, $3)
     ON CONFLICT(base_url) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [id, name, base_url]
  );
  return res.rows[0].id; // Return the actual ID from DB (could be new or existing)
}

export async function getSource(base_url) {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM sources WHERE base_url = $1", [base_url]);
  return res.rows[0];
}

export async function getAllSources() {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM sources");
  return res.rows;
}

// ─── document ops ─────────────────────────────────────────────────────────────

export async function upsertDocument(doc) {
  const pool = getPool();

  const existing = await pool.query(
    "SELECT content_hash FROM documents WHERE url = $1",
    [doc.url]
  );

  if (existing.rows[0]?.content_hash === doc.content_hash) {
    return { changed: false };
  }

  await pool.query(
    `INSERT INTO documents (id, source_id, url, title, content, last_crawled, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(url) DO UPDATE SET
       title        = EXCLUDED.title,
       content      = EXCLUDED.content,
       last_crawled = EXCLUDED.last_crawled,
       content_hash = EXCLUDED.content_hash`,
    [doc.id, doc.source_id, doc.url, doc.title, doc.content, doc.last_crawled, doc.content_hash]
  );

  if (existing.rows[0]) {
    await pool.query("DELETE FROM chunks WHERE document_id = $1", [doc.id]);
  }

  return { changed: true };
}

export async function getDocumentByUrl(url) {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM documents WHERE url = $1", [url]);
  return res.rows[0];
}

export async function getAllDocumentIds() {
  const pool = getPool();
  const res = await pool.query("SELECT id FROM documents");
  return res.rows.map(r => r.id);
}

// ─── chunk ops ────────────────────────────────────────────────────────────────

/**
 * Bulk-insert chunks into Postgres (metadata ONLY, no embeddings).
 */
export async function insertChunks(chunks) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const c of chunks) {
      // Columns: id, document_id, content, heading, token_count
      await client.query(
        `INSERT INTO chunks (id, document_id, content, heading, token_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(id) DO UPDATE SET
           content     = EXCLUDED.content,
           heading     = EXCLUDED.heading,
           token_count = EXCLUDED.token_count`,
        [c.chunk_id, c.doc_id, c.content, c.heading ?? null, c.token_count]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hydrate chunk + document metadata for a list of chunk UUIDs back from Qdrant.
 */
export async function getChunksByIds(chunkIds) {
  if (!chunkIds.length) return [];
  const pool = getPool();
  const res = await pool.query(
    `SELECT c.id AS chunk_id, c.content, c.heading, c.token_count,
            d.id AS document_id, d.url, d.title, d.source_id
     FROM   chunks c
     JOIN   documents d ON d.id = c.document_id
     WHERE  c.id = ANY($1::uuid[])`,
    [chunkIds]
  );
  return res.rows;
}

// ─── stats ────────────────────────────────────────────────────────────────────

export async function getStats() {
  const pool = getPool();
  const [sources, documents, chunks] = await Promise.all([
    pool.query("SELECT COUNT(*) AS n FROM sources"),
    pool.query("SELECT COUNT(*) AS n FROM documents"),
    pool.query("SELECT COUNT(*) AS n FROM chunks"),
  ]);

  return {
    sources: parseInt(sources.rows[0].n),
    documents: parseInt(documents.rows[0].n),
    chunks: parseInt(chunks.rows[0].n),
  };
}