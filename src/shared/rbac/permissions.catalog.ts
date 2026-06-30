/**
 * Canonical system permission registry (doc 02 §4). Seeded as global rows
 * (tenant_id = null, is_system = true) and used by the RBAC guard / UI.
 */
export interface PermissionDef {
  key: string;
  module: string;
  action: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export const PERMISSIONS: PermissionDef[] = [
  { key: 'dashboard.read', module: 'dashboard', action: 'read', description: 'View dashboard cards, charts, KPIs', riskLevel: 'low' },
  { key: 'analytics.read', module: 'analytics', action: 'read', description: 'View analytics dashboards', riskLevel: 'low' },
  { key: 'analytics.export', module: 'analytics', action: 'export', description: 'Export analytics reports', riskLevel: 'medium' },
  { key: 'products.read', module: 'products', action: 'read', description: 'View products and variants', riskLevel: 'low' },
  { key: 'products.write', module: 'products', action: 'write', description: 'Create/update product metadata', riskLevel: 'medium' },
  { key: 'products.delete', module: 'products', action: 'delete', description: 'Archive/delete product records', riskLevel: 'high' },
  { key: 'customers.read', module: 'customers', action: 'read', description: 'View customer list and profiles', riskLevel: 'medium' },
  { key: 'customers.export', module: 'customers', action: 'export', description: 'Export customers; high-risk PII permission', riskLevel: 'critical' },
  { key: 'customers.manage_segments', module: 'customers', action: 'manage', description: 'Create and update customer segments', riskLevel: 'medium' },
  { key: 'orders.read', module: 'orders', action: 'read', description: 'View orders and order details', riskLevel: 'low' },
  { key: 'orders.refund', module: 'orders', action: 'manage', description: 'Trigger refunds where supported', riskLevel: 'high' },
  { key: 'orders.export', module: 'orders', action: 'export', description: 'Export order data', riskLevel: 'medium' },
  { key: 'inventory.read', module: 'inventory', action: 'read', description: 'View inventory levels', riskLevel: 'low' },
  { key: 'inventory.manage', module: 'inventory', action: 'manage', description: 'Manage reorder rules and manual adjustments', riskLevel: 'medium' },
  { key: 'marketing.read', module: 'marketing', action: 'read', description: 'View campaigns and marketing metrics', riskLevel: 'low' },
  { key: 'marketing.manage', module: 'marketing', action: 'manage', description: 'Create/update campaigns and connectors', riskLevel: 'medium' },
  { key: 'email.read', module: 'email', action: 'read', description: 'View email campaign dashboards', riskLevel: 'low' },
  { key: 'email.manage', module: 'email', action: 'manage', description: 'Create/update flows and templates', riskLevel: 'medium' },
  { key: 'predictions.read', module: 'predictions', action: 'read', description: 'View forecasts and insights', riskLevel: 'low' },
  { key: 'predictions.run', module: 'predictions', action: 'execute', description: 'Run forecast jobs', riskLevel: 'medium' },
  { key: 'predictions.configure', module: 'predictions', action: 'manage', description: 'Change model settings', riskLevel: 'medium' },
  { key: 'ai_copilot.use', module: 'ai', action: 'execute', description: 'Use AI copilot', riskLevel: 'low' },
  { key: 'ai_copilot.admin', module: 'ai', action: 'manage', description: 'Manage AI settings and usage limits', riskLevel: 'medium' },
  { key: 'integrations.read', module: 'integrations', action: 'read', description: 'View connector status', riskLevel: 'low' },
  { key: 'integrations.manage', module: 'integrations', action: 'manage', description: 'Connect/disconnect sources', riskLevel: 'high' },
  { key: 'fraud.read', module: 'fraud', action: 'read', description: 'View risk and fraud alerts', riskLevel: 'low' },
  { key: 'fraud.manage', module: 'fraud', action: 'manage', description: 'Manage fraud rules and review actions', riskLevel: 'high' },
  { key: 'reports.read', module: 'reports', action: 'read', description: 'View generated reports', riskLevel: 'low' },
  { key: 'reports.export', module: 'reports', action: 'export', description: 'Generate/download reports', riskLevel: 'medium' },
  { key: 'billing.read', module: 'billing', action: 'read', description: 'View billing/subscription', riskLevel: 'low' },
  { key: 'billing.manage', module: 'billing', action: 'manage', description: 'Manage billing and plan', riskLevel: 'high' },
  { key: 'users.read', module: 'team', action: 'read', description: 'View team members', riskLevel: 'low' },
  { key: 'users.invite', module: 'team', action: 'create', description: 'Invite users', riskLevel: 'medium' },
  { key: 'users.manage', module: 'team', action: 'manage', description: 'Suspend/remove users', riskLevel: 'high' },
  { key: 'roles.read', module: 'iam', action: 'read', description: 'View roles and permissions', riskLevel: 'low' },
  { key: 'roles.manage', module: 'iam', action: 'manage', description: 'Create/edit roles and toggle permissions', riskLevel: 'critical' },
  { key: 'audit.read', module: 'audit', action: 'read', description: 'View audit logs', riskLevel: 'medium' },
  { key: 'files.read', module: 'files', action: 'read', description: 'View tenant files', riskLevel: 'low' },
  { key: 'files.write', module: 'files', action: 'write', description: 'Upload/update tenant files', riskLevel: 'medium' },
  { key: 'files.delete', module: 'files', action: 'delete', description: 'Delete files', riskLevel: 'high' },
  { key: 'profile.read', module: 'profile', action: 'read', description: 'View own profile', riskLevel: 'low' },
  { key: 'profile.write', module: 'profile', action: 'write', description: 'Update own profile', riskLevel: 'low' },
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** Default permissions granted to the seeded `light_user` role (owner gets everything). */
export const LIGHT_USER_DEFAULT_PERMISSIONS = [
  'dashboard.read',
  'products.read',
  'customers.read',
  'orders.read',
  'analytics.read',
  'predictions.read',
  'reports.read',
  'files.read',
  'profile.read',
  'profile.write',
  'users.read',
];

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  isDefault: boolean;
  permissions: string[] | 'ALL';
}

export const SYSTEM_ROLES: RoleDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full tenant administrator. Can manage everything.',
    isSystem: true,
    isDefault: false,
    permissions: 'ALL',
  },
  {
    key: 'light_user',
    name: 'Light User',
    description: 'Limited read access. Owner can grant additional permissions.',
    isSystem: true,
    isDefault: true,
    permissions: LIGHT_USER_DEFAULT_PERMISSIONS,
  },
];
