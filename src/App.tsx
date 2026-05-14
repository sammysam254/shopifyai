import { useState, useEffect } from "react";
import { 
  BarChart3, 
  ShoppingBag, 
  Globe, 
  CheckCircle2, 
  XCircle, 
  Zap, 
  TrendingUp, 
  Plus, 
  Search,
  ExternalLink,
  Rocket
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { ProductStatus, TrendingProduct, EvaluationResult } from "./types";

export default function App() {
  const [products, setProducts] = useState<TrendingProduct[]>([]);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [activeTab, setActiveTab] = useState<ProductStatus | "all">("all");
  const [isSyncing, setIsSyncing] = useState<string | null>(null);
  const [isScouting, setIsScouting] = useState(false);
  const [shopifyStatus, setShopifyStatus] = useState<{ connected: boolean; shop?: string }>({ connected: false });
  const [metaAdsStatus, setMetaAdsStatus] = useState<{ connected: boolean }>({ connected: false });
  const [systemHealth, setSystemHealth] = useState<any>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnectingMeta, setIsConnectingMeta] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  // Fetch initial data, status and system health
  useEffect(() => {
    const init = async () => {
      setInitError(null);
      try {
        const [prodRes, shopRes, metaRes, healthRes] = await Promise.all([
          fetch("/api/products"),
          fetch("/api/shopify/status"),
          fetch("/api/marketing/status"),
          fetch("/api/health")
        ]);

        if (!prodRes.ok) {
          const errData = await prodRes.json().catch(() => ({}));
          throw new Error(errData.hint || errData.details || `Products API error (${prodRes.status})`);
        }
        
        const prodData = await prodRes.json();
        const shopData = await shopRes.json();
        const metaData = await metaRes.json();
        const healthData = healthRes.ok ? await healthRes.json() : null;

        setProducts(Array.isArray(prodData) ? prodData : []);
        setShopifyStatus(shopData);
        setMetaAdsStatus(metaData);
        setSystemHealth(healthData);
      } catch (error: any) {
        console.error("Initialization failed", error);
        setInitError(error.message || "Connection to backend failed");
      }
    };
    init();
  }, []);

  const connectMetaAds = async () => {
    setIsConnectingMeta(true);
    try {
      const res = await fetch("/api/marketing/status");
      const data = await res.json();
      setMetaAdsStatus({ connected: data.connected });
      if (!data.connected) alert("META_ADS_ACCESS_TOKEN not set in Supabase vault. Run: supabase secrets set META_ADS_ACCESS_TOKEN=your-token");
    } catch (e) {
      console.error("Meta Ads status check failed", e);
    } finally {
      setIsConnectingMeta(false);
    }
  };

  // Listen for Shopify OAuth success
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const checkStatus = async () => {
          const res = await fetch("/api/shopify/status");
          const data = await res.json();
          setShopifyStatus(data);
          setIsConnecting(false);
        };
        checkStatus();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const connectShopify = async () => {
    setIsConnecting(true);
    setConnError(null);

    try {
      // 1. Try initiation (The server will check for shop domain in secrets or query)
      const response = await fetch("/api/shopify/auth");
      let data = await response.json();

      // 2. If it failed because of missing shop, ask user
      if (response.status === 400 && data.error?.includes("Shop domain missing")) {
        const shopHandle = prompt("Enter your Shopify Store Handle (e.g. 'vertext-market'):");
        if (!shopHandle) {
          setIsConnecting(false);
          return;
        }
        const retryRes = await fetch(`/api/shopify/auth?shop=${shopHandle}`);
        data = await retryRes.json();
      }

      if (data.url) {
        // Open the popup
        const width = 600;
        const height = 800;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        
        const popup = window.open(
          data.url, 
          'shopify_oauth', 
          `width=${width},height=${height},left=${left},top=${top},status=no,directories=no,location=no,menubar=no,toolbar=no`
        );
        
        if (!popup || popup.closed || typeof popup.closed === 'undefined') {
          throw new Error("Popup blocked! Please allow popups for this site.");
        }
      } else {
        throw new Error(data.error || "Server failed to return an auth URL. Check Supabase 'settings' table (id='secrets').");
      }
    } catch (error: any) {
      console.error("Connection failed:", error);
      setConnError(error.message || "Failed to connect to Shopify");
      setIsConnecting(false);
    }
  };

  const scoutTrends = async () => {
    setIsScouting(true);
    try {
      const response = await fetch("/api/scout-trends");
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Scouting API error (${response.status}): ${text.slice(0, 100)}`);
      }
      const data = await response.json();
      setProducts(prev => [...(data.items || []), ...prev]);
    } catch (error) {
      console.error("Scouting failed", error);
    } finally {
      setIsScouting(false);
    }
  };

  const syncToShopify = async (product: TrendingProduct) => {
    setIsSyncing(product.id);
    try {
      const response = await fetch("/api/sync-to-shopify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: product.id,
          title: product.optimized_title,
          description: product.optimized_description,
          tags: product.tags
        })
      });
      const result = await response.json();
      setProducts(prev => prev.map(p => 
        p.id === product.id ? { ...p, status: ProductStatus.SYNCED, shopify_url: result.shopify_url } : p
      ));
    } catch (error) {
      console.error("Sync failed", error);
    } finally {
      setIsSyncing(null);
    }
  };

  const launchCampaign = async (product: TrendingProduct) => {
    try {
      const response = await fetch("/api/marketing/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: product.id,
          shopify_url: product.shopify_url
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Launch failed");

      setProducts(prev => prev.map(p => 
        p.id === product.id ? { ...p, status: ProductStatus.CAMPAIGN_LIVE } : p
      ));
    } catch (error: any) {
      console.error("Campaign launch failed", error);
      alert("Campaign Launch Error: " + error.message);
    }
  };

  const evaluateProduct = async (product: TrendingProduct) => {
    setIsEvaluating(true);
    try {
      const response = await fetch("/api/evaluate-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: product.title,
          image_url: product.image_url,
          source_country: product.source_country,
          trend_score: product.trend_score
        })
      });
      
      const result: EvaluationResult = await response.json();
      
      setProducts(prev => prev.map(p => 
        p.id === product.id 
          ? { 
              ...p, 
              status: result.suitable ? ProductStatus.APPROVED : ProductStatus.REJECTED,
              optimized_title: result.optimized_title,
              optimized_description: result.optimized_description,
              tags: result.tags
            } 
          : p
      ));
    } catch (error) {
      console.error("Evaluation failed", error);
    } finally {
      setIsEvaluating(false);
    }
  };

  const filteredProducts = Array.isArray(products) 
    ? (activeTab === "all" ? products : products.filter(p => p.status === activeTab))
    : [];

  return (
    <div className="min-h-screen bg-[#0A0A0C] text-slate-200 p-6 flex flex-col gap-6 font-sans">
      {/* Header Section */}
      <header className="flex items-center justify-between border-b border-slate-800 pb-4 h-[60px]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-white">
            <TrendingUp className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-display font-bold tracking-tight uppercase italic flex items-center gap-2">
            TrendToStore AI <span className="text-slate-500 font-normal normal-case italic text-xs">v1.5.0</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 bg-slate-900 px-3 py-1 rounded-full border border-slate-700">
            <div className={`w-2 h-2 rounded-full ${systemHealth?.supabase?.reachable ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-red-500 animate-pulse"}`}></div>
            <span className="text-[10px] font-mono uppercase tracking-wider">
              Supabase: {systemHealth?.supabase?.reachable ? "Online" : "Offline/Error"}
            </span>
          </div>
          <div className="flex items-center gap-2 bg-slate-900 px-3 py-1 rounded-full border border-slate-700">
            <div className={`w-2 h-2 rounded-full ${systemHealth?.secrets?.gemini ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" : "bg-red-500 animate-pulse"}`}></div>
            <span className="text-[10px] font-mono uppercase tracking-wider">
              Gemini: {systemHealth?.secrets?.gemini ? "Active" : "Keys Missing"}
            </span>
          </div>
          
          <button 
            onClick={scoutTrends}
            disabled={isScouting}
            className="group flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
          >
            <Zap className={`w-4 h-4 ${isScouting ? "animate-pulse" : "group-hover:scale-125 transition-transform"}`} />
            {isScouting ? "Scouting..." : "Ingest New Trends"}
          </button>
        </div>
      </header>

      {initError && (
        <div className="bg-red-500/10 border border-red-500/30 p-4 rounded-xl flex items-start justify-between">
          <div className="flex items-start gap-4">
            <div className="mt-1">
              <XCircle className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-sm font-bold text-red-500 uppercase tracking-widest leading-none mb-2">System Error: {initError.includes("502") ? "Service Unavailable (502)" : "Initialization Failed"}</p>
              <p className="text-xs text-slate-400 font-mono mb-4">{initError}</p>
              
              {(!systemHealth?.supabase?.reachable || initError.toLowerCase().includes("does not exist")) && (
                <div className="bg-slate-900 border border-slate-700 p-4 rounded-lg max-w-lg">
                  <h4 className="text-xs font-bold text-blue-400 uppercase mb-2 flex items-center gap-2">
                    <Zap className="w-3 h-3" />
                    Action Required:
                  </h4>
                  <p className="text-[11px] text-slate-300 leading-relaxed mb-3">
                    {initError.toLowerCase().includes("does not exist") 
                      ? "Your Supabase project is connected, but the database tables are missing."
                      : "Your backend cannot connect to Supabase. This is causing 'Invalid URL' and '502' errors."}
                  </p>
                  <ol className="text-[10px] text-slate-400 list-decimal ml-4 space-y-1">
                    {!systemHealth?.supabase?.reachable ? (
                      <>
                        <li>Open <strong>server.ts</strong> in the editor.</li>
                        <li>Paste your <strong>SUPABASE_URL</strong> and <strong>SERVICE_ROLE_KEY</strong> into the override variables at the top.</li>
                      </>
                    ) : (
                      <>
                        <li>Open the file <strong>supabase_schema.sql</strong> in this project.</li>
                        <li>Copy all the code in that file.</li>
                        <li>Go to your <strong>Supabase Dashboard</strong> &gt; <strong>SQL Editor</strong>.</li>
                        <li>Paste the code and click <strong>Run</strong>.</li>
                      </>
                    )}
                    <li>Click the <strong>Retry</strong> button below once done.</li>
                  </ol>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button 
              onClick={() => window.location.reload()}
              className="text-[10px] bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg font-bold uppercase transition-colors"
            >
              Retry Connection
            </button>
          </div>
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex-1 grid grid-cols-12 gap-6 overflow-hidden">
        
        {/* Left Stats Column */}
        <div className="col-span-3 flex flex-col gap-6">
          <div className="bento-card flex-1 flex flex-col justify-between overflow-hidden">
            <div className="flex justify-between items-start mb-4">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Trend Analysis</span>
              <span className="text-emerald-400 text-xs font-mono">+24% vs Prev</span>
            </div>
            <div className="text-4xl font-display font-bold tracking-tighter mb-4">
              {Array.isArray(products) ? products.length : 0} <span className="text-lg text-slate-500 font-normal">Active</span>
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <div className="text-[10px] uppercase text-slate-500 font-bold mb-2">Workflow State</div>
              {[
                { id: "all", label: "Global Pool", icon: Globe, count: Array.isArray(products) ? products.length : 0 },
                { id: ProductStatus.PENDING, label: "To Review", icon: Zap, count: Array.isArray(products) ? products.filter(p => p.status === ProductStatus.PENDING).length : 0 },
                { id: ProductStatus.APPROVED, label: "Curated", icon: CheckCircle2, count: Array.isArray(products) ? products.filter(p => p.status === ProductStatus.APPROVED).length : 0 },
                { id: ProductStatus.SYNCED, label: "Shopify", icon: ShoppingBag, count: Array.isArray(products) ? products.filter(p => p.status === ProductStatus.SYNCED).length : 0 },
                { id: ProductStatus.CAMPAIGN_LIVE, label: "Live Ads", icon: Rocket, count: Array.isArray(products) ? products.filter(p => p.status === ProductStatus.CAMPAIGN_LIVE).length : 0 }
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as any)}
                  className={`group w-full flex items-center justify-between px-3 py-2 rounded-xl text-[11px] font-mono transition-all border ${
                    activeTab === item.id 
                    ? "bg-blue-600/10 border-blue-500/50 text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.1)]" 
                    : "border-transparent bg-white/5 hover:bg-white/10 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <item.icon className={`w-3.5 h-3.5 ${activeTab === item.id ? "text-blue-400" : "text-slate-600"}`} />
                    <span>{item.label}</span>
                  </div>
                  <span className={`px-1.5 rounded-full ${activeTab === item.id ? "bg-blue-500 text-white" : "bg-slate-800 text-slate-500"}`}>
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="bento-card h-48 flex flex-col justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-3">Integrations</span>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className={`w-4 h-4 ${shopifyStatus.connected ? "text-emerald-400" : "text-slate-600"}`} />
                  <span className="text-[11px] font-mono">Shopify</span>
                </div>
                {shopifyStatus.connected ? (
                  <span className="text-[9px] text-emerald-400 font-mono uppercase truncate max-w-[120px]" title={shopifyStatus.shop}>OK: {shopifyStatus.shop}</span>
                ) : (
                  <button 
                    onClick={connectShopify} 
                    disabled={isConnecting || !systemHealth?.supabase?.reachable}
                    className={`text-[9px] border px-2 py-0.5 rounded-full transition-all ${
                      systemHealth?.supabase?.reachable 
                        ? "bg-blue-600/20 text-blue-400 border-blue-500/30 hover:bg-blue-600/30" 
                        : "bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed"
                    }`}
                  >
                    {isConnecting ? "Connecting..." : "Connect"}
                  </button>
                )}
              </div>
              {connError && (
                <div className="bg-red-500/10 border border-red-500/20 p-2 rounded text-[9px] text-red-400 font-mono leading-tight">
                  <div className="font-bold flex items-center gap-1 mb-1">
                    <XCircle className="w-3 h-3" />
                    CONNECTION FAILED
                  </div>
                  {connError}
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Rocket className={`w-4 h-4 ${metaAdsStatus.connected ? "text-emerald-400" : "text-slate-600"}`} />
                  <span className="text-[11px] font-mono">Meta Ads</span>
                </div>
                {metaAdsStatus.connected ? (
                  <span className="text-[9px] text-emerald-400 font-mono uppercase">API ACTIVE</span>
                ) : (
                  <button 
                    onClick={connectMetaAds}
                    disabled={isConnectingMeta}
                    className="text-[9px] bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full hover:bg-emerald-600/30"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
            
            <div className="glass-panel p-2 mt-4 font-mono text-[9px] text-emerald-400/80 leading-relaxed overflow-hidden">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                <span>AUTO-SYNC ACTIVE</span>
              </div>
              <div>&gt; LAST_CHECK: {new Date().toLocaleTimeString()}</div>
            </div>
          </div>
        </div>

        {/* Center/Main Grid Section */}
        <div className="col-span-9 flex flex-col gap-6 overflow-hidden">
          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-6 font-mono">
            <div className="bento-card !p-4 flex flex-col justify-between h-32">
              <div className="flex justify-between items-start">
                <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Today's Orders</span>
                <span className="text-emerald-400 text-[10px]">+18.2%</span>
              </div>
              <div className="text-3xl font-display font-bold">482</div>
              <div className="text-[10px] text-slate-500 font-mono tracking-tight flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                Live Stream Active
              </div>
            </div>
            <div className="bento-card !p-4 flex flex-col justify-between h-32">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Omni-Channel ROAS</span>
              <div className="flex items-end justify-between">
                <div className="text-3xl font-display font-bold">4.2x</div>
                <div className="text-blue-400 text-[10px]">Meta: 5.1x</div>
              </div>
              <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div className="bg-blue-500 h-full w-[92%]"></div>
              </div>
            </div>
            <div className="bento-card !p-4 flex flex-col justify-between h-32">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Global Inventory</span>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-2xl font-display font-bold">12,842</div>
                  <div className="text-[8px] text-slate-500 uppercase tracking-widest">Across 14 Nodes</div>
                </div>
                <Globe className="w-6 h-6 text-slate-700 animate-[spin_10s_linear_infinite]" />
              </div>
            </div>
            <div className="bento-card !p-4 flex flex-col justify-between h-32">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">API Mesh Health</span>
              <div className="flex flex-col gap-1 mt-2">
                <div className="flex justify-between text-[9px]">
                  <span className="text-slate-500">Shopify API</span>
                  <span className="text-emerald-400">99.9%</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span className="text-slate-500">Meta Marketing</span>
                  <span className="text-emerald-400">98.4%</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span className="text-slate-500">Gemini LLM</span>
                  <span className="text-emerald-400">100%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Top Banner / Filter Info */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-3xl font-display font-bold tracking-tighter uppercase italic flex items-center gap-3">
                {activeTab === "all" ? "The Global Stream" : activeTab.replace(/_/g, " ")}
              </h2>
              <p className="text-xs text-slate-500 italic font-serif">Curating real-time trends for North American expansion.</p>
            </div>
            <div className="flex gap-1 border border-slate-800 rounded-lg p-1 bg-black/40">
              <Search className="w-4 h-4 m-2 text-slate-600" />
              <input 
                type="text" 
                placeholder="FILTER TRENDS..." 
                className="bg-transparent border-none focus:outline-none text-[10px] uppercase font-mono tracking-widest w-48 text-slate-400"
              />
            </div>
          </div>

          {/* Dynamic Content: Product Grid / Table */}
          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-6">
              <AnimatePresence mode="popLayout">
                {filteredProducts.map((product) => (
                  <motion.div
                    layout
                    key={product.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bento-card group flex gap-5 !p-0 overflow-hidden relative"
                  >
                    {/* Status Badge Overlay */}
                    <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2">
                      <div className={`status-badge ${
                        product.status === ProductStatus.PENDING ? "bg-amber-500/10 text-amber-500 border-amber-500/30" :
                        product.status === ProductStatus.APPROVED ? "bg-blue-500/10 text-blue-400 border-blue-500/30" :
                        product.status === ProductStatus.SYNCED ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" :
                        "bg-slate-800 text-slate-500 border-slate-700"
                      }`}>
                        {product.status.replace(/_/g, " ")}
                      </div>
                      <div className="text-[10px] font-mono font-bold text-white bg-black/60 px-2 py-0.5 rounded backdrop-blur-md">
                        SCORE: {product.trend_score}
                      </div>
                    </div>

                    {/* Image Section */}
                    <div className="w-40 h-full relative overflow-hidden bg-slate-900 flex-shrink-0">
                      <img 
                        src={product.image_url} 
                        alt={product.title} 
                        className="w-full h-full object-cover transition-all duration-700 group-hover:scale-110 opacity-70 group-hover:opacity-100"
                      />
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent to-[#16161A]/80"></div>
                      <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
                        <Globe className="w-3 h-3 text-slate-400" />
                        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-300">{product.source_country}</span>
                      </div>
                    </div>

                    {/* Info Section */}
                    <div className="flex-1 p-5 flex flex-col justify-between min-w-0">
                      <div>
                        <h3 className="font-display text-lg font-bold tracking-tight mb-2 uppercase italic leading-tight text-white line-clamp-2">
                          {product.optimized_title || product.title}
                        </h3>
                        <p className="text-[11px] text-slate-400 italic font-serif leading-relaxed line-clamp-3 mb-4">
                          {product.optimized_description || "Pending AI semantic analysis and market fit evaluation..."}
                        </p>
                        
                        <div className="flex flex-wrap gap-1.5 mb-4">
                          {product.tags ? product.tags.map(tag => (
                            <span key={tag} className="text-[9px] font-mono px-1.5 py-0.5 bg-slate-800/50 text-slate-500 border border-slate-800 rounded">#{tag}</span>
                          )) : (
                            <div className="h-4 w-24 bg-slate-800/30 animate-pulse rounded"></div>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        {product.status === ProductStatus.PENDING && (
                          <button 
                            onClick={() => evaluateProduct(product)}
                            disabled={isEvaluating}
                            className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-blue-500 transition-all disabled:opacity-50"
                          >
                            {isEvaluating ? (
                                <>
                                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                  <span>Evaluating...</span>
                                </>
                            ) : (
                                <>
                                  <Zap className="w-3 h-3" />
                                  <span>Run Gemini Review</span>
                                </>
                            )}
                          </button>
                        )}
                        
                        {product.status === ProductStatus.APPROVED && (
                          <>
                            <button 
                              onClick={() => syncToShopify(product)}
                              disabled={isSyncing === product.id}
                              className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-blue-500 transition-all disabled:opacity-50"
                            >
                              {isSyncing === product.id ? "Syncing API..." : (
                                <>
                                  <ShoppingBag className="w-3.5 h-3.5" />
                                  <span>Sync to Shopify</span>
                                </>
                              )}
                            </button>
                            <button className="px-3 bg-slate-800 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all border border-transparent hover:border-red-400/20">
                              <XCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}

                        {product.status === ProductStatus.SYNCED && (
                          <div className="flex-1 flex flex-col gap-2">
                            {product.shopify_url && (
                              <a
                                href={product.shopify_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-center gap-2 bg-slate-800 border border-emerald-500/40 text-emerald-400 py-2 rounded-xl text-[10px] font-mono uppercase font-bold hover:bg-emerald-500/10 transition-all"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>View on Shopify</span>
                              </a>
                            )}
                            <button
                              onClick={() => launchCampaign(product)}
                              className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-emerald-500 transition-all shadow-[0_0_20px_rgba(16,185,129,0.2)]"
                            >
                              <Rocket className="w-3.5 h-3.5" />
                              <span>Launch Meta Ads Campaign</span>
                            </button>
                          </div>
                        )}

                        {product.status === ProductStatus.CAMPAIGN_LIVE && (
                          <div className="flex-1 flex items-center justify-center gap-2 bg-black/40 border border-emerald-500/30 text-emerald-400 py-2.5 rounded-xl text-[10px] font-mono uppercase font-bold">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Campaign Live</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {/* Bottom Table Section */}
            <div className="bento-card !p-6 mb-6">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Trending Database Explorer</h3>
                <div className="flex gap-2">
                  <button className="text-[9px] bg-slate-800 px-2 py-1 rounded border border-slate-700 uppercase font-mono text-slate-400">Export CSV</button>
                  <button className="text-[9px] bg-slate-800 px-2 py-1 rounded border border-slate-700 uppercase font-mono text-slate-400">Refresh</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500 font-mono uppercase text-[9px] border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4">#id</th>
                      <th className="py-3 px-4">product_title</th>
                      <th className="py-3 px-4">trend_score</th>
                      <th className="py-3 px-4">status</th>
                      <th className="py-3 px-4 text-right">operation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 font-mono text-[10px]">
                    {Array.isArray(products) && products.slice(0, 5).map(p => (
                      <tr key={p.id} className="hover:bg-white/[0.02] group transition-colors">
                        <td className="py-3 px-4 text-slate-500">#{p.id.slice(0, 4)}</td>
                        <td className="py-3 px-4 font-semibold text-slate-300 uppercase">{p.optimized_title || p.title}</td>
                        <td className="py-3 px-4 text-emerald-400">{p.trend_score / 100}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded ${
                            p.status === ProductStatus.PENDING ? "bg-amber-500/10 text-amber-500" :
                            p.status === ProductStatus.APPROVED ? "bg-blue-500/10 text-blue-400" :
                            "bg-emerald-500/10 text-emerald-400"
                          }`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button className="text-blue-500 hover:underline">VIEW</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

