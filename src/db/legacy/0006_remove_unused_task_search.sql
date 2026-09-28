-- Board search uses Unicode-aware substring queries, not this FTS table.
-- Its task_id column was UNINDEXED, so each task edit scanned the full FTS
-- content table in tasks_search_update. Remove only this unused derived data.
DROP TRIGGER tasks_search_insert;
DROP TRIGGER tasks_search_update;
DROP TRIGGER tasks_search_delete;
DROP TABLE task_search;
