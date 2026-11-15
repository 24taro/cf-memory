import { describe, expect, it } from "vitest";
import { callerIsAdmin, hasScope } from "../src/auth";
import { principalFixture } from "./helpers";

describe("hasScope", () => {
  it("a read-only key is denied notes:write (acceptance #4)", () => {
    const readOnly = new Set(["notes:read"]);
    expect(hasScope(readOnly, "notes:write")).toBe(false);
    expect(hasScope(readOnly, "notes:read")).toBe(true);
    expect(hasScope(readOnly, "admin")).toBe(false);
  });

  it("admin implies every scope", () => {
    const admin = new Set(["admin"]);
    expect(hasScope(admin, "notes:write")).toBe(true);
    expect(hasScope(admin, "notes:read")).toBe(true);
    expect(hasScope(admin, "admin")).toBe(true);
  });

  it("an exact non-admin scope is honored but does not widen", () => {
    const write = new Set(["notes:write"]);
    expect(hasScope(write, "notes:write")).toBe(true);
    expect(hasScope(write, "admin")).toBe(false);
  });
});

describe("callerIsAdmin (decision 8: is_admin is derived from ONE place)", () => {
  it("bearer path: trusts ONLY the 'admin' scope, never isAdminFlag", () => {
    const bearerAdminScope = principalFixture({ authSource: "bearer", scopes: new Set(["admin"]), isAdminFlag: false });
    const bearerNoAdminScope = principalFixture({ authSource: "bearer", scopes: new Set(["notes:write"]), isAdminFlag: true });
    expect(callerIsAdmin(bearerAdminScope)).toBe(true);
    // Even if isAdminFlag were somehow true on a bearer principal, the bearer
    // path never looks at it — only the scope set matters.
    expect(callerIsAdmin(bearerNoAdminScope)).toBe(false);
  });

  it("access path: trusts ONLY isAdminFlag, never scopes (which are hardcoded to notes:read/write, decision 7)", () => {
    const accessAdmin = principalFixture({ authSource: "access", scopes: new Set(["notes:read", "notes:write"]), isAdminFlag: true });
    const accessNonAdmin = principalFixture({ authSource: "access", scopes: new Set(["notes:read", "notes:write"]), isAdminFlag: false });
    expect(callerIsAdmin(accessAdmin)).toBe(true);
    expect(callerIsAdmin(accessNonAdmin)).toBe(false);
  });

  it("anonymous is never admin, regardless of flags", () => {
    const anon = principalFixture({ anonymous: true, authSource: "none", isAdminFlag: true, scopes: new Set(["admin"]) });
    expect(callerIsAdmin(anon)).toBe(false);
  });

  it("authSource 'none' (non-anonymous edge case) is never admin", () => {
    const weird = principalFixture({ authSource: "none", isAdminFlag: true });
    expect(callerIsAdmin(weird)).toBe(false);
  });
});
