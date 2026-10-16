-- An MCP upload ticket can name a file of the same task that the upload
-- replaces. The upload checks that file again when its bytes arrive, so the
-- ticket keeps only the ID, without a reference that deletes the ticket.
ALTER TABLE mcp_file_transfers ADD COLUMN replaces_attachment_id TEXT;
