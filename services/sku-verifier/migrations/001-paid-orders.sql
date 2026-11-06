CREATE TABLE IF NOT EXISTS paid_orders (
  order_id text PRIMARY KEY CHECK (order_id ~ '^[a-f0-9]{32}$'),
  capability_hash text NOT NULL,
  target jsonb NOT NULL,
  target_hash text NOT NULL,
  algorithm text NOT NULL DEFAULT 'sku-verification-v1',
  price_fen integer NOT NULL CHECK (price_fen BETWEEN 1 AND 5000),
  service_id text NOT NULL,
  goods_name text NOT NULL,
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  pay_before timestamptz NOT NULL,
  payment_link text,
  trade_no text UNIQUE,
  state text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment','running','finished','needs_review')),
  claim_token text,
  execution_started timestamptz,
  execution_deadline timestamptz,
  report jsonb,
  markdown text,
  report_sha256 text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'awaiting_payment' AND trade_no IS NULL AND claim_token IS NULL AND execution_deadline IS NULL)
    OR (state IN ('running','finished','needs_review') AND trade_no IS NOT NULL AND claim_token IS NOT NULL AND execution_started IS NOT NULL AND execution_deadline IS NOT NULL)),
  CHECK ((state = 'finished' AND report IS NOT NULL AND markdown IS NOT NULL AND report_sha256 IS NOT NULL)
    OR (state <> 'finished' AND report IS NULL AND markdown IS NULL AND report_sha256 IS NULL)),
  CHECK (octet_length(report::text) <= 2097152 AND octet_length(markdown) <= 2097152)
);
CREATE INDEX IF NOT EXISTS paid_orders_execution ON paid_orders (state, execution_deadline);
CREATE OR REPLACE FUNCTION enforce_paid_order_immutability() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.order_id, NEW.capability_hash, NEW.target, NEW.target_hash, NEW.algorithm, NEW.price_fen,
      NEW.service_id, NEW.goods_name, NEW.currency, NEW.pay_before, NEW.created_at)
    IS DISTINCT FROM (OLD.order_id, OLD.capability_hash, OLD.target, OLD.target_hash, OLD.algorithm, OLD.price_fen,
      OLD.service_id, OLD.goods_name, OLD.currency, OLD.pay_before, OLD.created_at)
    OR (OLD.payment_link IS NOT NULL AND NEW.payment_link IS DISTINCT FROM OLD.payment_link)
    OR (OLD.trade_no IS NOT NULL AND NEW.trade_no IS DISTINCT FROM OLD.trade_no)
    OR (OLD.claim_token IS NOT NULL AND (NEW.claim_token, NEW.execution_started, NEW.execution_deadline)
      IS DISTINCT FROM (OLD.claim_token, OLD.execution_started, OLD.execution_deadline))
    OR (OLD.state = 'finished' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.state <> 'awaiting_payment' AND NEW.state = 'awaiting_payment') THEN
    RAISE EXCEPTION 'immutable paid order';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS paid_order_immutable ON paid_orders;
CREATE TRIGGER paid_order_immutable BEFORE UPDATE ON paid_orders FOR EACH ROW EXECUTE FUNCTION enforce_paid_order_immutability();
