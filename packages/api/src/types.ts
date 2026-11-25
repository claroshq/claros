/**
 * Shared TypeScript augmentations and types for the API layer.
 */
// ---------------------------------------------------------------------------
// Role system
// ---------------------------------------------------------------------------

/** The two roles in MVP. Order matters: owner > member. */
export type UserRole = "owner" | "member";

/** Instance-wide role. Instance admins act on every product as owner. */
export type InstanceRole = "admin";

/** Numeric weight for comparison. Higher = more privilege. */
const ROLE_WEIGHT: Record<UserRole, number> = { owner: 2, member: 1 };

/** Returns true if `actual` role meets or exceeds `required`. */
export function roleSatisfies(actual: UserRole, required: UserRole): boolean {
  return ROLE_WEIGHT[actual] >= ROLE_WEIGHT[required];
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/**
 * Tenant context attached to every authenticated request.
 * Populated by the tenant resolution plugin.
 * Only present after auth middleware runs; routes that require a tenant
 * must be registered under the authenticated scope.
 */
export interface TenantContext {
  id: string;
  slug: string;
  /** The authenticated user's ID. */
  userId: string;
  /** The authenticated user's role in this product ("owner" for instance admins). */
  userRole: UserRole;
  /** The user's instance-wide role, or null. */
  instanceRole: InstanceRole | null;
  /** True when the product is archived (reads allowed, writes answer 409). */
  archived: boolean;
}
