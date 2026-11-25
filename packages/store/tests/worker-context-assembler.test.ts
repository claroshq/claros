/**
 * Contract tests for workerContextAssembler (the module runs no queries).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`workerContextAssembler on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("has no query methods", () => {
      expect(b.store.workerContextAssembler).toEqual({});
    });
  });
}
