/** Maps the authenticated user's permissions + role to the sidebar navigation the
 *  frontend should render. `role` drives the URL prefix (UX only — never authz). */

interface NavDef {
  key: string;
  label: string;
  path: string; // appended after /{role}/dashboard root
  permission: string;
}

const NAV: NavDef[] = [
  { key: 'dashboard', label: 'Dashboard', path: '', permission: 'dashboard.read' },
  { key: 'products', label: 'Products', path: '/products', permission: 'products.read' },
  { key: 'customers', label: 'Customers', path: '/customer', permission: 'customers.read' },
  { key: 'orders', label: 'Orders', path: '/orders', permission: 'orders.read' },
  { key: 'inventory', label: 'Inventory', path: '/inventory', permission: 'inventory.read' },
  { key: 'analytics', label: 'Analytics', path: '/analytics', permission: 'analytics.read' },
  { key: 'ai-intelligence', label: 'AI Intelligence', path: '/ai-intelligence', permission: 'predictions.read' },
  { key: 'prediction', label: 'Prediction', path: '/prediction', permission: 'predictions.read' },
  { key: 'campaigns', label: 'Campaigns', path: '/campaigns', permission: 'marketing.read' },
  { key: 'email-marketing', label: 'Email Marketing', path: '/email-marketing', permission: 'email.read' },
  { key: 'detection', label: 'Detection', path: '/detection', permission: 'fraud.read' },
  { key: 'reports', label: 'Reports', path: '/reports', permission: 'reports.read' },
  { key: 'settings', label: 'Settings', path: '/settings', permission: 'roles.read' },
  { key: 'account-settings', label: 'Account Settings', path: '/account-settings', permission: 'users.read' },
  { key: 'profile', label: 'Profile', path: '/profile', permission: 'profile.read' },
];

export interface NavItem {
  key: string;
  label: string;
  href: string;
  visible: boolean;
}

export function buildNavigation(role: string, permissions: string[]): NavItem[] {
  const granted = new Set(permissions);
  const roleSegment = role || 'user';
  return NAV.map((n) => ({
    key: n.key,
    label: n.label,
    href: `/${roleSegment}/dashboard${n.path}`,
    visible: granted.has(n.permission),
  }));
}

export function buildFeatureFlags(permissions: string[]): Record<string, boolean> {
  const granted = new Set(permissions);
  return {
    predictions: granted.has('predictions.read'),
    connectors: granted.has('integrations.read'),
    marketing: granted.has('marketing.read'),
    fraud: granted.has('fraud.read'),
    files: granted.has('files.read'),
  };
}
