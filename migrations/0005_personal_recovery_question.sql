ALTER TABLE players ADD COLUMN recovery_question TEXT;
ALTER TABLE players ADD COLUMN recovery_answer_hash TEXT;
ALTER TABLE players ADD COLUMN recovery_answer_salt TEXT;
ALTER TABLE players ADD COLUMN recovery_answer_iterations INTEGER;

UPDATE schema_meta SET value='5', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key='schema_version';
