// extractAccessToken: the Cf-Access-Jwt-Assertion header (edge-injected on
// paths the Access app covers) wins; otherwise the domain-wide CF_Authorization
// cookie set after passing the /access login app. Pure unit tests.
import { describe, expect, it } from "vitest";
import { extractAccessToken } from "../src/auth";

describe("extractAccessToken", () => {
  it("prefers the Cf-Access-Jwt-Assertion header over the cookie", () => {
    expect(extractAccessToken("header.jwt.value", "CF_Authorization=cookie.jwt.value")).toBe("header.jwt.value");
  });
  it("falls back to the CF_Authorization cookie", () => {
    expect(extractAccessToken(null, "foo=1; CF_Authorization=eyJx.yy.zz; bar=2")).toBe("eyJx.yy.zz");
  });
  it("returns null when neither is present", () => {
    expect(extractAccessToken(null, null)).toBeNull();
    expect(extractAccessToken(null, "eg_session=old; other=x")).toBeNull();
    expect(extractAccessToken("", "")).toBeNull();
  });
  it("ignores an empty cookie value", () => {
    expect(extractAccessToken(null, "CF_Authorization=")).toBeNull();
  });
  it("keeps '=' inside the cookie value intact", () => {
    expect(extractAccessToken(null, "CF_Authorization=a.b.c==")).toBe("a.b.c==");
  });
});
