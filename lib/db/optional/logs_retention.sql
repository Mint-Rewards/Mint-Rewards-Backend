-- Retention for consumer.logs. NOT applied by the migration runner, on purpose.
--
-- The Mongoose schema declares a 90-day TTL index on `logs`, but it has never
-- existed in any database: `timestamp` already carries `index: true` on the
-- field, so the second declaration of the same key with `expireAfterSeconds`
-- conflicts and Mongo declines to build it. Production holds logs six months
-- old as a result, and every deployment has been keeping telemetry forever
-- without anyone choosing to.
--
-- So switching this on is not "restoring intended behaviour" — it deletes data
-- the system has in fact been retaining. That is a decision about how far back
-- support and incident investigation can look, and it belongs to a person, not
-- to a migration that runs on deploy.
--
-- Measured against received_at, the server's own clock, rather than timestamp,
-- which is the client's and can be skewed or forged.
--
-- To enable, in the Supabase SQL editor:
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule(
--     'consumer-logs-retention', '17 3 * * *',
--     $$SELECT consumer.purge_old_logs(90)$$
--   );
--
-- To stop it:  SELECT cron.unschedule('consumer-logs-retention');

CREATE OR REPLACE FUNCTION consumer.purge_old_logs(keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  removed integer;
BEGIN
  IF keep_days < 1 THEN
    RAISE EXCEPTION 'keep_days must be at least 1, got %', keep_days;
  END IF;

  DELETE FROM consumer.logs
  WHERE received_at < now() - make_interval(days => keep_days);

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMENT ON FUNCTION consumer.purge_old_logs(integer) IS
  'Deletes telemetry older than keep_days, measured by arrival. Returns the row count. Not scheduled by default.';
