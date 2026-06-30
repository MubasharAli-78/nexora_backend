import { PERMISSIONS, ALL_PERMISSION_KEYS, LIGHT_USER_DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './permissions.catalog';
import { buildNavigation, buildFeatureFlags } from './navigation';

describe('permission catalog', () => {
  it('has unique permission keys', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(PERMISSIONS.length);
  });
  it('light_user defaults are all real permissions and read-only-ish', () => {
    for (const key of LIGHT_USER_DEFAULT_PERMISSIONS) {
      expect(ALL_PERMISSION_KEYS).toContain(key);
    }
    expect(LIGHT_USER_DEFAULT_PERMISSIONS).not.toContain('roles.manage');
    expect(LIGHT_USER_DEFAULT_PERMISSIONS).not.toContain('users.invite');
  });
  it('owner role grants ALL', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'owner');
    expect(owner?.permissions).toBe('ALL');
  });
});

describe('navigation', () => {
  it('hides items the user lacks permission for', () => {
    const nav = buildNavigation('light_user', ['dashboard.read', 'products.read']);
    const dash = nav.find((n) => n.key === 'dashboard');
    const settings = nav.find((n) => n.key === 'settings');
    expect(dash?.visible).toBe(true);
    expect(settings?.visible).toBe(false);
    expect(dash?.href).toBe('/light_user/dashboard');
  });
  it('feature flags reflect permissions', () => {
    expect(buildFeatureFlags(['predictions.read']).predictions).toBe(true);
    expect(buildFeatureFlags([]).predictions).toBe(false);
  });
});
