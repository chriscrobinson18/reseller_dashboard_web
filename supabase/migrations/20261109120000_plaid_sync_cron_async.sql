-- Daily Plaid cron: call plaid_sync_scheduled asynchronously via pg_net.
--
-- The job used to call the function with the synchronous `extensions.http`,
-- which gives up after 5 s. A full sync of every item takes much longer, so
-- every run since 2026-04-01 was recorded as "failed" in cron.job_run_details
-- even though the function kept running and synced fine. That made real
-- failures invisible. pg_net's net.http_post queues the request and returns
-- at once; the function's own logs / plaid_items.status are the health signal.
--
-- Same schedule (08:00 UTC daily), same URL, same empty body. verify_jwt is
-- off for plaid_sync_scheduled, so no Authorization header (unchanged).
select cron.unschedule(jobid) from cron.job
where command like '%/functions/v1/plaid_sync_scheduled%';

select cron.schedule(
  'plaid-sync-scheduled-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/plaid_sync_scheduled',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
