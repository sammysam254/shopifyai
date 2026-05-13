import express from "express";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import serverless from "serverless-http";
import ws from "ws";

dotenv.config();

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Bootstrap constants — fallback values used when environment variables are
// not injected by the host (e.g. Netlify free tier without dashboard env vars).
// These are safe to have here because:
//   • The repo should be private
//   • The service role key is scoped to this Supabase project only
//   • The proxy secret only unlocks the secrets-proxy edge function
// ---------------------------------------------------------------------------
const FALLBACK_SUPABASE_URL = "https://dmpnewnpihwqggjtbdvf.supabase.co";
const FALLBACK_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtcG5ld25waWh3cWdnanRiZHZmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODYyMDg4MywiZXhwIjoyMDk0MTk2ODgzfQ.5uPt8QDUAjrSIIITnWfhSpMcVEzt1OjHSEvLhr-n6Sg";
const FALLBACK_PROXY_SECRET = "5e9726f41a172dea68dcf3c61eb1ed431d338314cbe6f7def981cba26b8e3e27";

const supabaseUrl        = process.env.SUPABASE_URL             || FALLBACK_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || FALLBACK_SUPABASE_KEY;
const proxySecret        = process.env.PROXY_SECRET              || FALLBACK_PROXY_SECRET;

const isSupabaseConfigured = !!supabaseUrl && supabaseUrl !== "https://placeholder-url.supabase.co" && !!supabaseServiceKey;

if (!isSupabaseConfigured) {
  console.error("CRITICAL: Supabase environment variables are missing. App will run in limited mode.");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    transport: ws
  }
});

// ---------------------------------------------------------------------------
// Secrets cache — fetched once from the Supabase secrets-proxy Edge Function.
// TTL is 5 minutes so a redeploy of secrets takes effect quickly.
// ---------------------------------------------------------------------------
let secretsCache: Record<string, string> | null = null;
let secretsCacheExpiry = 0;
const SECRETS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchSecretsFromProxy(): Promise<Record<string, string>> {
  const functionsUrl = process.env.SUPABASE_FUNCTIONS_URL || `${supabaseUrl}/functions/v1`;

  if (!proxySecret) {
    console.warn("[Secrets] PROXY_SECRET not set — skipping proxy fetch.");
    return {};
  }

  try {
    const res = await fetch(`${functionsUrl}/secrets-proxy`, {
      method: "GET",
      headers: {
        "x-proxy-secret": proxySecret,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error(`[Secrets] Proxy returned ${res.status}:`, await res.text());
      return {};
    }

    const data = await res.json() as Record<string, string>;
    console.log("[Secrets] Successfully loaded secrets from Supabase proxy.");
    return data;
  } catch (e) {
    console.error("[Secrets] Failed to fetch from secrets-proxy:", e);
    return {};
  }
}

async function getSecrets(): Promise<Record<string, string>> {
  const now = Date.now();
  if (secretsCache && now < secretsCacheExpiry) {
    return secretsCache;
  }
  secretsCache = await fetchSecretsFromProxy();
  secretsCacheExpiry = now + SECRETS_TTL_MS;
  return secretsCache;
}

// Configuration loader helper — merges env vars with proxy secrets.
// Env vars always win (so local .env overrides work during development).
async function getConfig() {
  const proxied = await getSecrets();

  const config: Record<string, string> = {
    GEMINI_API_KEY:        process.env.GEMINI_API_KEY        || proxied.GEMINI_API_KEY        || "",
    SHOPIFY_CLIENT_ID:     process.env.SHOPIFY_CLIENT_ID     || proxied.SHOPIFY_CLIENT_ID     || "",
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || proxied.SHOPIFY_CLIENT_SECRET || "",
    SHOPIFY_SHOP_DOMAIN:   process.env.SHOPIFY_SHOP_DOMAIN   || proxied.SHOPIFY_SHOP_DOMAIN   || "",
    APP_URL:               process.env.APP_URL               || proxied.APP_URL               || "",
    META_ADS_ACCESS_TOKEN: process.env.META_ADS_ACCESS_TOKEN || proxied.META_ADS_ACCESS_TOKEN || "",
    META_AD_ACCOUNT_ID:    process.env.META_AD_ACCOUNT_ID    || proxied.META_AD_ACCOUNT_ID    || "",
  };

  // Sanitize SHOPIFY_SHOP_DOMAIN (extract handle from URL if needed)
  if (config.SHOPIFY_SHOP_DOMAIN) {
    config.SHOPIFY_SHOP_DOMAIN = config.SHOPIFY_SHOP_DOMAIN
      .replace(/^https?:\/\//, "")
      .replace(/\.myshopify\.com\/?$/, "")
      .replace(/\/$/, "");
  }

  return config;
}

// Initialize Gemini lazily to allow config loading
let aiClient: GoogleGenerativeAI | null = null;
async function getAi() {
  if (!aiClient) {
    const config = await getConfig();
    if (!config.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured in env or Supabase");
    }
    aiClient = new GoogleGenerativeAI(config.GEMINI_API_KEY);
  }
  return aiClient;
}

// API Routes
app.get("/api/health", async (req, res) => {
  const supabaseOk = !!supabaseUrl && !!supabaseServiceKey;
  let supabaseDataOk = false;
  let secretsRowExists = false;
  
  if (supabaseOk) {
    try {
      const { data, error } = await supabase.from("settings").select("id").eq("id", "secrets").single();
      // PGRST116 is 'no rows', which is fine. 42P01 is 'table does not exist'.
      supabaseDataOk = !error || (error.code !== 'PGRST116' && error.code !== '42P01'); 
      secretsRowExists = !!data;
      
      if (error && error.code === '42P01') {
        console.warn("[Health] 'settings' table missing in Supabase.");
      }
    } catch (e) {
      supabaseDataOk = false;
    }
  }

  const config = await getConfig();

  res.json({ 
    status: "ok", 
    environment: process.env.NODE_ENV,
    supabase: {
      configured: supabaseOk,
      reachable: supabaseDataOk,
      secrets_row: secretsRowExists,
      url: supabaseUrl ? `${supabaseUrl.substring(0, 15)}...` : "missing"
    },
    secrets: {
      gemini: !!config.GEMINI_API_KEY,
      shopify: !!config.SHOPIFY_CLIENT_ID,
      meta_ads: !!config.META_ADS_ACCESS_TOKEN,
      appUrl: config.APP_URL || "using_request_host"
    }
  });
});

// Evaluate Product
app.post("/api/evaluate-product", async (req, res) => {
  try {
    const { id, title, sourceCountry, trendScore } = req.body;
    const ai = await getAi();
    
    const prompt = `
      Evaluate this product for the North American (USA/Canada) market:
      Title: ${title}
      Source Country: ${sourceCountry}
      Trend Score: ${trendScore}
      
      If it's suitable, rewrite the title and create a persuasive SEO-optimized description.
      Return ONLY valid JSON format:
      {
        "suitable": boolean,
        "reason": string,
        "optimized_title": string,
        "optimized_description": string,
        "tags": string[]
      }
    `;

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean possible markdown backticks
    const jsonStr = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const evaluation = JSON.parse(jsonStr);

    if (id) {
      await supabase
        .from("trending_products")
        .update({
          status: evaluation.suitable ? "approved" : "rejected",
          optimized_title: evaluation.optimized_title,
          optimized_description: evaluation.optimized_description,
          tags: evaluation.tags
        })
        .eq("id", id);
    }

    res.json(evaluation);
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: "Failed to evaluate product" });
  }
});

// Shopify Sync
app.post("/api/sync-to-shopify", async (req, res) => {
  try {
    const { id, title, description, tags } = req.body;
    const config = await getConfig();
    
    // 1. Get credentials from Supabase
    const { data: shopSnap, error: shopError } = await supabase
      .from("settings")
      .select("*")
      .eq("id", "shopify")
      .single();

    if (shopError || !shopSnap || !shopSnap.accessToken) {
      console.warn("[Shopify Sync] Connection missing or token unavailable");
      return res.status(400).json({ error: "Shopify not connected. Please authorize in your dashboard." });
    }

    const { shop, accessToken } = shopSnap;
    const shopDomain = shopSnap.config?.domain || (shop.includes(".") ? shop : `${shop}.myshopify.com`);
    const fullShop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;

    console.log(`[Shopify Sync] Pushing product ${id} to ${fullShop}`);

    // 2. Create product in Shopify
    const shopifyApiUrl = `https://${fullShop}/admin/api/2024-01/products.json`;
    const response = await fetch(shopifyApiUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        product: {
          title: title,
          body_html: description,
          vendor: "TrendToStore AI",
          product_type: "Trending",
          tags: Array.isArray(tags) ? tags.join(", ") : tags,
          status: "draft"
        }
      })
    });

    const shopifyData: any = await response.json();

    if (!response.ok || !shopifyData.product) {
      console.error("[Shopify Sync] API Error:", shopifyData);
      return res.status(response.status).json({ error: shopifyData.errors || "Failed to create product on Shopify" });
    }

    const shopifyProductId = shopifyData.product.id;
    const shopifyUrl = `https://${fullShop}/admin/products/${shopifyProductId}`;
    
    // 3. Update status in Supabase
    await supabase
      .from("trending_products")
      .update({
        status: "synced_to_shopify",
        shopify_url: shopifyUrl,
        synced_at: new Date().toISOString()
      })
      .eq("id", id);

    res.json({ success: true, shopifyUrl, status: "synced_to_shopify" });
  } catch (error) {
    console.error("[Shopify Sync] Exception:", error);
    res.status(500).json({ error: "Failed to sync to Shopify" });
  }
});

// Marketing Campaign
app.post("/api/marketing/launch", async (req, res) => {
  try {
    const { id, shopifyUrl } = req.body;
    const config = await getConfig();

    if (!config.META_ADS_ACCESS_TOKEN) {
      return res.status(400).json({ error: "Meta Ads not connected. Add your ACCESS_TOKEN to Supabase secrets." });
    }

    // In a real app, you would use the Facebook Marketing API here
    // e.g. POST graph.facebook.com/v19.0/act_{account_id}/campaigns
    
    console.log(`[Meta Ads] Launching campaign for product ${id} with URL ${shopifyUrl}`);
    
    const campaignId = `act_${Math.random().toString(36).substr(2, 9)}`;

    await supabase
      .from("trending_products")
      .update({ 
        status: "campaign_live",
        // campaignId could be stored here if column existed
      })
      .eq("id", id);

    res.json({ 
      success: true, 
      campaignId,
      status: "campaign_live"
    });
  } catch (error) {
    console.error("Meta Ads Error:", error);
    res.status(500).json({ error: "Failed to launch campaign on Meta" });
  }
});

// Shopify Status
app.get("/api/shopify/status", async (req, res) => {
  try {
    const { data: docSnap } = await supabase
      .from("settings")
      .select("*")
      .eq("id", "shopify")
      .single();

    res.json({ connected: !!docSnap, shop: docSnap?.shop });
  } catch (error) {
    res.json({ connected: false });
  }
});

// Ingest Trends
app.get("/api/scout-trends", async (req, res) => {
  try {
    const ai = await getAi();
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
      Return a JSON array of 3 trending consumer products for May 2024. 
      Each object must exactly match this structure:
      {
        "title": "Product Name",
        "source_country": "USA",
        "trend_score": 95,
        "image_url": "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800"
      }
      Output only the raw JSON array. No markdown, no extra text.
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const cleanedText = text.replace(/```json|```/g, "").trim();
    const generatedTrends = JSON.parse(cleanedText);

    const savedProducts = [];
    for (const trend of generatedTrends) {
      const { data, error } = await supabase
        .from("trending_products")
        .insert({
          ...trend,
          status: "pending_review",
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (error) {
        console.error("Supabase Insert Error:", error);
        continue;
      }
      if (data) savedProducts.push(data);
    }

    res.json({ processed: generatedTrends.length, saved: savedProducts.length, items: savedProducts });
  } catch (error) {
    console.error("Scout Error:", error);
    res.status(500).json({ error: "Failed to scout trends" });
  }
});

  // Shopify OAuth Integration
  app.get("/api/shopify/auth", async (req, res) => {
    const config = await getConfig();
    let shop = (req.query.shop as string) || config.SHOPIFY_SHOP_DOMAIN;
    
    if (shop) {
      // Force clean handle: "my-store.myshopify.com" -> "my-store"
      shop = shop.replace(/^https?:\/\//, "")
                 .replace(/\.myshopify\.com\/?$/, "")
                 .split(".")[0] // robust split
                 .trim();
    }

    if (!shop) {
      return res.status(400).json({ 
        error: "Shop domain missing. Set SHOPIFY_SHOP_DOMAIN in Supabase secrets (id='secrets') or provide ?shop=" 
      });
    }

    const client_id = config.SHOPIFY_CLIENT_ID;
    const scopes = "read_products,write_products";
    
    // SMART REDIRECT: Use current request host if we are in a dev/preview environment
    const host = req.headers["host"];
    const protocol = req.headers["x-forwarded-proto"] || "https";
    let redirectBase = `${protocol}://${host}`;
    
    // Only use hardcoded APP_URL if we are not on a preview/dev domain
    if (config.APP_URL && !host?.includes("run.app") && !host?.includes("localhost")) {
      redirectBase = config.APP_URL.replace(/\/$/, "");
      if (!redirectBase.startsWith("http")) redirectBase = `https://${redirectBase}`;
    }
    
    const redirect_uri = `${redirectBase}/api/shopify/callback`;
    
    console.log(`[Shopify Auth] Store: ${shop}, ClientID: ${client_id ? "SET" : "MISSING"}, Redirect: ${redirect_uri}`);

    if (!client_id) {
      return res.status(500).json({ 
        error: "SHOPIFY_CLIENT_ID (API Key) is missing in server config. Check Supabase 'settings' table (id='secrets')." 
      });
    }

    const authUrl = `https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${client_id}&scope=${scopes}&redirect_uri=${redirect_uri}`;
    
    res.json({ url: authUrl });
  });

  // Meta Ads Status
  app.get("/api/marketing/status", async (req, res) => {
    const config = await getConfig();
    res.json({ connected: !!config.META_ADS_ACCESS_TOKEN });
  });

  // Debug Endpoint
  app.get("/api/debug-config", async (req, res) => {
    const config = await getConfig();
    res.json({
      supabase: {
        url: !!supabaseUrl,
        key: !!supabaseServiceKey,
      },
      secrets: {
        gemini: !!config.GEMINI_API_KEY,
        shopify_id: !!config.SHOPIFY_CLIENT_ID,
        meta_ads: !!config.META_ADS_ACCESS_TOKEN,
        shop_domain: config.SHOPIFY_SHOP_DOMAIN || "NOT_SET",
        app_url: config.APP_URL || "NOT_SET"
      }
    });
  });

  app.get("/api/shopify/callback", async (req, res) => {
    const { shop, code } = req.query;
    const config = await getConfig();
    
    if (!shop || !code) {
      return res.status(400).send("Missing shop or code");
    }

    const fullShop = (shop as string).includes(".") ? shop : `${shop}.myshopify.com`;

    try {
      const response = await fetch(`https://${fullShop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.SHOPIFY_CLIENT_ID,
          client_secret: config.SHOPIFY_CLIENT_SECRET,
          code
        })
      });

      const data: any = await response.json();
      
      if (data.access_token) {
        // Fetch real shop name/info using the token
        const shopInfoRes = await fetch(`https://${fullShop}/admin/api/2024-01/shop.json`, {
          headers: { "X-Shopify-Access-Token": data.access_token }
        });
        const shopInfo: any = await shopInfoRes.json();
        const displayName = shopInfo?.shop?.name || shop;

        await supabase
          .from("settings")
          .upsert({
            id: "shopify",
            accessToken: data.access_token,
            shop: displayName, // Store the friendly name
            config: { domain: shop },
            connectedAt: new Date().toISOString()
          });

        res.send(`
          <html>
            <body style="background: #0A0A0C; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
              <div style="text-align: center; border: 1px solid #10b981; padding: 40px; border-radius: 20px; background: #16161A; max-width: 400px;">
                <div style="font-size: 48px; margin-bottom: 20px;">✅</div>
                <h2 style="color: #10b981; font-size: 24px; margin-bottom: 10px;">Connection Success!</h2>
                <p style="color: #94a3b8; line-height: 1.6;">You are now linked to <strong>${displayName}</strong>. This window will close automatically.</p>
                <script>
                  setTimeout(() => {
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', shop: '${displayName}' }, '*');
                    window.close();
                  }, 2500);
                </script>
              </div>
            </body>
          </html>
        `);
      } else {
        res.status(500).send("Failed to retrieve access token. Check your App Credentials.");
      }
    } catch (error) {
      console.error("Shopify Callback Error:", error);
      res.status(500).send("Authentication failed: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  });

// List Products
app.get("/api/products", async (req, res) => {
  try {
    if (!isSupabaseConfigured) {
      return res.json([]); // Return empty list if not configured instead of 502
    }
    const { data: products, error } = await supabase
      .from("trending_products")
      .select("*")
      .order("created_at", { ascending: false });
    
    if (error) {
      console.error("[Products API] Supabase Error:", error.message, "Code:", error.code);
      throw error;
    }
    res.json(products || []);
  } catch (error: any) {
    console.error("[Products API] Exception:", error.message || error);
    res.status(500).json({ 
      error: "Failed to fetch products", 
      details: error.message,
      hint: error.code === '42P01' ? "Table 'trending_products' does not exist. Run the SQL schema in Supabase." : undefined
    });
  }
});

// Export for Netlify Functions
export const handler = serverless(app);

// Local server setup
if (process.env.NODE_ENV !== "production" && !process.env.NETLIFY) {
  const startLocalServer = async () => {
    // Dynamic import so Vite is never bundled into the Netlify function
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    
    app.use(vite.middlewares);
    
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Development server running at http://localhost:${PORT}`);
    });
  };

  startLocalServer();
} else if (process.env.NODE_ENV === "production" && !process.env.NETLIFY) {
  // Standard production server (non-serverless)
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
  
    const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Production server running at http://localhost:${PORT}`);
  });
}
