import { describe, expect, it } from "vitest";
import { employeeAppUrl } from "./AppGuide";

describe("employeeAppUrl", () => {
  it("points from the Chef-Portal to the employee app, without route or query", () => {
    expect(employeeAppUrl("https://stunden.example.de/chef/#/app-anleitung")).toBe("https://stunden.example.de/app/");
    expect(employeeAppUrl("https://stunden.example.de/chef/index.html?x=1#/mitarbeiter")).toBe("https://stunden.example.de/app/");
    expect(employeeAppUrl("http://localhost:5173/chef/")).toBe("http://localhost:5173/app/");
  });
});
