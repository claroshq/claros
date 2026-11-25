/** UTM tagging of links (G6). */
import { describe, it, expect } from "vitest";
import { tagUrl, tagHtmlLinks, tagTextLinks, resolveLinkTracking, linkTrackingSchema } from "../src/index.js";

const tracking = linkTrackingSchema.parse({
  domains: ["fundup.ai"],
  params: { utm_source: "claros", utm_campaign: "{{flow.slug}}", utm_content: "s{{step.order}}", utm_term: "{{action_type}}" },
  click_id: true,
});
const ctx = { messageId: "m-1", flowSlug: "welcome", flowName: "Welcome", stepOrder: 2, actionType: null };

describe("tagUrl", () => {
  it("adds params and the click id on listed domains and subdomains", () => {
    expect(tagUrl("https://fundup.ai/x", tracking, ctx)).toBe("https://fundup.ai/x?utm_source=claros&utm_campaign=welcome&utm_content=s2&clr_cid=m-1");
    expect(tagUrl("https://app.fundup.ai/x#top", tracking, ctx)).toBe("https://app.fundup.ai/x?utm_source=claros&utm_campaign=welcome&utm_content=s2&clr_cid=m-1#top");
  });
  it("never overwrites existing params, skips empty placeholder values", () => {
    expect(tagUrl("https://fundup.ai/x?utm_source=mine&clr_cid=z", tracking, ctx)).toBe("https://fundup.ai/x?utm_source=mine&clr_cid=z&utm_campaign=welcome&utm_content=s2");
  });
  it("leaves other domains, look-alikes, mailto and malformed links alone", () => {
    for (const u of ["https://example.com/x", "https://notfundup.ai/x", "https://fundup.ai.evil.com/x", "mailto:a@fundup.ai", "/relative", "not a url"]) {
      expect(tagUrl(u, tracking, ctx)).toBe(u);
    }
  });
  it("uses the flow name when the flow has no slug", () => {
    expect(tagUrl("https://fundup.ai/", tracking, { ...ctx, flowSlug: null })).toContain("utm_campaign=Welcome");
  });
});

describe("html and text", () => {
  it("tags anchor hrefs, keeping entities", () => {
    const html = `<a class="b" href="https://fundup.ai/a?x=1&amp;y=2">A</a><a href='https://other.com'>B</a>`;
    expect(tagHtmlLinks(html, tracking, ctx)).toBe(
      `<a class="b" href="https://fundup.ai/a?x=1&amp;y=2&amp;utm_source=claros&amp;utm_campaign=welcome&amp;utm_content=s2&amp;clr_cid=m-1">A</a><a href='https://other.com'>B</a>`,
    );
    expect(tagHtmlLinks(html, null, ctx)).toBe(html);
  });
  it("tags bare URLs in text without swallowing trailing punctuation", () => {
    expect(tagTextLinks("Go to https://fundup.ai/icp. Thanks", tracking, ctx)).toBe(
      "Go to https://fundup.ai/icp?utm_source=claros&utm_campaign=welcome&utm_content=s2&clr_cid=m-1. Thanks",
    );
  });
  it("resolveLinkTracking ignores missing or invalid settings", () => {
    expect(resolveLinkTracking(null)).toBeNull();
    expect(resolveLinkTracking({ link_tracking: { domains: [] } })).toBeNull();
    expect(resolveLinkTracking({ link_tracking: { domains: "x" } })).toBeNull();
    expect(resolveLinkTracking({ link_tracking: { domains: ["a.com"] } })).toEqual({ domains: ["a.com"], params: {}, click_id: false });
  });
});
