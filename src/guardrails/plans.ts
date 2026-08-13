import { getEnv } from '../config/env';

export type SubscriptionPlan = 'starter' | 'growth' | 'enterprise';
export type InventoryAnalyticsLevel = 'basic' | 'advanced' | 'advanced_plus';
export type PurchaseOrderLevel = 'none' | 'basic' | 'full';

export interface PlanFeatures {
  max_stores: number;
  max_products: number;
  max_orders_per_month: number;
  max_customers: number;
  stock_tracking: boolean;
  bulk_updates: boolean;
  stock_movement_history: boolean;
  low_stock_alerts: boolean;
  inventory_analytics: InventoryAnalyticsLevel;
  purchase_orders: PurchaseOrderLevel;
  product_variants: boolean;
  multi_location_inventory: boolean;
  smart_restocking: boolean;
  audit_logs: boolean;
  custom_integrations: boolean;
  whatsapp_support: boolean;
}

export const DEFAULT_PLAN_FEATURES: Record<SubscriptionPlan, PlanFeatures> = {
  starter: {
    max_stores: 1,
    max_products: 50,
    max_orders_per_month: 100,
    max_customers: 200,
    stock_tracking: true,
    bulk_updates: false,
    stock_movement_history: false,
    low_stock_alerts: false,
    inventory_analytics: 'basic',
    purchase_orders: 'none',
    product_variants: false,
    multi_location_inventory: false,
    smart_restocking: false,
    audit_logs: false,
    custom_integrations: false,
    whatsapp_support: false,
  },
  growth: {
    max_stores: 10,
    max_products: 500,
    max_orders_per_month: 1000,
    max_customers: 2000,
    stock_tracking: true,
    bulk_updates: true,
    stock_movement_history: true,
    low_stock_alerts: true,
    inventory_analytics: 'advanced',
    purchase_orders: 'basic',
    product_variants: false,
    multi_location_inventory: false,
    smart_restocking: false,
    audit_logs: false,
    custom_integrations: false,
    whatsapp_support: false,
  },
  enterprise: {
    max_stores: -1,
    max_products: -1,
    max_orders_per_month: -1,
    max_customers: -1,
    stock_tracking: true,
    bulk_updates: true,
    stock_movement_history: true,
    low_stock_alerts: true,
    inventory_analytics: 'advanced_plus',
    purchase_orders: 'full',
    product_variants: true,
    multi_location_inventory: true,
    smart_restocking: true,
    audit_logs: true,
    custom_integrations: true,
    whatsapp_support: true,
  },
};

function loadOverrides(): Partial<
  Record<SubscriptionPlan, Partial<PlanFeatures>>
> {
  const raw = getEnv().PLAN_LIMITS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<
      Record<SubscriptionPlan, Partial<PlanFeatures>>
    >;
  } catch {
    return {};
  }
}

export function getPlanFeatures(plan: SubscriptionPlan): PlanFeatures {
  const base = DEFAULT_PLAN_FEATURES[plan];
  const overrides = loadOverrides()[plan];
  return { ...base, ...overrides };
}

export function isUnlimited(limit: number): boolean {
  return limit < 0;
}

/** Soft warning when usage >= 80% of limit */
export function usageWarning(
  used: number,
  limit: number
): string | null {
  if (isUnlimited(limit) || limit === 0) return null;
  const ratio = used / limit;
  if (ratio >= 1) {
    return `Limit reached (${used}/${limit}). Upgrade your plan to continue.`;
  }
  if (ratio >= 0.8) {
    return `Approaching limit (${used}/${limit}). Consider upgrading soon.`;
  }
  return null;
}

export function assertWithinLimit(
  used: number,
  limit: number,
  label: string
): { ok: true } | { ok: false; message: string } {
  if (isUnlimited(limit)) return { ok: true };
  if (used >= limit) {
    return {
      ok: false,
      message: `${label} limit reached (${used}/${limit}). Upgrade required.`,
    };
  }
  return { ok: true };
}

export function yearlyPriceFromMonthly(
  monthlyNaira: number,
  discountBps: number
): number {
  const annual = monthlyNaira * 12;
  const discount = Math.round((annual * discountBps) / 10_000);
  return annual - discount;
}
