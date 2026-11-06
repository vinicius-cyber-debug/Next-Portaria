-- Files stay in private object storage; PostgreSQL stores identity and integrity.
CREATE TABLE media_assets (
 id TEXT PRIMARY KEY,
 object_key TEXT NOT NULL UNIQUE,
 original_name TEXT NOT NULL,
 mime_type TEXT NOT NULL,
 size_bytes BIGINT CHECK(size_bytes>=0),
 sha256 TEXT CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','processing','ready','failed','deleted')),
 storage_provider TEXT NOT NULL DEFAULT 'filesystem' CHECK(storage_provider IN ('filesystem','s3')),
 created_by TEXT NOT NULL REFERENCES operational_users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 duration_seconds NUMERIC CHECK(duration_seconds>=0),
 width INTEGER CHECK(width>0), height INTEGER CHECK(height>0),
 CONSTRAINT ready_media_integrity CHECK(status<>'ready' OR (sha256 IS NOT NULL AND size_bytes>0))
);
CREATE INDEX media_assets_status_created ON media_assets(status,created_at);
CREATE TABLE media_links (
 asset_id TEXT NOT NULL REFERENCES media_assets(id),
 collection TEXT NOT NULL,
 record_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,collection,record_id),
 FOREIGN KEY(collection,record_id) REFERENCES operational_records(collection,id)
);
CREATE INDEX media_links_record ON media_links(collection,record_id);
