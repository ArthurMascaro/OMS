CREATE OR REPLACE FUNCTION reject_stock_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock_event is immutable; % is not allowed', TG_OP
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$$;

CREATE TRIGGER stock_event_immutable
BEFORE UPDATE OR DELETE ON stock_event
FOR EACH ROW
EXECUTE FUNCTION reject_stock_event_mutation();
