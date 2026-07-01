/** Shared connector contract (doc 05 §2). Every provider normalizes into these shapes. */

export interface NormalizedProductImage {
  externalUrl?: string;
  altText?: string;
  position?: number;
}

export interface NormalizedVariant {
  externalId: string;
  title?: string;
  sku?: string;
  barcode?: string;
  price: number;
  compareAtPrice?: number;
  currency: string;
  position?: number;
}

export interface NormalizedProduct {
  externalSource: string;
  externalId: string;
  externalGraphqlId?: string;
  title: string;
  handle?: string;
  description?: string;
  vendor?: string;
  productType?: string;
  status: 'active' | 'draft' | 'archived';
  tags: string[];
  images: NormalizedProductImage[];
  variants: NormalizedVariant[];
  rawPayload: unknown;
}

export interface NormalizedCustomer {
  externalSource: string;
  externalId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags: string[];
  numberOfOrders?: number;
  amountSpent?: number;
  currency?: string;
  lastOrderAt?: string;
  rawPayload: unknown;
}

export interface NormalizedOrderItem {
  externalLineItemId?: string;
  productExternalId?: string;
  title?: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface NormalizedOrder {
  externalSource: string;
  externalId: string;
  orderNumber: string;
  customerExternalId?: string;
  financialStatus: string;
  fulfillmentStatus: string;
  cancelledAt?: string | null;
  currency: string;
  subtotalAmount: number;
  totalAmount: number;
  discountAmount?: number;
  taxAmount?: number;
  shippingAmount?: number;
  refundAmount?: number;
  paymentMethod?: string | null;
  processedAt: string;
  items: NormalizedOrderItem[];
  rawPayload: unknown;
}

export interface NormalizedInventoryLevel {
  variantExternalId: string;
  locationExternalId: string;
  available: number;
}

export interface ConnectorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface WebhookVerifyInput {
  rawBody: Buffer | string;
  headers: Record<string, string | undefined>;
  secret?: string;
}

export interface WebhookVerifyResult {
  valid: boolean;
  topic?: string;
  externalEventId?: string;
}

export interface ConnectorRateLimitState {
  remaining: number;
  resetAt?: string;
}

export interface ConnectorCredentials {
  accessToken?: string;
  shopDomain?: string;
  apiKey?: string;
  apiSecret?: string;
  [k: string]: unknown;
}

export interface CommerceConnector {
  readonly providerKey: string;
  verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult>;
  listProducts(creds: ConnectorCredentials, cursor?: string): Promise<ConnectorPage<NormalizedProduct>>;
  listCustomers(creds: ConnectorCredentials, cursor?: string): Promise<ConnectorPage<NormalizedCustomer>>;
  listOrders(creds: ConnectorCredentials, cursor?: string): Promise<ConnectorPage<NormalizedOrder>>;
  listInventory(creds: ConnectorCredentials, cursor?: string): Promise<ConnectorPage<NormalizedInventoryLevel>>;
  /** Normalizes a single order webhook payload (e.g. `orders/create`) into the same shape `listOrders` produces. */
  normalizeOrderPayload?(raw: unknown): NormalizedOrder | null;
}
