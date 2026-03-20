-- db/models.sql
-- PostgreSQL schema for RAG system (metadata storage).
-- Vectors are stored in Qdrant (server/db/qdrant.js).

-- ─────────────────────────────────────────────────────────────────────────────
-- sources  — one row per documentation site
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,              -- "react"
    base_url    TEXT NOT NULL UNIQUE,       -- "https://react.dev"
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- documents  — one row per page/URL crawled
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT UNIQUE NOT NULL,
    title        TEXT,
    content      TEXT,                      -- clean markdown
    last_crawled TIMESTAMPTZ,
    content_hash TEXT                       -- MD5 for change detection
);

CREATE INDEX IF NOT EXISTS idx_documents_source_id ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_url       ON documents(url);

-- ─────────────────────────────────────────────────────────────────────────────
-- chunks  — text chunks (metadata only, vectors in Qdrant)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID REFERENCES documents(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    heading      TEXT,
    token_count  INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);