import { describe, expect, it } from "vitest";
import { canRetry, ticketStage } from "./stage";

describe("ticketStage", () => {
  it("puts a failed delivery first", () => {
    expect(
      ticketStage({
        deliveryFailed: true,
        attention: true,
        latestReport: "ready",
        assignment: "running",
      }),
    ).toBe("person/delivery");
  });

  it("asks a person for an answer before review", () => {
    expect(ticketStage({ attention: true, latestReport: "ready", assignment: "running" })).toBe(
      "person/answer",
    );
  });

  it("waits for review after a ready report", () => {
    expect(ticketStage({ latestReport: "ready", assignment: "running" })).toBe("person/review");
  });

  it("shows blocked or failed until a person writes again", () => {
    expect(ticketStage({ latestReport: "blocked", assignment: "running" })).toBe("person/blocked");
    expect(ticketStage({ latestReport: "failed", assignment: "running" })).toBe("person/failed");
    expect(
      ticketStage({
        latestReport: "blocked",
        humanMessageSinceLatestReport: true,
        assignment: "running",
      }),
    ).toBe("working");
  });

  it("queues before an assignment exists", () => {
    expect(ticketStage({})).toBe("working/queued");
    expect(ticketStage({ assignment: "pending" })).toBe("working/queued");
  });

  it("is idle after waiting or an ended assignment", () => {
    expect(ticketStage({ latestReport: "waiting", assignment: "running" })).toBe("idle");
    expect(ticketStage({ assignment: "ended" })).toBe("idle");
  });

  it("is working otherwise", () => {
    expect(ticketStage({ latestReport: "progress", assignment: "running" })).toBe("working");
  });
});

describe("canRetry", () => {
  it("allows retry only where a person must act", () => {
    expect(canRetry("person/delivery")).toBe(true);
    expect(canRetry("person/blocked")).toBe(true);
    expect(canRetry("person/failed")).toBe(true);
    expect(canRetry("person/answer")).toBe(false);
    expect(canRetry("working")).toBe(false);
  });
});
