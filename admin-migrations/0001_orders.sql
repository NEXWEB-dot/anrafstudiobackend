CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cod','bank')),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','shipped','delivered','cancelled')),
  created_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at DESC);
CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS order_status_history AFTER UPDATE OF status ON orders
WHEN OLD.status != NEW.status BEGIN
  INSERT INTO order_history(order_id, old_status, new_status) VALUES(NEW.id, OLD.status, NEW.status);
END;
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
