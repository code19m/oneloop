-- Bounded index ranges for lifetime maintenance history.
-- Broadcast lookup is already indexed by migration 0009.
CREATE INDEX notification_archived_idx ON notification_recipients(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX activity_cleanup_time_idx ON activity_events(created_at) WHERE event_type='attachment.cleaned';
-- Repair only the derived feed; immutable reorder audit events remain intact.
UPDATE activity_projection SET is_hidden=1,is_open=0
WHERE (entity_type='task' AND field_key='position') OR event_type='track.reordered';
-- Keep Unicode-normalized titles current for literal Board substring searches.
-- Separate title/key matching prevents matches spanning a synthetic separator.
ALTER TABLE tasks ADD COLUMN search_title TEXT NOT NULL DEFAULT '';
UPDATE tasks SET search_title=oneloop_lower(title);
CREATE TRIGGER task_title_normalize_insert AFTER INSERT ON tasks BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;
CREATE TRIGGER task_title_normalize_update AFTER UPDATE OF title ON tasks WHEN NEW.title <> OLD.title BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;
