import { describe, expect, it } from "vitest";
import { installPlatform } from "./InstallHint";

describe("installPlatform", () => {
  it("detects iPhone, iPad (also iPadOS as Mac with touch), Android and desktop", () => {
    expect(installPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)")).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 5)).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 0)).toBe("desktop");
    expect(installPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("android");
    expect(installPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0")).toBe("desktop");
  });
});
