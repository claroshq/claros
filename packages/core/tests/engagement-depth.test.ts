/**
 * Unit tests for engagement depth computation (pure logic, no I/O).
 *
 * Tests:
 * - computeMinCohortSize: floor(1 / power_user_percentile)
 * - computeRegularThreshold: ceil(window_days / natural_frequency_days)
 * - assignEngagementDepth: all bucket boundaries
 * - Small cohort floor: power bucket suppressed when cohort below minimum
 * - Zero events returns null (no depth assignment)
 * - Edge values: exactly at each boundary
 */
import { describe, it, expect } from "vitest";
import {
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
  type LifecycleConfig,
} from "../src/lifecycle/index.js";

// ---------------------------------------------------------------------------
// computeMinCohortSize
// ---------------------------------------------------------------------------

describe("computeMinCohortSize", () => {
  it("returns 10 for default power_user_percentile of 0.1", () => {
    expect(computeMinCohortSize(LIFECYCLE_DEFAULTS)).toBe(10);
  });

  it("returns 20 for power_user_percentile of 0.05", () => {
    const config = resolveLifecycleConfig({ power_user_percentile: 0.05 });
    expect(computeMinCohortSize(config)).toBe(20);
  });

  it("returns 4 for power_user_percentile of 0.25", () => {
    const config = resolveLifecycleConfig({ power_user_percentile: 0.25 });
    expect(computeMinCohortSize(config)).toBe(4);
  });

  it("returns 5 for power_user_percentile of 0.2", () => {
    const config = resolveLifecycleConfig({ power_user_percentile: 0.2 });
    expect(computeMinCohortSize(config)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// computeRegularThreshold
// ---------------------------------------------------------------------------

describe("computeRegularThreshold", () => {
  it("returns 5 for default config (window=30, frequency=7): ceil(30/7)=5", () => {
    expect(computeRegularThreshold(LIFECYCLE_DEFAULTS)).toBe(5);
  });

  it("returns 5 for window=30, frequency=7 explicitly", () => {
    const config = resolveLifecycleConfig({
      engagement_depth_window_days: 30,
      natural_frequency_days: 7,
    });
    expect(computeRegularThreshold(config)).toBe(5);
  });

  it("returns 10 for window=30, frequency=3: ceil(30/3)=10", () => {
    const config = resolveLifecycleConfig({
      engagement_depth_window_days: 30,
      natural_frequency_days: 3,
    });
    expect(computeRegularThreshold(config)).toBe(10);
  });

  it("returns 2 for window=14, frequency=7: ceil(14/7)=2", () => {
    const config = resolveLifecycleConfig({
      engagement_depth_window_days: 14,
      natural_frequency_days: 7,
    });
    expect(computeRegularThreshold(config)).toBe(2);
  });

  it("returns 3 for window=20, frequency=7: ceil(20/7)=3", () => {
    const config = resolveLifecycleConfig({
      engagement_depth_window_days: 20,
      natural_frequency_days: 7,
    });
    expect(computeRegularThreshold(config)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// assignEngagementDepth - zero and null cases
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - zero events", () => {
  const regularThreshold = computeRegularThreshold(LIFECYCLE_DEFAULTS);

  it("returns null for 0 events", () => {
    expect(
      assignEngagementDepth({
        eventCount: 0,
        powerCutoff: 10,
        regularThreshold,
      }),
    ).toBeNull();
  });

  it("returns null for negative event count (defensive)", () => {
    expect(
      assignEngagementDepth({
        eventCount: -1,
        powerCutoff: 10,
        regularThreshold,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assignEngagementDepth - minimal bucket (1-2 events)
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - minimal bucket", () => {
  const regularThreshold = computeRegularThreshold(LIFECYCLE_DEFAULTS); // 5

  it("assigns minimal for 1 event", () => {
    expect(
      assignEngagementDepth({ eventCount: 1, powerCutoff: 20, regularThreshold }),
    ).toBe("minimal");
  });

  it("assigns minimal for 2 events", () => {
    expect(
      assignEngagementDepth({ eventCount: 2, powerCutoff: 20, regularThreshold }),
    ).toBe("minimal");
  });
});

// ---------------------------------------------------------------------------
// assignEngagementDepth - casual bucket (3 to regularThreshold-1)
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - casual bucket", () => {
  const regularThreshold = computeRegularThreshold(LIFECYCLE_DEFAULTS); // 5

  it("assigns casual for 3 events", () => {
    expect(
      assignEngagementDepth({ eventCount: 3, powerCutoff: 20, regularThreshold }),
    ).toBe("casual");
  });

  it("assigns casual for 4 events (regularThreshold-1 = 4)", () => {
    expect(
      assignEngagementDepth({ eventCount: 4, powerCutoff: 20, regularThreshold }),
    ).toBe("casual");
  });
});

// ---------------------------------------------------------------------------
// assignEngagementDepth - regular bucket
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - regular bucket", () => {
  const regularThreshold = computeRegularThreshold(LIFECYCLE_DEFAULTS); // 5

  it("assigns regular for exactly regularThreshold events (5)", () => {
    expect(
      assignEngagementDepth({ eventCount: 5, powerCutoff: 20, regularThreshold }),
    ).toBe("regular");
  });

  it("assigns regular for events above threshold but below power cutoff", () => {
    expect(
      assignEngagementDepth({ eventCount: 15, powerCutoff: 20, regularThreshold }),
    ).toBe("regular");
  });

  it("assigns regular for regularThreshold events when power bucket is suppressed", () => {
    expect(
      assignEngagementDepth({ eventCount: 5, powerCutoff: null, regularThreshold }),
    ).toBe("regular");
  });
});

// ---------------------------------------------------------------------------
// assignEngagementDepth - power bucket
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - power bucket", () => {
  const regularThreshold = computeRegularThreshold(LIFECYCLE_DEFAULTS); // 5

  it("assigns power for events at the power cutoff", () => {
    expect(
      assignEngagementDepth({ eventCount: 20, powerCutoff: 20, regularThreshold }),
    ).toBe("power");
  });

  it("assigns power for events above the power cutoff", () => {
    expect(
      assignEngagementDepth({ eventCount: 50, powerCutoff: 20, regularThreshold }),
    ).toBe("power");
  });

  it("does NOT assign power when powerCutoff is null (small cohort)", () => {
    // With null cutoff, a high-activity contact gets regular instead of power
    expect(
      assignEngagementDepth({ eventCount: 50, powerCutoff: null, regularThreshold }),
    ).toBe("regular");
  });
});

// ---------------------------------------------------------------------------
// Boundary exactness: each boundary is inclusive at the lower end
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - boundary exactness", () => {
  it("1 event => minimal, 2 => minimal, 3 => casual, 5 => regular, 20 => power", () => {
    const regularThreshold = 5;
    const powerCutoff = 20;
    const cases: Array<[number, string | null]> = [
      [0, null],
      [1, "minimal"],
      [2, "minimal"],
      [3, "casual"],
      [4, "casual"],
      [5, "regular"],
      [6, "regular"],
      [19, "regular"],
      [20, "power"],
      [100, "power"],
    ];
    for (const [count, expected] of cases) {
      expect(
        assignEngagementDepth({ eventCount: count, powerCutoff, regularThreshold }),
        `count=${count}`,
      ).toBe(expected);
    }
  });

  it("with regularThreshold=2 (tight window): 1=>minimal, 2=>regular, 3=>regular", () => {
    const config = resolveLifecycleConfig({
      engagement_depth_window_days: 14,
      natural_frequency_days: 7,
    });
    const regularThreshold = computeRegularThreshold(config); // 2
    // casual range would be [3, 1] which is empty: 3 >= regularThreshold=2, so casual
    // never fires. Values 1=>minimal, 2+=>regular (or power if above cutoff).
    expect(
      assignEngagementDepth({ eventCount: 1, powerCutoff: 10, regularThreshold }),
    ).toBe("minimal");
    expect(
      assignEngagementDepth({ eventCount: 2, powerCutoff: 10, regularThreshold }),
    ).toBe("regular");
    expect(
      assignEngagementDepth({ eventCount: 3, powerCutoff: 10, regularThreshold }),
    ).toBe("regular");
  });
});

// ---------------------------------------------------------------------------
// Config-driven: verify thresholds match expected values for all three
// business model templates
// ---------------------------------------------------------------------------

describe("assignEngagementDepth - template-derived thresholds", () => {
  it("Preview Free template (frequency=3, window=30): regular threshold = ceil(30/3) = 10", () => {
    const config: LifecycleConfig = {
      ...LIFECYCLE_DEFAULTS,
      natural_frequency_days: 3,
      engagement_depth_window_days: 30,
    };
    expect(computeRegularThreshold(config)).toBe(10);
  });

  it("Time-Limited Trial template (frequency=2, window=30): regular threshold = ceil(30/2) = 15", () => {
    const config: LifecycleConfig = {
      ...LIFECYCLE_DEFAULTS,
      natural_frequency_days: 2,
      engagement_depth_window_days: 30,
    };
    expect(computeRegularThreshold(config)).toBe(15);
  });
});
