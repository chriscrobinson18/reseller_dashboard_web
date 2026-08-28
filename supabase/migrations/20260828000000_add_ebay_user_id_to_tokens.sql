-- Store eBay's userId so account deletion notifications can be mapped to our users
ALTER TABLE public.ebay_tokens ADD COLUMN IF NOT EXISTS ebay_user_id text;
CREATE INDEX IF NOT EXISTS ebay_tokens_ebay_user_id_idx ON public.ebay_tokens(ebay_user_id);
