-- SQL Schema for Trending Products App
-- Paste this into the Supabase SQL Editor

-- 1. Create Trending Products Table
CREATE TABLE IF NOT EXISTS trending_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  imageUrl TEXT,
  sourceCountry TEXT,
  trendScore INTEGER,
  status TEXT DEFAULT 'pending_review',
  optimizedTitle TEXT,
  optimizedDescription TEXT,
  tags TEXT[],
  shopifyUrl TEXT,
  syncedAt TIMESTAMPTZ,
  createdAt TIMESTAMPTZ DEFAULT NOW(),
  ownerId TEXT DEFAULT 'system'
);

-- 2. Create Settings Table
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  accessToken TEXT,
  shop TEXT,
  connectedAt TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ADD CONFIG COLUMN IF MISSING (Fixes "column config does not exist" error)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='config') THEN
        ALTER TABLE settings ADD COLUMN config JSONB;
    END IF;
END $$;

-- 4. Enable RLS
ALTER TABLE trending_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 5. Create Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public Read Trending Products') THEN
        CREATE POLICY "Public Read Trending Products" ON trending_products FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public Read Settings') THEN
        CREATE POLICY "Public Read Settings" ON settings FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service Role Full Access') THEN
        CREATE POLICY "Service Role Full Access" ON trending_products FOR ALL USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service Role Full Access Settings') THEN
        CREATE POLICY "Service Role Full Access Settings" ON settings FOR ALL USING (true);
    END IF;
END $$;

-- 6. Insert Your Secrets (Template)
-- IMPORTANT: GitHub might block your push if you commit real keys. 
-- Replace placeholder values in your Supabase SQL editor directly.
/*
INSERT INTO settings (id, config)
VALUES ('secrets', '{
  "GEMINI_API_KEY": "YOUR_KEY",
  "SHOPIFY_CLIENT_ID": "YOUR_ID",
  "SHOPIFY_CLIENT_SECRET": "YOUR_SECRET",
  "SHOPIFY_SHOP_DOMAIN": "your-store-handle",
  "APP_URL": "https://your-app.netlify.app"
}')
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;
*/
