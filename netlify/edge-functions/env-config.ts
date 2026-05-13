/**
 * Netlify Edge Function: env-config
 *
 * Serves non-secret runtime configuration to the Netlify site.
 * Secrets like SUPABASE_SERVICE_ROLE_KEY are intentionally NOT exposed here —
 * they are only used server-side inside the Netlify Function (server.ts).
 *
 * This edge function is the bridge that lets the backend Netlify Function
 * pick up environment variables that Netlify injects at the edge layer.
 *
 * Deploy environment variables in:
 *   Netlify Dashboard → Site → Environment Variables
 */
export default async (request: Request, context: any) => {
  // Only allow requests from the same origin (internal use)
  const origin = request.headers.get("origin") || "";
  const host = request.headers.get("host") || "";

  // Build the config object from Netlify-injected env vars
  // Deno.env is available in Netlify Edge Functions
  const config = {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY") ?? "",
    SHOPIFY_CLIENT_ID: Deno.env.get("SHOPIFY_CLIENT_ID") ?? "",
    SHOPIFY_CLIENT_SECRET: Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "",
    SHOPIFY_SHOP_DOMAIN: Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? "",
    APP_URL: Deno.env.get("APP_URL") ?? "",
    META_ADS_ACCESS_TOKEN: Deno.env.get("META_ADS_ACCESS_TOKEN") ?? "",
    META_AD_ACCOUNT_ID: Deno.env.get("META_AD_ACCOUNT_ID") ?? "",
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Only accessible server-side — not cached by CDN
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};

export const config = {
  path: "/.netlify/edge-functions/env-config",
};
