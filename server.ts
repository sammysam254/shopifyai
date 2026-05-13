import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import serverless from "serverless-http";

dotenv.config();

const app = express();
app.use(express.json());

// Initialize Supabase Admin (Service Role)
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("CRITICAL: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from environment variables.");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Configuration loader helper
async function getConfig() {
  const config: Record<string, string> = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID || "",
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || "",
    SHOPIFY_SHOP_DOMAIN: process.env.SHOPIFY_SHOP_DOMAIN || "",
    APP_URL: process.env.APP_URL || ""
  };

  // If critical keys are missing, try fetching from Supabase settings
  if (!config.GEMINI_API_KEY || !config.SHOPIFY_CLIENT_ID) {
    try {
      const { data } = await supabase
        .from("settings")
        .select("*")
        .eq("id", "secrets")
        .single();
      
      if (data && data.config) {
        config.GEMINI_API_KEY = config.GEMINI_API_KEY || data.config.GEMINI_API_KEY;
        config.SHOPIFY_CLIENT_ID = config.SHOPIFY_CLIENT_ID || data.config.SHOPIFY_CLIENT_ID;
        config.SHOPIFY_CLIENT_SECRET = config.SHOPIFY_CLIENT_SECRET || data.config.SHOPIFY_CLIENT_SECRET;
        config.SHOPIFY_SHOP_DOMAIN = config.SHOPIFY_SHOP_DOMAIN || data.config.SHOPIFY_SHOP_DOMAIN;
        config.APP_URL = config.APP_URL || data.config.APP_URL;
      }
    } catch (e) {
      console.warn("Could not load secrets from Supabase:", e);
    }
  }

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
  
  if (supabaseOk) {
    try {
      const { count, error } = await supabase.from("settings").select("*", { count: "exact", head: true });
      supabaseDataOk = !error;
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
      url: supabaseUrl ? `${supabaseUrl.substring(0, 12)}...` : "missing"
    },
    secrets: {
      gemini: !!config.GEMINI_API_KEY,
      shopify: !!config.SHOPIFY_CLIENT_ID,
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
        "optimizedTitle": string,
        "optimizedDescription": string,
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
          optimizedTitle: evaluation.optimizedTitle,
          optimizedDescription: evaluation.optimizedDescription,
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
    const { id } = req.body;
    
    const { data: shopSnap, error: shopError } = await supabase
      .from("settings")
      .select("*")
      .eq("id", "shopify")
      .single();

    if (shopError || !shopSnap) {
      return res.status(400).json({ error: "Shopify not connected. Please authorize in your dashboard." });
    }

    const { shop } = shopSnap;
    const shopifyUrl = `https://${shop}/products/${id}`;
    
    await supabase
      .from("trending_products")
      .update({
        status: "synced_to_shopify",
        shopifyUrl: shopifyUrl,
        syncedAt: new Date().toISOString()
      })
      .eq("id", id);

    res.json({ success: true, shopifyUrl, status: "synced_to_shopify" });
  } catch (error) {
    console.error("Shopify Sync Error:", error);
    res.status(500).json({ error: "Failed to sync to Shopify" });
  }
});

// Marketing Campaign
app.post("/api/launch-campaign", async (req, res) => {
  try {
    const { id } = req.body;
    await supabase
      .from("trending_products")
      .update({ status: "campaign_live" })
      .eq("id", id);

    res.json({ 
      success: true, 
      campaignId: `ad_${Math.random().toString(36).substr(2, 9)}`,
      status: "campaign_live"
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to launch campaign" });
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
        "sourceCountry": "USA",
        "trendScore": 95,
        "imageUrl": "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800"
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
          createdAt: new Date().toISOString()
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
                 .split("/")[0]
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
    }
    
    const redirect_uri = `${redirectBase}/api/shopify/callback`;
    
    console.log(`[Shopify Auth] Store: ${shop}, ClientID: ${client_id ? "SET" : "MISSING"}, Redirect: ${redirect_uri}`);

    if (!client_id) {
      return res.status(500).json({ 
        error: "SHOPIFY_CLIENT_ID (API Key) is missing. Ensure your Supabase 'settings' table has a row with id 'secrets' and a valid JSON config." 
      });
    }

    const authUrl = `https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${client_id}&scope=${scopes}&redirect_uri=${redirect_uri}`;
    
    res.json({ url: authUrl });
  });

  // Debug Endpoint to verify secrets
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
        shopify_secret: !!config.SHOPIFY_CLIENT_SECRET,
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
    const { data: products, error } = await supabase
      .from("trending_products")
      .select("*")
      .order("createdAt", { ascending: false });
    res.json(products || []);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Export for Netlify Functions
export const handler = serverless(app);

// Local server setup
if (process.env.NODE_ENV !== "production" && !process.env.NETLIFY) {
  const startLocalServer = async () => {
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
