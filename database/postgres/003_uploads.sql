ALTER TABLE media_assets ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE media_assets ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE media_assets ADD COLUMN purged_at TIMESTAMPTZ;
CREATE TABLE media_uploads (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id),
 created_by TEXT NOT NULL REFERENCES operational_users(id),
 collection TEXT NOT NULL DEFAULT 'incidents' CHECK(collection='incidents'),
 record_id TEXT NOT NULL,
 total_size BIGINT NOT NULL CHECK(total_size>0 AND total_size<=268435456),
 chunk_size INTEGER NOT NULL CHECK(chunk_size>0 AND chunk_size<=5242880),
 status TEXT NOT NULL CHECK(status IN ('uploading','processing','completed','aborted','failed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 lease TEXT,lease_until TIMESTAMPTZ,
 FOREIGN KEY(collection,record_id) REFERENCES operational_records(collection,id)
);
CREATE INDEX media_uploads_pending ON media_uploads(created_by,status,expires_at);
CREATE TABLE media_upload_parts (
 upload_id TEXT NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
 part_index INTEGER NOT NULL CHECK(part_index>=0 AND part_index<52),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=5242880),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 object_key TEXT NOT NULL UNIQUE,
 PRIMARY KEY(upload_id,part_index)
);
CREATE TABLE media_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 retention_days INTEGER CHECK(retention_days BETWEEN 1 AND 3650),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO media_policy(id,retention_days) VALUES(1,NULL);
