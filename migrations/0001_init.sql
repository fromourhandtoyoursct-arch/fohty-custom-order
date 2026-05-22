-- 0001_init.sql — initial schema for fothy storefront
-- Idempotent: uses CREATE TABLE IF NOT EXISTS so re-runs are safe.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  square_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_users_square ON users(square_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  init_nonce_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  redirect_to TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_expires ON magic_links(expires_at);

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  email TEXT,
  consent_at INTEGER,
  items_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  abandoned_email_sent_at INTEGER,
  recovered_at INTEGER,
  checked_out_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_carts_email ON carts(email);
CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_carts_recovery ON carts(updated_at, abandoned_email_sent_at, recovered_at, checked_out_at);

CREATE TABLE IF NOT EXISTS checkout_attempts (
  idempotency_key TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  cart_version INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  payment_link_id TEXT,
  payment_link_url TEXT,
  square_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_checkout_cart ON checkout_attempts(cart_id);
CREATE INDEX IF NOT EXISTS idx_checkout_status ON checkout_attempts(status);
CREATE INDEX IF NOT EXISTS idx_checkout_square_order ON checkout_attempts(square_order_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, approved);
CREATE INDEX IF NOT EXISTS idx_reviews_moderation ON reviews(approved, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  square_created_at INTEGER,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  locked_at INTEGER,
  processed_at INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_type ON webhook_events(type);
CREATE INDEX IF NOT EXISTS idx_webhooks_received ON webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_webhooks_unprocessed ON webhook_events(processed_at, locked_at);

CREATE TABLE IF NOT EXISTS suppression_list (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS subscriptions (
  square_subscription_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  square_customer_id TEXT NOT NULL,
  plan_variation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  next_billing_date TEXT,
  charged_through_date TEXT,
  card_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_customer ON subscriptions(square_customer_id);

CREATE TABLE IF NOT EXISTS gift_card_activations (
  square_order_id TEXT PRIMARY KEY,
  square_payment_id TEXT,
  buyer_user_id INTEGER REFERENCES users(id),
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  sender_name TEXT,
  gift_message TEXT,
  amount_cents INTEGER NOT NULL,
  gift_card_id TEXT,
  gan TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gc_recipient ON gift_card_activations(recipient_email);
