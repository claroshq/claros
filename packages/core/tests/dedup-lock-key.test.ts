/**
 * dedupLockKey regression tests.
 *
 * The advisory-lock key derivation originally sliced raw characters out of
 * the messageId and fed them to BigInt("0x..."), which threw on any non-hex
 * character - turning client-supplied messageIds like "m-1" into 500s on
 * the ingest hot path. These tests pin the hash-based derivation:
 * arbitrary strings must produce a stable bigint.
 */
import { describe, it, expect } from "vitest";
import { dedupLockKey } from "../src/enrollment.js";

const TENANT = "3f2b1a9c-1234-5678-9abc-def012345678";

describe("dedupLockKey", () => {
  it("accepts non-hex messageIds without throwing", () => {
    expect(typeof dedupLockKey(TENANT, "m-1")).toBe("bigint");
    expect(typeof dedupLockKey(TENANT, "order-55-retry")).toBe("bigint");
    expect(typeof dedupLockKey(TENANT, "msg_xyz_!!!")).toBe("bigint");
    expect(typeof dedupLockKey(TENANT, "")).toBe("bigint");
  });

  it("is deterministic for the same input", () => {
    expect(dedupLockKey(TENANT, "m-1")).toBe(dedupLockKey(TENANT, "m-1"));
  });

  it("differs across messageIds and across tenants", () => {
    expect(dedupLockKey(TENANT, "a")).not.toBe(dedupLockKey(TENANT, "b"));
    expect(dedupLockKey(TENANT, "a")).not.toBe(
      dedupLockKey("9f2b1a9c-9999-5678-9abc-def012345678", "a"),
    );
  });

  it("still accepts UUID-shaped messageIds", () => {
    expect(typeof dedupLockKey(TENANT, "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e")).toBe("bigint");
  });
});
