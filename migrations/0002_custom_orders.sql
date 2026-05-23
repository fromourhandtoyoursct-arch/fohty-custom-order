-- Custom order submissions captured from /custom-order/submit.
-- Linked to a user_id when the submitting email matches a known account; otherwise email-only.
CREATE TABLE IF NOT EXISTS custom_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting-review',
  brief_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS custom_orders_user_idx ON custom_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS custom_orders_email_idx ON custom_orders(email, created_at DESC);
