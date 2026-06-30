import { Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import type { CommerceConnector } from './connector.interface';
import { ShopifyConnector } from './shopify/shopify.connector';
import { WooCommerceConnector, AmazonConnector } from './stubs.connectors';

@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, CommerceConnector>();

  constructor() {
    [new ShopifyConnector(), new WooCommerceConnector(), new AmazonConnector()].forEach((c) =>
      this.connectors.set(c.providerKey, c),
    );
  }

  get(providerKey: string): CommerceConnector {
    const c = this.connectors.get(providerKey);
    if (!c) throw new NotFoundException({ code: 'provider_unsupported', message: `No connector for provider '${providerKey}'` });
    return c;
  }

  has(providerKey: string): boolean {
    return this.connectors.has(providerKey);
  }

  keys(): string[] {
    return [...this.connectors.keys()];
  }
}

@Global()
@Module({
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
