CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_state (id, version, payload, updated_at)
VALUES (
  1,
  1,
  '{"version":1,"lastScheduledAt":null,"lastCleanupDay":null,"updatedAt":null,"monitors":{}}',
  0
);

CREATE TABLE history_5m (
  monitor_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  checks INTEGER NOT NULL CHECK(checks >= 0),
  successes INTEGER NOT NULL CHECK(successes >= 0),
  failures INTEGER NOT NULL CHECK(failures >= 0),
  latency_sum INTEGER NOT NULL CHECK(latency_sum >= 0),
  latency_min INTEGER,
  latency_max INTEGER,
  CHECK(checks = successes + failures),
  PRIMARY KEY (monitor_id, bucket_start)
) WITHOUT ROWID;

CREATE TABLE history_1h (
  monitor_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  checks INTEGER NOT NULL CHECK(checks >= 0),
  successes INTEGER NOT NULL CHECK(successes >= 0),
  failures INTEGER NOT NULL CHECK(failures >= 0),
  latency_sum INTEGER NOT NULL CHECK(latency_sum >= 0),
  latency_min INTEGER,
  latency_max INTEGER,
  CHECK(checks = successes + failures),
  PRIMARY KEY (monitor_id, hour_start)
) WITHOUT ROWID;

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  monitor_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_reason TEXT CHECK(ended_reason IN ('recovered', 'disabled', 'deleted')),
  first_error TEXT,
  last_error TEXT,
  first_status_code INTEGER,
  last_status_code INTEGER,
  CHECK((ended_at IS NULL AND ended_reason IS NULL)
     OR (ended_at IS NOT NULL AND ended_reason IS NOT NULL))
);

CREATE UNIQUE INDEX incidents_one_open_per_monitor
  ON incidents(monitor_id) WHERE ended_at IS NULL;
CREATE INDEX incidents_recent ON incidents(started_at DESC);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  failed_at INTEGER,
  CHECK(sent_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX notification_outbox_due
  ON notification_outbox(next_attempt_at, created_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

CREATE TABLE scheduler_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

INSERT INTO scheduler_lock (id, token, lease_until) VALUES (1, NULL, 0);
