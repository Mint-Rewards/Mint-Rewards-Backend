-- Client telemetry, moved off Mongo's `logs` collection.
--
-- In its own schema, not `public`: the admin API owns that one and already has
-- `captains` and `collections` tables, while this codebase has models of the
-- same names that may or may not be the same things. One database still means
-- a view can span both.
--
-- `level` is a CHECK rather than an enum: Mongo stored a free string with an
-- application-level enum, so a database enum would reject rows the old store
-- accepted. A CHECK can be relaxed without a type rewrite.
--
-- NOTE ON RETENTION. The Mongoose schema declares a 90-day TTL index, but it
-- has never existed in any database: `timestamp` already carries `index: true`
-- on the field, so the second declaration of the same key with
-- `expireAfterSeconds` conflicts and Mongo declines it. Production holds logs
-- six months old as a result. Postgres has no TTL, so retention is a scheduled
-- delete -- see lib/db/optional/logs_retention.sql, which sits outside this
-- directory so the runner never applies it. Turning it on deletes data that
-- Mongo has in fact been keeping, and that is a decision, not a migration.
CREATE SCHEMA IF NOT EXISTS consumer;

CREATE TABLE IF NOT EXISTS consumer.logs (
  id             bigserial PRIMARY KEY,
  event          text NOT NULL,
  level          text NOT NULL DEFAULT 'info',
  user_id        text,
  user_email     text,
  route          text,
  previous_route text,
  device_id      text NOT NULL,
  device_model   text NOT NULL DEFAULT 'unknown',
  platform       text NOT NULL,
  app_version    text NOT NULL,
  build_number   text NOT NULL,
  -- The client's clock: what the dashboard sorts by, trusted no further.
  timestamp      timestamptz NOT NULL,
  -- The server's clock: what retention measures against.
  received_at    timestamptz NOT NULL DEFAULT now(),
  extra          jsonb,
  CONSTRAINT logs_level_check CHECK (level IN ('info', 'warn', 'error'))
);

-- The dashboard's actual queries: one subject, most recent first.
CREATE INDEX IF NOT EXISTS logs_user_id_timestamp_idx   ON consumer.logs (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS logs_event_timestamp_idx     ON consumer.logs (event, timestamp DESC);
CREATE INDEX IF NOT EXISTS logs_device_id_timestamp_idx ON consumer.logs (device_id, timestamp DESC);

-- Filter-only columns, narrowed on before sorting.
CREATE INDEX IF NOT EXISTS logs_route_idx ON consumer.logs (route);
CREATE INDEX IF NOT EXISTS logs_level_idx ON consumer.logs (level);

-- Retention sweeps by arrival, not by the client's clock.
CREATE INDEX IF NOT EXISTS logs_received_at_idx ON consumer.logs (received_at);
