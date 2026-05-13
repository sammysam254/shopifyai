/**
 * Supabase Edge Function: secrets-proxy
 *
 * Acts as a secure secrets bridge for the Netlify Function.
 * The Netlify Function calls this endpoint with a shared PROXY_SECRET
 * header. This function reads all secrets from Deno.env (Supabase vault)
 * and returns them as JSON.
 *
 * Setup:
 *   1. Deploy this function:
 *        supabase functions deploy secrets-proxy --no-verify-jwt
 *
 *   2. Set all your secrets in Supabase vault:
 *        supabase secrets set PROXY_SECRET=<a-long-random-string>
 *        supabase secrets set GEMINI_API_KEY=...
 *        supabase secrets set SHOPIFY_CLIENT_ID=...
 *        supabase secrets set SHOPIFY_CLIENT_SECRET=...
 *        supabase secrets set SHOPIFY_SHOP_DOMAIN=...
 *        supabase secrets set APP_URL=...
 *        supabase secrets set META_ADS_ACCESS_TOKEN=...
 *        supabase secrets set META_AD_ACCOUNT_ID=...
 *
 *   3. Set the SAME PROXY_SECRET in Netlify:
 *        Netlify Dashboard → Site → Environment Variables
 *        PROXY_SECRET = <same-long-random-string>
 *        SUPABASE_FUNCTIONS_URL = https://<your-project-ref>.supabase.co/functions/v1
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-proxy-secret, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only allow POST or GET
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Validate the shared proxy secret
  const proxySecret = Deno.env.get("PROXY_SECRET");
  const incomingSecret = req.headers.get("x-proxy-secret");

  if (!proxySecret || !incomingSecret || incomingSecret !== proxySecret) {
    console.error("[secrets-proxy] Unauthorized request — invalid or missing x-proxy-secret");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Return all secrets as JSON
  const secrets = {
    GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY") ?? "",
    SHOPIFY_CLIENT_ID: Deno.env.get("SHOPIFY_CLIENT_ID") ?? "",
    SHOPIFY_CLIENT_SECRET: Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "",
    SHOPIFY_SHOP_DOMAIN: Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? "",
    SHOPIFY_ACCESS_TOKEN: Deno.env.get("SHOPIFY_ACCESS_TOKEN") ?? "",
    APP_URL: Deno.env.get("APP_URL") ?? "",
    META_ADS_ACCESS_TOKEN: Deno.env.get("META_ADS_ACCESS_TOKEN") ?? "",
    META_AD_ACCOUNT_ID: Deno.env.get("META_AD_ACCOUNT_ID") ?? "",
  };

  console.log("[secrets-proxy] Secrets served successfully");

  return new Response(JSON.stringify(secrets), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
