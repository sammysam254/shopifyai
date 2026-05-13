-- SQL Schema for Trending Products App
-- Paste this into the Supabase SQL Editor

-- 1. Create Trending Products Table
CREATE TABLE IF NOT EXISTS trending_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  image_url TEXT,
  source_country TEXT,
  trend_score INTEGER,
  status TEXT DEFAULT 'pending_review',
  optimized_title TEXT,
  optimized_description TEXT,
  tags TEXT[],
  shopify_url TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  owner_id TEXT DEFAULT 'system'
);

-- 1.1 Migration: Ensure columns exist (for those who already ran the old schema)
DO $$ 
BEGIN 
    -- created_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trending_products' AND column_name='created_at') THEN
        ALTER TABLE trending_products ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
    END IF;
    -- image_url
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trending_products' AND column_name='image_url') THEN
        ALTER TABLE trending_products ADD COLUMN image_url TEXT;
    END IF;
    -- source_country
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trending_products' AND column_name='source_country') THEN
        ALTER TABLE trending_products ADD COLUMN source_country TEXT;
    END IF;
    -- trend_score
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trending_products' AND column_name='trend_score') THEN
        ALTER TABLE trending_products ADD COLUMN trend_score INTEGER;
    END IF;
    -- shopify_url
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trending_products' AND column_name='shopify_url') THEN
        ALTER TABLE trending_products ADD COLUMN shopify_url TEXT;
    END IF;
END $$;

-- 2. Create Settings Table
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  accessToken TEXT,
  shop TEXT,
  config JSONB DEFAULT '{}'::jsonb,
  connectedAt TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Ensure "config" column exists (for backward compatibility if table existed)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='config') THEN
        ALTER TABLE settings ADD COLUMN config JSONB DEFAULT '{}'::jsonb;
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
-- Copy this block, replace the values, and run it in Supabase SQL Editor
/*
INSERT INTO settings (id, config)
VALUES ('secrets', '{
  "GEMINI_API_KEY": "YOUR_GEMINI_KEY",
  "SHOPIFY_CLIENT_ID": "YOUR_SHOPIFY_ID",
  "SHOPIFY_CLIENT_SECRET": "YOUR_SHOPIFY_SECRET",
  "SHOPIFY_SHOP_DOMAIN": "your-store-handle",
  "META_ADS_ACCESS_TOKEN": "YOUR_META_TOKEN",
  "META_AD_ACCOUNT_ID": "act_YOUR_ACCOUNT_ID",
  "APP_URL": "https://your-app.netlify.app"
}')
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;
*/
