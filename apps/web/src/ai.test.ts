import { describe, expect, it } from "vitest";
import { aiHost, aiReady, emptyAiSettings, validBaseURL } from "./ai";

describe("AI assistant settings", () => {
  it("is not ready without a key and consent", () => {
    expect(aiReady(emptyAiSettings)).toBe(false);
    expect(aiReady({ ...emptyAiSettings, apiKey: "sk-ant-x" })).toBe(false);
    expect(aiReady({ ...emptyAiSettings, apiKey: "sk-ant-x", consent: true })).toBe(true);
  });

  it("only accepts secure addresses, or a gateway on this computer", () => {
    expect(validBaseURL("")).toBe(true);
    expect(validBaseURL("https://gateway.example.com/anthropic")).toBe(true);
    expect(validBaseURL("http://localhost:8080")).toBe(true);
    expect(validBaseURL("http://example.com")).toBe(false);
    expect(validBaseURL("javascript:alert(1)")).toBe(false);
    expect(validBaseURL("not a url")).toBe(false);
  });

  it("names where text would be sent", () => {
    expect(aiHost(emptyAiSettings)).toBe("api.anthropic.com");
    expect(aiHost({ ...emptyAiSettings, baseURL: "https://gateway.example.com/v1" })).toBe("gateway.example.com");
  });
});
