/**
 * MINOR-7: lib/locationRegistry.ts asserts registry.version === 1 at module
 * load, throwing a clear error otherwise — a version bump the reader forgot
 * to account for must fail loudly at import time, not misbehave silently the
 * first time a request touches a shape that changed underneath it.
 *
 * The "throws" case mocks the committed artifact's JSON module for the
 * duration of one `require`, then explicitly un-mocks and resets the module
 * registry so every other test in this process (this file's own "loads
 * fine" case, and any other suite sharing this Jest worker) sees the real
 * artifact again.
 */
describe("lib/locationRegistry — version guard", () => {
  it("throws a clear error when the artifact declares an unrecognized version", () => {
    jest.resetModules();
    // No `{ virtual: true }` here: unlike the synthetic registries in
    // locationRegistryFoldCollision.test.ts, this module path resolves to a
    // real committed file — `virtual` is for paths that do not exist, and
    // using it on one that does was the source of this test's flakiness
    // under parallel workers (Jest's resolver caching for a real,
    // already-resolvable path did not consistently agree with a `virtual`
    // mock registration for the same path).
    jest.doMock("@/lib/data/locationRegistry.json", () => ({
      version: 2,
      cities: {},
    }));

    try {
      expect(() => require("@/lib/locationRegistry")).toThrow(
        /version 2[\s\S]*only understands version 1/,
      );
    } finally {
      jest.dontMock("@/lib/data/locationRegistry.json");
      jest.resetModules();
    }
  });

  it("loads without error for the real committed artifact (version 1)", () => {
    expect(() => require("@/lib/locationRegistry")).not.toThrow();
  });
});
