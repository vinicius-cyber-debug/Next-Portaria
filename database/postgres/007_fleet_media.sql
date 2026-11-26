-- Keep existing incident evidence and foreign keys; fleet inspections have two albums.
ALTER TABLE media_uploads DROP CONSTRAINT media_uploads_collection_check;
ALTER TABLE media_uploads ADD CONSTRAINT media_uploads_collection_check CHECK(collection IN ('incidents','fleetTrips'));
ALTER TABLE media_uploads ADD COLUMN phase TEXT NOT NULL DEFAULT 'incident';
ALTER TABLE media_uploads ADD CONSTRAINT media_uploads_phase_check CHECK((collection='incidents' AND phase='incident') OR (collection='fleetTrips' AND phase IN ('departure','return')));
ALTER TABLE media_links ADD COLUMN phase TEXT NOT NULL DEFAULT 'incident';
ALTER TABLE media_links ADD CONSTRAINT media_links_fleet_phase_check CHECK((collection='fleetTrips' AND phase IN ('departure','return')) OR (collection<>'fleetTrips' AND phase='incident'));
CREATE INDEX media_links_phase_record ON media_links(collection,record_id,phase);
