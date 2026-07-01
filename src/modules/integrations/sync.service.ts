import { Injectable, Logger } from '@nestjs/common';
import type { TenantIntegration } from '@prisma/client';
import { PrismaService, TxClient } from '../../shared/database/prisma.service';
import { ConnectorRegistry } from '../../shared/connectors/connector-registry';
import { FieldEncryptionService } from '../../shared/security/field-encryption.service';
import type { ConnectorCredentials } from '../../shared/connectors/connector.interface';
import { RequestContext } from '../../common/context/request-context';

interface SyncCounters {
  read: number;
  created: number;
  updated: number;
  failed: number;
}

/**
 * Inline commerce sync (doc 05/06). Pulls products/customers/orders from a
 * connector and upserts canonical rows + external_object_mappings, writing a
 * sync_runs record. Runs synchronously here; in production this is the body of
 * the connector-sync worker job.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async runSync(ctx: RequestContext, integrationId: string, syncType: 'products' | 'customers' | 'orders' | 'full') {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const integration = await tx.tenantIntegration.findFirst({
        where: { id: integrationId, tenantId: ctx.tenantId },
        include: { provider: true, credentials: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!integration) {
        return { error: 'integration_not_found' };
      }
      const providerKey = integration.provider.key;
      const storeId = integration.storeId;
      const creds = this.decryptCreds(integration.credentials[0]?.encryptedSecretJson);

      const run = await tx.syncRun.create({
        data: { tenantId: ctx.tenantId, storeId, integrationId, syncType, status: 'running', startedAt: new Date() },
      });

      const counters: SyncCounters = { read: 0, created: 0, updated: 0, failed: 0 };
      try {
        if (!storeId) throw new Error('Integration has no store to sync into');
        const connector = this.registry.get(providerKey);

        if (syncType === 'products' || syncType === 'full') {
          const page = await connector.listProducts(creds);
          for (const p of page.items) await this.upsertProduct(tx, ctx.tenantId, storeId, integrationId, p, counters);
        }
        if (syncType === 'customers' || syncType === 'full') {
          const page = await connector.listCustomers(creds);
          for (const c of page.items) await this.upsertCustomer(tx, ctx.tenantId, storeId, integrationId, c, counters);
        }
        if (syncType === 'orders' || syncType === 'full') {
          const page = await connector.listOrders(creds);
          for (const o of page.items) await this.upsertOrder(tx, ctx.tenantId, storeId, integrationId, o, counters);
        }

        await tx.syncRun.update({
          where: { id: run.id },
          data: { status: 'success', finishedAt: new Date(), recordsRead: counters.read, recordsCreated: counters.created, recordsUpdated: counters.updated, recordsFailed: counters.failed },
        });
        await tx.tenantIntegration.update({ where: { id: integrationId }, data: { lastSyncAt: new Date(), status: 'connected' } });
        return { runId: run.id, status: 'success', ...counters };
      } catch (err) {
        this.logger.error(`Sync failed for ${integrationId}: ${(err as Error).message}`);
        await tx.syncRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), errorMessage: (err as Error).message, ...{ recordsRead: counters.read, recordsCreated: counters.created, recordsUpdated: counters.updated, recordsFailed: counters.failed } } });
        await tx.tenantIntegration.update({ where: { id: integrationId }, data: { status: 'error' } });
        return { runId: run.id, status: 'failed', error: (err as Error).message };
      }
    });
  }

  /**
   * Processes a single order webhook payload (`orders/create`, `orders/updated`, ...) into the
   * canonical `Order` row, bypassing the manual/queued full sync path. `integration` must already
   * be resolved (by external shop domain) and have signature verification passed.
   */
  async processOrderWebhook(providerKey: string, integration: TenantIntegration, payload: unknown) {
    if (!integration.storeId) return { status: 'no_store' };
    const connector = this.registry.get(providerKey);
    if (!connector.normalizeOrderPayload) return { status: 'unsupported' };
    const normalized = connector.normalizeOrderPayload(payload);
    if (!normalized) return { status: 'invalid_payload' };

    const counters: SyncCounters = { read: 0, created: 0, updated: 0, failed: 0 };
    await this.prisma.withTenantContext(
      { tenantId: integration.tenantId, userId: '', membershipId: '' },
      (tx) => this.upsertOrder(tx, integration.tenantId, integration.storeId as string, integration.id, normalized, counters),
    );
    return { status: 'processed', ...counters };
  }

  private decryptCreds(encrypted: unknown): ConnectorCredentials {
    if (!encrypted || typeof encrypted !== 'object') return {};
    const out: ConnectorCredentials = {};
    for (const [k, v] of Object.entries(encrypted as Record<string, string>)) {
      out[k] = typeof v === 'string' ? this.encryption.decrypt(v) ?? v : v;
    }
    return out;
  }

  private async upsertProduct(tx: TxClient, tenantId: string, storeId: string, integrationId: string, p: any, c: SyncCounters) {
    c.read++;
    const existing = await tx.product.findFirst({ where: { tenantId, storeId, externalSource: p.externalSource, externalId: p.externalId } });
    const data = {
      tenantId, storeId, externalSource: p.externalSource, externalId: p.externalId, externalGraphqlId: p.externalGraphqlId,
      title: p.title, handle: p.handle, description: p.description, vendor: p.vendor, productType: p.productType,
      status: p.status, tagsJson: p.tags ?? [], featuredImageUrl: p.images?.[0]?.externalUrl ?? null, rawPayloadJson: p.rawPayload as object,
    };
    const product = existing
      ? (c.updated++, await tx.product.update({ where: { id: existing.id }, data }))
      : (c.created++, await tx.product.create({ data }));

    for (const v of p.variants ?? []) {
      const ev = await tx.productVariant.findFirst({ where: { tenantId, storeId, externalId: v.externalId } });
      const vdata = { tenantId, storeId, productId: product.id, externalId: v.externalId, title: v.title, sku: v.sku, barcode: v.barcode, priceAmount: v.price, compareAtPriceAmount: v.compareAtPrice ?? null, currency: v.currency ?? 'USD', position: v.position ?? 0, rawPayloadJson: v as object };
      if (ev) await tx.productVariant.update({ where: { id: ev.id }, data: vdata });
      else await tx.productVariant.create({ data: vdata });
    }
    await this.mapExternal(tx, tenantId, storeId, integrationId, 'product', p.externalId, p.externalGraphqlId, 'products', product.id);
  }

  private async upsertCustomer(tx: TxClient, tenantId: string, storeId: string, integrationId: string, cust: any, c: SyncCounters) {
    c.read++;
    const existing = await tx.commerceCustomer.findFirst({ where: { tenantId, storeId, externalSource: cust.externalSource, externalId: cust.externalId } });
    const data = {
      tenantId, storeId, externalSource: cust.externalSource, externalId: cust.externalId, firstName: cust.firstName, lastName: cust.lastName,
      displayName: [cust.firstName, cust.lastName].filter(Boolean).join(' ') || null,
      emailEncrypted: this.encryption.encrypt(cust.email), emailHash: this.encryption.blindHash(cust.email),
      phoneEncrypted: this.encryption.encrypt(cust.phone), tagsJson: cust.tags ?? [], numberOfOrders: cust.numberOfOrders ?? 0,
      amountSpent: cust.amountSpent ?? 0, currency: cust.currency ?? 'USD', lastOrderAt: cust.lastOrderAt ? new Date(cust.lastOrderAt) : null, rawPayloadJson: cust.rawPayload as object,
    };
    const saved = existing ? (c.updated++, await tx.commerceCustomer.update({ where: { id: existing.id }, data })) : (c.created++, await tx.commerceCustomer.create({ data }));
    await this.mapExternal(tx, tenantId, storeId, integrationId, 'customer', cust.externalId, undefined, 'commerce_customers', saved.id);
  }

  private async upsertOrder(tx: TxClient, tenantId: string, storeId: string, integrationId: string, o: any, c: SyncCounters) {
    c.read++;
    const existing = await tx.order.findFirst({ where: { tenantId, storeId, externalSource: o.externalSource, externalId: o.externalId } });
    let customerId: string | null = null;
    if (o.customerExternalId) {
      const cust = await tx.commerceCustomer.findFirst({ where: { tenantId, storeId, externalId: o.customerExternalId } });
      customerId = cust?.id ?? null;
    }
    const data = {
      tenantId, storeId, customerId, externalSource: o.externalSource, externalId: o.externalId, orderNumber: o.orderNumber,
      financialStatus: o.financialStatus, fulfillmentStatus: o.fulfillmentStatus,
      orderStatus: deriveOrderStatus(o.financialStatus, o.fulfillmentStatus, o.cancelledAt),
      currency: o.currency, subtotalAmount: o.subtotalAmount, totalAmount: o.totalAmount,
      discountAmount: o.discountAmount ?? 0, taxAmount: o.taxAmount ?? 0,
      shippingAmount: o.shippingAmount ?? 0, refundAmount: o.refundAmount ?? 0,
      paymentMethod: o.paymentMethod ?? null,
      processedAt: o.processedAt ? new Date(o.processedAt) : null, rawPayloadJson: o.rawPayload as object,
    };
    const order = existing ? (c.updated++, await tx.order.update({ where: { id: existing.id }, data })) : (c.created++, await tx.order.create({ data }));
    await tx.orderItem.deleteMany({ where: { orderId: order.id, tenantId } });
    if (o.items?.length) {
      // Resolve each line item's local productId (+ productType) from its Shopify
      // product id so analytics/recommendations can join order_items → products.
      const extIds = [...new Set(o.items.map((li: any) => li.productExternalId).filter(Boolean))] as string[];
      const products = extIds.length
        ? await tx.product.findMany({ where: { tenantId, storeId, externalId: { in: extIds } }, select: { id: true, externalId: true, productType: true } })
        : [];
      const byExt = new Map(products.map((p) => [p.externalId, p]));
      await tx.orderItem.createMany({
        data: o.items.map((li: any) => {
          const prod = li.productExternalId ? byExt.get(li.productExternalId) : undefined;
          return {
            tenantId, storeId, orderId: order.id,
            productId: prod?.id ?? null,
            productType: prod?.productType ?? null,
            externalLineItemId: li.externalLineItemId, title: li.title, sku: li.sku,
            quantity: li.quantity ?? 1, unitPriceAmount: li.unitPrice ?? 0, totalAmount: li.total ?? 0,
          };
        }),
      });
    }
    await this.mapExternal(tx, tenantId, storeId, integrationId, 'order', o.externalId, undefined, 'orders', order.id);
  }

  private async mapExternal(tx: TxClient, tenantId: string, storeId: string, integrationId: string, objectType: string, externalId: string, externalGraphqlId: string | undefined, localTable: string, localId: string) {
    const existing = await tx.externalObjectMapping.findFirst({ where: { tenantId, integrationId, objectType, externalId } });
    if (existing) {
      await tx.externalObjectMapping.update({ where: { id: existing.id }, data: { localId, externalGraphqlId } });
    } else {
      await tx.externalObjectMapping.create({ data: { tenantId, storeId, integrationId, objectType, externalId, externalGraphqlId, localTable, localId } });
    }
  }
}

/**
 * Derive a single dashboard "order status" from Shopify's separate financial +
 * fulfillment statuses (Shopify has no single order-status field).
 */
function deriveOrderStatus(financialStatus?: string, fulfillmentStatus?: string, cancelledAt?: string | null): string {
  if (cancelledAt) return 'cancelled';
  if (financialStatus === 'refunded' || financialStatus === 'voided') return 'cancelled';
  if (fulfillmentStatus === 'fulfilled') return 'delivered';
  if (fulfillmentStatus === 'partial' || fulfillmentStatus === 'in_transit') return 'shipped';
  return 'processing';
}
