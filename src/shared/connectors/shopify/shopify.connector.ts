import { createHmac, timingSafeEqual } from 'crypto';
import type {
  CommerceConnector,
  ConnectorCredentials,
  ConnectorPage,
  NormalizedCustomer,
  NormalizedInventoryLevel,
  NormalizedOrder,
  NormalizedProduct,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from '../connector.interface';

const DEFAULT_API_VERSION = '2024-10';

/** In-memory token cache (per shop+clientId). Tokens from the client_credentials grant are short-lived. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Shopify connector. Webhook HMAC verification is fully implemented. The list*
 * methods call the Shopify Admin REST API and normalize results.
 *
 * Authentication resolves in this order:
 *   1. `creds.accessToken` (a stored shpat_… token), else
 *   2. the OAuth `client_credentials` grant using `clientId` + `clientSecret`
 *      (from creds, falling back to SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env),
 *   3. otherwise an empty page is returned so the framework stays exercisable.
 *
 * `shopDomain` and `apiVersion` likewise fall back to SHOPIFY_SHOP_DOMAIN /
 * SHOPIFY_API_VERSION env when absent from creds.
 */
export class ShopifyConnector implements CommerceConnector {
  readonly providerKey = 'shopify';

  async verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
    const signature = input.headers['x-shopify-hmac-sha256'];
    const topic = input.headers['x-shopify-topic'];
    const externalEventId = input.headers['x-shopify-webhook-id'];
    if (!signature || !input.secret) return { valid: false, topic, externalEventId };
    const digest = createHmac('sha256', input.secret)
      .update(typeof input.rawBody === 'string' ? Buffer.from(input.rawBody) : input.rawBody)
      .digest('base64');
    let valid = false;
    try {
      valid = timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
    } catch {
      valid = false;
    }
    return { valid, topic, externalEventId };
  }

  private shopDomain(creds: ConnectorCredentials): string | undefined {
    return (creds.shopDomain as string) || process.env.SHOPIFY_SHOP_DOMAIN || undefined;
  }

  private apiVersion(creds: ConnectorCredentials): string {
    return (creds.apiVersion as string) || process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  }

  /**
   * Resolve an Admin API access token. Prefers a stored token; otherwise performs
   * the Shopify `client_credentials` OAuth grant (the flow used by custom apps
   * with client id/secret) and caches the result until just before expiry.
   */
  private async resolveAccessToken(creds: ConnectorCredentials): Promise<string | null> {
    if (creds.accessToken) return creds.accessToken as string;

    const shopDomain = this.shopDomain(creds);
    const clientId = (creds.clientId as string) || process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = (creds.clientSecret as string) || process.env.SHOPIFY_CLIENT_SECRET;
    if (!shopDomain || !clientId || !clientSecret) return null;

    const cacheKey = `${shopDomain}:${clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

    const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token grant ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Shopify token grant returned no access_token');

    tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 86_399) * 1000 });
    return data.access_token;
  }

  /** Extract the `rel="next"` URL from a Shopify REST `Link` header, if present. */
  private nextLink(linkHeader: string | null): string {
    if (!linkHeader) return '';
    for (const part of linkHeader.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return '';
  }

  /**
   * Fetch EVERY page of a Shopify REST list endpoint by following the cursor in the
   * `Link: …; rel="next"` response header. Without this the sync only ever captured
   * the first 100 records, so stores with more customers/orders/products were
   * silently truncated. `key` is the JSON root array (e.g. 'customers').
   */
  private async fetchAllItems(creds: ConnectorCredentials, firstPath: string, key: string): Promise<any[]> {
    const shopDomain = this.shopDomain(creds);
    const accessToken = await this.resolveAccessToken(creds);
    if (!shopDomain || !accessToken) return [];

    let url = `https://${shopDomain}/admin/api/${this.apiVersion(creds)}/${firstPath}`;
    const out: any[] = [];
    let pages = 0;
    // Safety cap: 250/page × 200 pages = 50k records — well beyond any normal store.
    while (url && pages < 200) {
      pages++;
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const items = data?.[key];
      if (Array.isArray(items)) out.push(...items);
      // The next-page URL already carries page_info + limit; fetch it verbatim.
      url = this.nextLink(res.headers.get('link'));
    }
    return out;
  }

  async listProducts(creds: ConnectorCredentials): Promise<ConnectorPage<NormalizedProduct>> {
    const products = await this.fetchAllItems(creds, 'products.json?limit=250', 'products');
    if (!products.length) return { items: [] };
    return {
      items: products.map((p: any): NormalizedProduct => ({
        externalSource: 'shopify',
        externalId: String(p.id),
        externalGraphqlId: p.admin_graphql_api_id,
        title: p.title,
        handle: p.handle,
        description: p.body_html,
        vendor: p.vendor,
        productType: p.product_type,
        status: (p.status as NormalizedProduct['status']) ?? 'active',
        tags: typeof p.tags === 'string' ? p.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
        images: (p.images ?? []).map((img: any, i: number) => ({ externalUrl: img.src, altText: img.alt, position: img.position ?? i })),
        variants: (p.variants ?? []).map((v: any, i: number) => ({
          externalId: String(v.id),
          title: v.title,
          sku: v.sku,
          barcode: v.barcode,
          price: Number(v.price ?? 0),
          compareAtPrice: v.compare_at_price ? Number(v.compare_at_price) : undefined,
          currency: 'USD',
          position: v.position ?? i,
        })),
        rawPayload: p,
      })),
    };
  }

  async listCustomers(creds: ConnectorCredentials): Promise<ConnectorPage<NormalizedCustomer>> {
    const customers = await this.fetchAllItems(creds, 'customers.json?limit=250', 'customers');
    if (!customers.length) return { items: [] };
    return {
      items: customers.map((c: any): NormalizedCustomer => ({
        externalSource: 'shopify',
        externalId: String(c.id),
        firstName: c.first_name,
        lastName: c.last_name,
        email: c.email,
        phone: c.phone,
        tags: typeof c.tags === 'string' ? c.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
        numberOfOrders: c.orders_count,
        amountSpent: c.total_spent ? Number(c.total_spent) : 0,
        currency: c.currency,
        rawPayload: c,
      })),
    };
  }

  async listOrders(creds: ConnectorCredentials): Promise<ConnectorPage<NormalizedOrder>> {
    const orders = await this.fetchAllItems(creds, 'orders.json?status=any&limit=250', 'orders');
    if (!orders.length) return { items: [] };
    return { items: orders.map((o: any) => this.mapOrder(o)) };
  }

  async listInventory(): Promise<ConnectorPage<NormalizedInventoryLevel>> {
    return { items: [] };
  }

  /** Normalizes a single Shopify order webhook payload (`orders/create`, `orders/updated`, ...) using the same mapping as `listOrders`. */
  normalizeOrderPayload(raw: unknown): NormalizedOrder | null {
    if (!raw || typeof raw !== 'object' || !(raw as { id?: unknown }).id) return null;
    return this.mapOrder(raw as any);
  }

  private mapOrder(o: any): NormalizedOrder {
    return {
      externalSource: 'shopify',
      externalId: String(o.id),
      orderNumber: String(o.order_number ?? o.name),
      customerExternalId: o.customer ? String(o.customer.id) : undefined,
      financialStatus: o.financial_status ?? 'pending',
      fulfillmentStatus: o.fulfillment_status ?? 'unfulfilled',
      cancelledAt: o.cancelled_at ?? null,
      currency: o.currency ?? 'USD',
      subtotalAmount: Number(o.subtotal_price ?? 0),
      totalAmount: Number(o.total_price ?? 0),
      discountAmount: Number(o.total_discounts ?? 0),
      taxAmount: Number(o.total_tax ?? 0),
      shippingAmount: (o.shipping_lines ?? []).reduce((a: number, s: any) => a + Number(s.price ?? 0), 0),
      refundAmount: (o.refunds ?? []).reduce(
        (a: number, r: any) => a + (r.transactions ?? []).reduce((ta: number, tr: any) => ta + Number(tr.amount ?? 0), 0),
        0,
      ),
      paymentMethod: o.payment_gateway_names?.[0] ?? o.gateway ?? null,
      processedAt: o.processed_at ?? o.created_at,
      items: (o.line_items ?? []).map((li: any) => ({
        externalLineItemId: String(li.id),
        productExternalId: li.product_id != null ? String(li.product_id) : undefined,
        title: li.title,
        sku: li.sku,
        quantity: li.quantity,
        unitPrice: Number(li.price ?? 0),
        total: Number(li.price ?? 0) * (li.quantity ?? 1),
      })),
      rawPayload: o,
    };
  }
}
