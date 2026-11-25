-- Backstop for new ludora_dev sessions, including pg_cron and direct clients.
-- Existing sessions retain their settings until they reconnect.
ALTER DATABASE ludora_dev SET statement_timeout = '120s';
