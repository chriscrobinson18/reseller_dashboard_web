-- Remove the obsolete eBay API daily sync job.
-- eBay moved from the API back to CSV upload; the job had failed every day
-- since 2026-09-03 ("relation ebay_tokens does not exist") and only added
-- noise to cron.job_run_details. It called the sync_ebay_transactions edge
-- function via net.http_post at 04:00 UTC.
select cron.unschedule(jobid) from cron.job where jobname = 'sync-ebay-daily';
