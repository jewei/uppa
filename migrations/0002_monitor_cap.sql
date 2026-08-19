CREATE TRIGGER monitors_limit_insert
BEFORE INSERT ON monitors
WHEN NEW.deleted_at IS NULL
 AND (SELECT COUNT(*) FROM monitors WHERE deleted_at IS NULL) >= 40
BEGIN
  SELECT RAISE(ABORT, 'monitor_limit');
END;

CREATE TRIGGER monitors_limit_restore
BEFORE UPDATE OF deleted_at ON monitors
WHEN OLD.deleted_at IS NOT NULL
 AND NEW.deleted_at IS NULL
 AND (SELECT COUNT(*) FROM monitors WHERE deleted_at IS NULL) >= 40
BEGIN
  SELECT RAISE(ABORT, 'monitor_limit');
END;
