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
  imageUrl: string;
  sourceCountry: string;
  trendScore: number;
  status: ProductStatus;
  optimizedTitle?: string;
  optimizedDescription?: string;
  tags?: string[];
  shopifyUrl?: string;
  createdAt: string;
}

export interface EvaluationResult {
  suitable: boolean;
  reason: string;
  optimizedTitle: string;
  optimizedDescription: string;
  tags: string[];
}
