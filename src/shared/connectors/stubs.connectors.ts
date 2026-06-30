import type {
  CommerceConnector,
  ConnectorPage,
  NormalizedCustomer,
  NormalizedInventoryLevel,
  NormalizedOrder,
  NormalizedProduct,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from './connector.interface';

const empty = <T>(): Promise<ConnectorPage<T>> => Promise.resolve({ items: [] });

/** WooCommerce adapter stub — interface-complete; REST ingestion to be implemented. */
export class WooCommerceConnector implements CommerceConnector {
  readonly providerKey = 'woocommerce';
  async verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
    return { valid: Boolean(input.secret), topic: input.headers['x-wc-webhook-topic'] };
  }
  listProducts() { return empty<NormalizedProduct>(); }
  listCustomers() { return empty<NormalizedCustomer>(); }
  listOrders() { return empty<NormalizedOrder>(); }
  listInventory() { return empty<NormalizedInventoryLevel>(); }
}

/** Amazon SP-API adapter stub — interface-complete; ingestion to be implemented. */
export class AmazonConnector implements CommerceConnector {
  readonly providerKey = 'amazon';
  async verifyWebhook(): Promise<WebhookVerifyResult> {
    return { valid: false };
  }
  listProducts() { return empty<NormalizedProduct>(); }
  listCustomers() { return empty<NormalizedCustomer>(); }
  listOrders() { return empty<NormalizedOrder>(); }
  listInventory() { return empty<NormalizedInventoryLevel>(); }
}
