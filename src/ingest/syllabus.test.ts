import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSyllabusExtraction } from "./syllabus.js";

describe("normalizeSyllabusExtraction", () => {
  it("accepts explicit high-confidence syllabus events", () => {
    const result = normalizeSyllabusExtraction({
      events: [
        {
          title: "Final Exam",
          type: "FINAL",
          dueAt: "2026-09-15T17:00:00-07:00",
          confidence: 0.93,
          evidence: "Final Exam: September 15, 2026 at 5:00 PM",
        },
      ],
    });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.accepted[0].title, "Final Exam");
    assert.equal(result.accepted[0].type, "FINAL");
    assert.equal(result.accepted[0].confidence, 0.93);
    assert.equal(result.accepted[0].dueAt, "2026-09-16T00:00:00.000Z");
  });

  it("rejects ambiguous or low-confidence events with audit reasons", () => {
    const result = normalizeSyllabusExtraction({
      events: [
        {
          title: "Midterm",
          type: "MIDTERM",
          dueAt: "March 11",
          confidence: 0.9,
          evidence: "Course Exam: Wednesday, Mar. 11",
        },
        {
          title: "Project deadline",
          type: "HOMEWORK",
          dueAt: "2026-02-01",
          confidence: 0.42,
          evidence: "Project deadline maybe February 1",
        },
        {
          title: "Reading",
          type: "READING",
          confidence: 0.8,
          evidence: "Read articles before class",
        },
      ],
    });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 3);
    assert.match(result.rejected[0].rejectionReason, /ambiguous date/);
    assert.match(result.rejected[1].rejectionReason, /confidence below/);
    assert.equal(result.rejected[2].rejectionReason, "missing date");
  });

  it("keeps model rejection reasons and normalizes unknown types", () => {
    const result = normalizeSyllabusExtraction({
      events: [
        {
          title: "Review session",
          type: "OPTIONAL",
          dueAt: "2026-10-01",
          confidence: 0.8,
          rejectionReason: "not a required course event",
        },
      ],
    });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].type, "OTHER");
    assert.equal(result.rejected[0].rejectionReason, "not a required course event");
  });
});
