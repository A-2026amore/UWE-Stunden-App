import { describe, expect, it } from "vitest";
import { SNOOZE_MS, installBrowser, installPlatform, isSnoozed } from "./InstallHint";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";

describe("installPlatform", () => {
  it("detects iPhone, iPad (also iPadOS as Mac with touch), Android and desktop", () => {
    expect(installPlatform(IPHONE_SAFARI)).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)")).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 5)).toBe("ios");
    expect(installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 0)).toBe("desktop");
    expect(installPlatform(ANDROID_CHROME)).toBe("android");
    expect(installPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0")).toBe("desktop");
  });
});

describe("installBrowser", () => {
  it("Safari and Chrome are fine", () => {
    expect(installBrowser(IPHONE_SAFARI, "ios")).toBe("default");
    expect(installBrowser(ANDROID_CHROME, "android")).toBe("default");
  });

  it("Chrome, Firefox and Edge on the iPhone: recommend Safari", () => {
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1", "ios")).toBe("ios-other");
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 FxiOS/127.0 Mobile/15E148 Safari/605.1.15", "ios")).toBe("ios-other");
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/126.0 Mobile/15E148 Safari/605.1.15", "ios")).toBe("ios-other");
  });

  it("browsers inside other apps cannot install", () => {
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]", "ios")).toBe("inapp");
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0", "ios")).toBe("inapp");
    expect(installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 GSA/330.0 Mobile/15E148 Safari/604.1", "ios")).toBe("inapp");
    expect(installBrowser("Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 Version/4.0 Chrome/126.0 Mobile Safari/537.36", "android")).toBe("inapp");
  });
});

describe("isSnoozed", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  it("'Später' hides the banner for a week, then it comes back", () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(String(now - 1000), now)).toBe(true);
    expect(isSnoozed(String(now - SNOOZE_MS + 1000), now)).toBe(true);
    expect(isSnoozed(String(now - SNOOZE_MS - 1000), now)).toBe(false);
  });

  it("the old 'hide forever' value shows the improved banner once more", () => {
    expect(isSnoozed("1", now)).toBe(false);
    expect(isSnoozed("unsinn", now)).toBe(false);
  });
});
