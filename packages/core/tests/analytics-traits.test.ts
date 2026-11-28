import { describe, it, expect } from "vitest";
import { analyticsTraits } from "../src/index.js";

describe("analyticsTraits", () => {
  it("sends the contact's email, name, company and the product's plan", () => {
    expect(analyticsTraits({ email: "ada@example.com", name: " Ada ", company: "Acme", properties: { plan: "pro", seats: 3 } }))
      .toEqual({ email: "ada@example.com", name: "Ada", company: "Acme", plan: "pro" });
    expect(analyticsTraits({ email: null, name: null, company: null, properties: { plan: 2 } })).toEqual({ plan: 2 });
  });

  it("leaves out unknown, blank and non-scalar values instead of sending empty ones", () => {
    expect(analyticsTraits({ email: "a@b.co", name: "  ", company: "", properties: { plan: null } })).toEqual({ email: "a@b.co" });
    expect(analyticsTraits({ email: "a@b.co", name: null, company: null, properties: { plan: { id: 1 } } })).toEqual({ email: "a@b.co" });
    expect(analyticsTraits({ email: "a@b.co", name: null, company: null, properties: { plan: Number.NaN } })).toEqual({ email: "a@b.co" });
    expect(analyticsTraits({ email: null, name: null, company: null })).toBeNull();
    expect(analyticsTraits({ email: null, name: "", company: null, properties: null })).toBeNull();
  });
});
