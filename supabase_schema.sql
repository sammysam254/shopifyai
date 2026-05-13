-- 1. Create Trending Products Table
CREATE TABLE trending_products (
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
  createdAt TIMESTAMPTZ DEFAULT now(),
  ownerId TEXT DEFAULT 'system'
);

-- 2. Create Settings Table (for Shopify OAuth)
CREATE TABLE settings (
  id TEXT PRIMARY KEY, -- 'shopify'
  accessToken TEXT,
  shop TEXT,
  config JSONB DEFAULT '{}'::jsonb,
  connectedAt TIMESTAMPTZ DEFAULT now()
);

-- 3. Enable RLS (Optional - for simple use you can keep it disabled or add basic policies)
-- ALTER TABLE trending_products ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Simple policy: Allow all access for now (Harden this later if needed)
-- CREATE POLICY "public_access" ON trending_products FOR ALL USING (true);
-- CREATE POLICY "public_access" ON settings FOR ALL USING (true);
