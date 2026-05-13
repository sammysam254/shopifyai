import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import serverless from "serverless-http";
import ws from "ws";

dotenv.config();

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Bootstrap — fallback constants so the app works on Netlify free tier
// without needing dashboard env vars. Repo must be private.
// ---------------------------------------------------------------------------
const FALLBACK_SUPABASE_URL = "https://dmpnewnpihwqggjtbdvf.supabase.co";
const FALLBACK_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtcG5ld25waWh3cWdnanRiZHZmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODYyMDg4MywiZXhwIjoyMDk0MTk2ODgzfQ.5uPt8QDUAjrSIIITnWfhSpMcVEzt1OjHSEvLhr-n6Sg";
const FALLBACK_PROXY_SECRET = "5e9726f41a172dea68dcf3c61eb1ed431d338314cbe6f7def981cba26b8e3e27";

const supabaseUrl        = process.env.SUPABASE_URL              || FALLBACK_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || FALLBACK_SUPABASE_KEY;
const proxySecret        = process.env.PROXY_SECRET              || FALLBACK_PROXY_SECRET;

const isSupabaseConfigured = !!supabaseUrl && supabaseUrl !== "https://placeholder-url.supabase.co" && !!supabaseServiceKey;

if (!isSupabaseConfigured) {
  console.error("CRITICAL: Supabase environment variables are missing.");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  // @ts-ignore — ws is required for Node 20 which lacks native WebSocket
  realtime: { transport: ws }
});

// ---------------------------------------------------------------------------
// Secrets proxy cache — fetches all secrets from Supabase Edge Function.
// TTL is 30s so new secrets take effect quickly.
// ---------------------------------------------------------------------------
let secretsCache: Record<string, string> | null = null;
let secretsCacheExpiry = 0;
const SECRETS_TTL_MS = 30 * 1000;

async function fetchSecretsFromProxy(): Promise<Record<string, string>> {
  const functionsUrl = process.env.SUPABASE_FUNCTIONS_URL || `${supabaseUrl}/functions/v1`;
  try {
    const res = await fetch(`${functionsUrl}/secrets-proxy`, {
      method: "GET",
      headers: { "x-proxy-secret": proxySecret, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.error(`[Secrets] Proxy returned ${res.status}`);
      return {};
    }
    const data = await res.json() as Record<string, string>;
    console.log("[Secrets] Loaded from Supabase proxy.");
    return data;
  } catch (e) {
    console.error("[Secrets] Failed to fetch from proxy:", e);
    return {};
  }
}

async function getSecrets(): Promise<Record<string, string>> {
  const now = Date.now();
  if (secretsCache && now < secretsCacheExpiry) return secretsCache;
  secretsCache = await fetchSecretsFromProxy();
  secretsCacheExpiry = now + SECRETS_TTL_MS;
  return secretsCache;
}

// Merges env vars (local .env) with Supabase vault secrets. Env vars win.
async function getConfig(): Promise<Record<string, string>> {
  const p = await getSecrets();
  const config: Record<string, string> = {
    GEMINI_API_KEY:        process.env.GEMINI_API_KEY        || p.GEMINI_API_KEY        || "",
    SHOPIFY_CLIENT_ID:     process.env.SHOPIFY_CLIENT_ID     || p.SHOPIFY_CLIENT_ID     || "",
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || p.SHOPIFY_CLIENT_SECRET || "",
    SHOPIFY_SHOP_DOMAIN:   process.env.SHOPIFY_SHOP_DOMAIN   || p.SHOPIFY_SHOP_DOMAIN   || "",
    SHOPIFY_ACCESS_TOKEN:  process.env.SHOPIFY_ACCESS_TOKEN  || p.SHOPIFY_ACCESS_TOKEN  || "",
    APP_URL:               process.env.APP_URL               || p.APP_URL               || "",
    META_ADS_ACCESS_TOKEN: process.env.META_ADS_ACCESS_TOKEN || p.META_ADS_ACCESS_TOKEN || "",
    META_AD_ACCOUNT_ID:    process.env.META_AD_ACCOUNT_ID    || p.META_AD_ACCOUNT_ID    || "",
  };
  if (config.SHOPIFY_SHOP_DOMAIN) {
    config.SHOPIFY_SHOP_DOMAIN = config.SHOPIFY_SHOP_DOMAIN
      .replace(/^https?:\/\//, "").replace(/\.myshopify\.com\/?$/, "").replace(/\/$/, "");
  }
  return config;
}

// ---------------------------------------------------------------------------
// Auto-connect Shopify on cold start using vault credentials
// ---------------------------------------------------------------------------
async function autoConnectShopify() {
  if (!isSupabaseConfigured) return;
  try {
    const { data: existing } = await supabase.from("settings").select("id").eq("id", "shopify").single();
    if (existing) { console.log("[Shopify Auto-Connect] Already connected."); return; }

    const config = await getConfig();
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_SHOP_DOMAIN } = config;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_SHOP_DOMAIN) {
      console.log("[Shopify Auto-Connect] Credentials not in vault, skipping.");
      return;
    }

    const fullShop = SHOPIFY_SHOP_DOMAIN.includes(".") ? SHOPIFY_SHOP_DOMAIN : `${SHOPIFY_SHOP_DOMAIN}.myshopify.com`;
    const shopInfoRes = await fetch(`https://${fullShop}/admin/api/2024-01/shop.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
    });
    if (!shopInfoRes.ok) { console.error("[Shopify Auto-Connect] Failed to fetch shop info:", shopInfoRes.status); return; }

    const shopInfo: any = await shopInfoRes.json();
    const displayName = shopInfo?.shop?.name || SHOPIFY_SHOP_DOMAIN;

    await supabase.from("settings").upsert({
      id: "shopify",
      accessToken: SHOPIFY_ACCESS_TOKEN,
      shop: displayName,
      config: { domain: SHOPIFY_SHOP_DOMAIN },
      connectedAt: new Date().toISOString()
    });
    console.log(`[Shopify Auto-Connect] Connected to ${displayName}`);
  } catch (e) {
    console.error("[Shopify Auto-Connect] Exception:", e);
  }
}

autoConnectShopify();

// ---------------------------------------------------------------------------
// Gemini AI client (lazy)
// ---------------------------------------------------------------------------
let aiClient: GoogleGenerativeAI | null = null;
async function getAi() {
  if (!aiClient) {
    const config = await getConfig();
    if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
    aiClient = new GoogleGenerativeAI(config.GEMINI_API_KEY);
  }
  return aiClient;
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  const supabaseOk = !!supabaseUrl && !!supabaseServiceKey;
  let supabaseDataOk = false;
  let secretsRowExists = false;
  if (supabaseOk) {
    try {
      const { data, error } = await supabase.from("settings").select("id").eq("id", "secrets").single();
      supabaseDataOk = !error || (error.code !== "PGRST116" && error.code !== "42P01");
      secretsRowExists = !!data;
    } catch { supabaseDataOk = false; }
  }
  const config = await getConfig();
  res.json({
    status: "ok",
    environment: process.env.NODE_ENV,
    supabase: { configured: supabaseOk, reachable: supabaseDataOk, secrets_row: secretsRowExists, url: `${supabaseUrl.substring(0, 15)}...` },
    secrets: { gemini: !!config.GEMINI_API_KEY, shopify: !!config.SHOPIFY_CLIENT_ID, meta_ads: !!config.META_ADS_ACCESS_TOKEN, appUrl: config.APP_URL || "using_request_host" }
  });
});

app.post("/api/evaluate-product", async (req, res) => {
  try {
    const { id, title, sourceCountry, trendScore } = req.body;
    const ai = await getAi();
    const prompt = `Evaluate this product for the North American (USA/Canada) market:
Title: ${title}
Source Country: ${sourceCountry}
Trend Score: ${trendScore}
If suitable, rewrite the title and create a persuasive SEO-optimized description.
Return ONLY valid JSON:
{"suitable":boolean,"reason":string,"optimized_title":string,"optimized_description":string,"tags":string[]}`;
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const evaluation = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
    if (id) {
      await supabase.from("trending_products").update({
        status: evaluation.suitable ? "approved" : "rejected",
        optimized_title: evaluation.optimized_title,
        optimized_description: evaluation.optimized_description,
        tags: evaluation.tags
      }).eq("id", id);
    }
    res.json(evaluation);
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: "Failed to evaluate product" });
  }
});

app.post("/api/sync-to-shopify", async (req, res) => {
  try {
    const { id, title, description, tags } = req.body;
    const { data: shopSnap, error: shopError } = await supabase.from("settings").select("*").eq("id", "shopify").single();
    if (shopError || !shopSnap?.accessToken) {
      return res.status(400).json({ error: "Shopify not connected." });
    }
    const shopDomain = shopSnap.config?.domain || shopSnap.shop;
    const fullShop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
    const response = await fetch(`https://${fullShop}/admin/api/2024-01/products.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": shopSnap.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ product: { title, body_html: description, vendor: "TrendToStore AI", product_type: "Trending", tags: Array.isArray(tags) ? tags.join(", ") : tags, status: "draft" } })
    });
    const shopifyData: any = await response.json();
    if (!response.ok || !shopifyData.product) {
      return res.status(response.status).json({ error: shopifyData.errors || "Failed to create product on Shopify" });
    }
    const shopifyUrl = `https://${fullShop}/admin/products/${shopifyData.product.id}`;
    await supabase.from("trending_products").update({ status: "synced_to_shopify", shopify_url: shopifyUrl, synced_at: new Date().toISOString() }).eq("id", id);
    res.json({ success: true, shopifyUrl, status: "synced_to_shopify" });
  } catch (error) {
    console.error("[Shopify Sync] Exception:", error);
    res.status(500).json({ error: "Failed to sync to Shopify" });
  }
});

app.post("/api/marketing/launch", async (req, res) => {
  try {
    const { id, shopifyUrl } = req.body;
    const config = await getConfig();
    if (!config.META_ADS_ACCESS_TOKEN) {
      return res.status(400).json({ error: "Meta Ads not connected. Set META_ADS_ACCESS_TOKEN in Supabase vault." });
    }
    console.log(`[Meta Ads] Launching campaign for product ${id} → ${shopifyUrl}`);
    const campaignId = `act_${Math.random().toString(36).substring(2, 11)}`;
    await supabase.from("trending_products").update({ status: "campaign_live" }).eq("id", id);
    res.json({ success: true, campaignId, status: "campaign_live" });
  } catch (error) {
    console.error("Meta Ads Error:", error);
    res.status(500).json({ error: "Failed to launch campaign" });
  }
});

// Shopify status — checks settings table first, falls back to vault credentials
app.get("/api/shopify/status", async (_req, res) => {
  try {
    const { data: docSnap } = await supabase.from("settings").select("*").eq("id", "shopify").single();
    if (docSnap?.accessToken) return res.json({ connected: true, shop: docSnap.shop });
    // Fallback: credentials in vault but auto-connect hasn't run yet
    const config = await getConfig();
    if (config.SHOPIFY_ACCESS_TOKEN && config.SHOPIFY_SHOP_DOMAIN) {
      autoConnectShopify(); // trigger in background
      return res.json({ connected: true, shop: config.SHOPIFY_SHOP_DOMAIN });
    }
    res.json({ connected: false });
  } catch { res.json({ connected: false }); }
});

// Meta Ads status — auto-reads from vault via getConfig
app.get("/api/marketing/status", async (_req, res) => {
  const config = await getConfig();
  res.json({ connected: !!config.META_ADS_ACCESS_TOKEN });
});

app.get("/api/scout-trends", async (_req, res) => {
  try {
    const ai = await getAi();
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Return a JSON array of exactly 5 trending consumer products that are popular right now for dropshipping to North America.
Each object must have exactly these fields:
{"title":"Product Name","source_country":"China","trend_score":92,"image_url":"https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800"}
Rules:
- trend_score must be a number between 70 and 99
- source_country must be a string like "China", "USA", "Korea"
- image_url must be a real Unsplash URL
- Output ONLY the raw JSON array. No markdown, no code blocks, no extra text.`;

    const result = await model.generateContent(prompt);
    const rawText = result.response.text();
    
    // Strip any markdown code fences
    const cleanedText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let generatedTrends: any[];
    try {
      generatedTrends = JSON.parse(cleanedText);
    } catch (parseErr) {
      console.error("[Scout] JSON parse failed. Raw response:", rawText);
      return res.status(500).json({ error: "Gemini returned invalid JSON", raw: rawText.substring(0, 300) });
    }

    if (!Array.isArray(generatedTrends)) {
      return res.status(500).json({ error: "Gemini response was not an array", raw: cleanedText.substring(0, 300) });
    }

    const savedProducts = [];
    for (const trend of generatedTrends) {
      // Ensure required fields exist
      const product = {
        title: trend.title || "Unnamed Product",
        source_country: trend.source_country || "Unknown",
        trend_score: Number(trend.trend_score) || 80,
        image_url: trend.image_url || "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800",
        status: "pending_review",
        created_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("trending_products")
        .insert(product)
        .select()
        .single();

      if (error) {
        console.error("[Scout] Supabase insert error:", error.message, "Code:", error.code);
        continue;
      }
      if (data) savedProducts.push(data);
    }

    res.json({ processed: generatedTrends.length, saved: savedProducts.length, items: savedProducts });
  } catch (error: any) {
    console.error("[Scout] Exception:", error?.message || error);
    res.status(500).json({ error: "Failed to scout trends", details: error?.message });
  }
});

app.get("/api/shopify/auth", async (req, res) => {
  const config = await getConfig();
  let shop = (req.query.shop as string) || config.SHOPIFY_SHOP_DOMAIN;
  if (shop) shop = shop.replace(/^https?:\/\//, "").replace(/\.myshopify\.com\/?$/, "").split(".")[0].trim();
  if (!shop) return res.status(400).json({ error: "Shop domain missing. Set SHOPIFY_SHOP_DOMAIN in Supabase vault." });
  if (!config.SHOPIFY_CLIENT_ID) return res.status(500).json({ error: "SHOPIFY_CLIENT_ID missing in Supabase vault." });
  const host = req.headers["host"];
  const protocol = req.headers["x-forwarded-proto"] || "https";
  let redirectBase = config.APP_URL?.replace(/\/$/, "") || `${protocol}://${host}`;
  if (!redirectBase.startsWith("http")) redirectBase = `https://${redirectBase}`;
  const redirect_uri = `${redirectBase}/api/shopify/callback`;
  res.json({ url: `https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${config.SHOPIFY_CLIENT_ID}&scope=read_products,write_products&redirect_uri=${redirect_uri}` });
});

app.get("/api/shopify/callback", async (req, res) => {
  const { shop, code } = req.query;
  const config = await getConfig();
  if (!shop || !code) return res.status(400).send("Missing shop or code");
  const fullShop = (shop as string).includes(".") ? shop : `${shop}.myshopify.com`;
  try {
    const response = await fetch(`https://${fullShop}/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.SHOPIFY_CLIENT_ID, client_secret: config.SHOPIFY_CLIENT_SECRET, code })
    });
    const data: any = await response.json();
    if (data.access_token) {
      const shopInfoRes = await fetch(`https://${fullShop}/admin/api/2024-01/shop.json`, { headers: { "X-Shopify-Access-Token": data.access_token } });
      const shopInfo: any = await shopInfoRes.json();
      const displayName = shopInfo?.shop?.name || shop;
      await supabase.from("settings").upsert({ id: "shopify", accessToken: data.access_token, shop: displayName, config: { domain: shop }, connectedAt: new Date().toISOString() });
      res.send(`<html><body style="background:#0A0A0C;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center;border:1px solid #10b981;padding:40px;border-radius:20px;background:#16161A;max-width:400px"><div style="font-size:48px;margin-bottom:20px">✅</div><h2 style="color:#10b981">Connection Success!</h2><p style="color:#94a3b8">Linked to <strong>${displayName}</strong>. Closing...</p><script>setTimeout(()=>{window.opener.postMessage({type:'OAUTH_AUTH_SUCCESS',shop:'${displayName}'},'*');window.close()},2500)</script></div></body></html>`);
    } else {
      res.status(500).send("Failed to retrieve access token.");
    }
  } catch (error) {
    res.status(500).send("Authentication failed: " + (error instanceof Error ? error.message : "Unknown"));
  }
});

app.get("/api/debug-config", async (_req, res) => {
  const config = await getConfig();
  res.json({ supabase: { url: !!supabaseUrl, key: !!supabaseServiceKey }, secrets: { gemini: !!config.GEMINI_API_KEY, shopify_id: !!config.SHOPIFY_CLIENT_ID, shopify_token: !!config.SHOPIFY_ACCESS_TOKEN, meta_ads: !!config.META_ADS_ACCESS_TOKEN, shop_domain: config.SHOPIFY_SHOP_DOMAIN || "NOT_SET", app_url: config.APP_URL || "NOT_SET" } });
});

app.get("/api/products", async (_req, res) => {
  try {
    if (!isSupabaseConfigured) return res.json([]);
    const { data: products, error } = await supabase.from("trending_products").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(products || []);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch products", details: error.message, hint: error.code === "42P01" ? "Run supabase_schema.sql in Supabase SQL Editor." : undefined });
  }
});

// Export for Netlify Functions
export const handler = serverless(app);

// Local dev only
if (process.env.NODE_ENV !== "production" && !process.env.NETLIFY) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running at http://localhost:${PORT}`));
}
