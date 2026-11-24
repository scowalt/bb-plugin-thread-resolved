import { describe, expect, it } from "vitest";
import { apiKeyFor } from "./judge";

describe("apiKeyFor", () => {
  it("prefers the model's own provider, and falls back to the other one", () => {
    const auth = { opencode: { key: "console" }, "opencode-go": { key: "go" } };
    expect(apiKeyFor(auth, "opencode-go")).toBe("go");
    expect(apiKeyFor(auth, "opencode")).toBe("console");
    expect(apiKeyFor({ opencode: { key: "console" } }, "opencode-go")).toBe("console");
    expect(apiKeyFor({ "opencode-go": { key: "go" } }, "opencode")).toBe("go");
    expect(apiKeyFor({}, "opencode")).toBeUndefined();
  });
});
