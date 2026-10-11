// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicReviewItem, PublicReviewSession, ReviewSessionResponse } from "../../api/contracts";

const api = vi.hoisted(() => ({
  currentReview: vi.fn(),
  startReview: vi.fn(),
  rateReview: vi.fn(),
  reviewEvent: vi.fn(),
  reviewSummary: vi.fn(),
}));
vi.mock("../../api/client", () => {
  class ApiRequestError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { api, ApiRequestError, newKey: () => "key-0000-0001" };
});

import { ApiRequestError } from "../../api/client";
import { TodayReview } from "./TodayReview";

const item = (n: number, status: PublicReviewItem["status"]): PublicReviewItem => ({
  cardId: `00000000-0000-4000-8000-00000000000${n}`,
  status,
  knowledgeLabel: `Component ${n}`,
  prompt: { id: `prompt-${n}`, type: n % 2 ? "recall" : "discrimination", front: `Question ${n}?`, ...(n % 2 ? {} : { choices: ["A thing", "B thing"] }) },
  answer: `Answer ${n}`,
  explanation: `Because ${n}.`,
  reason: { code: "new-miss", text: `New from your debrief — case ${n}.` },
  source: { attemptId: "11111111-1111-4111-8111-111111111111", scenarioTitle: "Cough and sore throat", rubricItemId: "omit-redflags", label: "Safety" },
});
const session = (position: number, total = 3): PublicReviewSession => ({
  id: "22222222-2222-4222-8222-222222222222",
  localDay: "2026-10-10",
  mode: "all",
  position,
  total,
  done: false,
  draftContent: true,
  items: Array.from({ length: total }, (_, i) => item(i + 1, i < position ? "done" : i === position ? "current" : "upcoming")),
});
const renderPage = () =>
  render(
    <MemoryRouter>
      <TodayReview />
    </MemoryRouter>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.reviewEvent.mockResolvedValue({ ok: true });
  api.reviewSummary.mockResolvedValue({ localDay: "2026-10-10", dueToday: 0, totalCards: 3 });
});
afterEach(cleanup);

describe("Today's review", () => {
  it("shows a calm empty state with no streak or countdown", async () => {
    api.currentReview.mockResolvedValue({ session: null, resumed: false, dueToday: 0 } satisfies ReviewSessionResponse);
    renderPage();
    expect(await screen.findByText("Nothing due right now")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/streak|hours left|expires/i);
  });

  it("offers Quick 5 only when more than five items are due", async () => {
    api.currentReview.mockResolvedValue({ session: null, resumed: false, dueToday: 8 });
    renderPage();
    expect(await screen.findByRole("button", { name: "Quick 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review all 8" })).toBeTruthy();
    api.startReview.mockResolvedValue({ session: session(0, 5), resumed: false, dueToday: 8 });
    fireEvent.click(screen.getByRole("button", { name: "Quick 5" }));
    await waitFor(() => expect(api.startReview).toHaveBeenCalledWith("micro", false));
    expect(await screen.findByText("Item 1 of 5")).toBeTruthy();
  });

  it("resumes an interrupted session at the saved position", async () => {
    api.currentReview.mockResolvedValue({ session: session(2), resumed: true, dueToday: 3 });
    renderPage();
    expect(await screen.findByText("Item 3 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Question 3?" })).toBeTruthy();
    await waitFor(() => expect(api.reviewEvent).toHaveBeenCalledWith(session(2).id, { type: "shown", cardId: item(3, "current").cardId }));
  });

  it("reveals the answer, links back to the debrief, and rates with one tap", async () => {
    api.currentReview.mockResolvedValue({ session: session(0), resumed: true, dueToday: 3 });
    renderPage();
    await screen.findByText("Question 1?");
    expect(screen.queryByText("Answer 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show answer" }));
    expect(screen.getByText("Answer 1")).toBeTruthy();
    expect(screen.getByText("New from your debrief — case 1.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the case debrief/ }).getAttribute("href")).toBe("/results/11111111-1111-4111-8111-111111111111#miss-omit-redflags");
    expect(document.body.textContent).not.toMatch(/ease|stability|difficulty/i);

    api.rateReview.mockResolvedValue({ cardId: item(1, "current").cardId, rating: 3, nextDue: "2026-10-13T21:00:00.000Z", nextDueInDays: 3, session: { id: session(0).id, position: 1, total: 3, done: false } });
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() =>
      expect(api.rateReview).toHaveBeenCalledWith(item(1, "current").cardId, expect.objectContaining({ sessionId: session(0).id, promptId: "prompt-1", rating: 3 }), "key-0000-0001"),
    );
    expect(await screen.findByText("Item 2 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show answer" })).toBeTruthy();
    expect(screen.getByText("A thing")).toBeTruthy();
  });

  it("keeps Hard and Easy behind More options", async () => {
    api.currentReview.mockResolvedValue({ session: session(0), resumed: true, dueToday: 3 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));
    expect(screen.queryByRole("button", { name: "Easy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More options/ }));
    expect(screen.getByRole("button", { name: "Easy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Got it, but it was hard" })).toBeTruthy();
  });

  it("retries a failed rating with the same idempotency key", async () => {
    api.currentReview.mockResolvedValue({ session: session(0), resumed: true, dueToday: 3 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));
    api.rateReview.mockRejectedValueOnce(new ApiRequestError("Could not reach the ClinicSim server.", 0, "network"));
    fireEvent.click(screen.getByRole("button", { name: "Missed it" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    api.rateReview.mockResolvedValue({ cardId: item(1, "current").cardId, rating: 1, nextDue: "2026-10-11T21:00:00.000Z", nextDueInDays: 1, session: { id: session(0).id, position: 1, total: 3, done: false } });
    fireEvent.click(screen.getByRole("button", { name: "Missed it" }));
    await screen.findByText("Item 2 of 3");
    const keys = api.rateReview.mock.calls.map((c) => c[2]);
    expect(keys).toEqual(["key-0000-0001", "key-0000-0001"]);
  });
});
