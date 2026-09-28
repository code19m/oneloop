-- Repair classification only; preserve immutable event contents and provenance.
-- Owner-private rows with missing legacy owner metadata remain fail-closed.
UPDATE activity_events
SET visibility = 'owner',
    private_owner_user_id = CASE
        WHEN json_type(metadata_json, '$.ownerUserId') = 'text'
        THEN json_extract(metadata_json, '$.ownerUserId')
        ELSE NULL END
WHERE json_extract(metadata_json, '$.visibility') = 'owner';
