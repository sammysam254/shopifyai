export enum ProductStatus {
  PENDING = "pending_review",
  APPROVED = "approved",
  SYNCED = "synced_to_shopify",
  CAMPAIGN_LIVE = "campaign_live",
  REJECTED = "rejected"
}

export interface TrendingProduct {
  id: string;
  title: string;
  image_url: string;
  source_country: string;
  trend_score: number;
  status: ProductStatus;
  optimized_title?: string;
  optimized_description?: string;
  tags?: string[];
  shopify_url?: string;
  created_at: string;
}

export interface EvaluationResult {
  suitable: boolean;
  reason: string;
  optimized_title: string;
  optimized_description: string;
  tags: string[];
}
