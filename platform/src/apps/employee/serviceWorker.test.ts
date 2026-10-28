import { describe, expect, it } from "vitest";
import { serviceWorkerAllowed } from "./serviceWorker";

describe("service worker registration rules", () => {
  it("only production builds over HTTPS or on localhost", () => {
    expect(serviceWorkerAllowed({ protocol: "https:", hostname: "zeit.example.de" }, true)).toBe(true);
    expect(serviceWorkerAllowed({ protocol: "http:", hostname: "localhost" }, true)).toBe(true);
    expect(serviceWorkerAllowed({ protocol: "http:", hostname: "127.0.0.1" }, true)).toBe(true);
    expect(serviceWorkerAllowed({ protocol: "http:", hostname: "zeit.example.de" }, true)).toBe(false);
    expect(serviceWorkerAllowed({ protocol: "https:", hostname: "zeit.example.de" }, false)).toBe(false);
  });
});
