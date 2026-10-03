// The shared date and count formats. Every case is built in local time, so the expectations hold in any time zone.
import assert from "node:assert/strict";
import test from "node:test";

const { ago, clock, countdown, isDelegation } = await import("../src/shared.ts");

// the gateway's UTC "YYYY-MM-DD HH:MM:SS"
const utc = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

test("ago shortens with distance: now, minutes, the time today, a weekday, a date, a year", () => {
    const now = new Date(2026, 8, 28, 15, 30).getTime();
    assert.equal(ago(utc(new Date(now - 30_000)), now), "now");
    assert.equal(ago(utc(new Date(now + 90_000)), now), "now", "a gateway clock slightly ahead is still now");
    assert.equal(ago(utc(new Date(now - 5 * 60_000)), now), "5m");
    assert.equal(ago(utc(new Date(now - 59 * 60_000)), now), "59m");
    assert.equal(ago(utc(new Date(2026, 8, 28, 9, 5)), now), "09:05");
    assert.equal(ago(utc(new Date(2026, 8, 25, 12, 0)), now), "Fri");
    assert.equal(ago(utc(new Date(now - 6 * 86_400_000 + 30 * 60_000)), now), "Tue", "just under six days");
    assert.equal(ago(utc(new Date(now - 6 * 86_400_000 - 30 * 60_000)), now), "Sep 22", "six days or more");
    assert.equal(ago(utc(new Date(2026, 1, 3, 12, 0)), now), "Feb 3");
    assert.equal(ago(utc(new Date(2025, 8, 3, 12, 0)), now), "2025");
});

test("ago names yesterday by its weekday, even an hour ago", () => {
    const now = new Date(2026, 8, 28, 0, 30).getTime();
    assert.equal(ago(utc(new Date(2026, 8, 27, 23, 0)), now), "Sun");
    assert.equal(ago(utc(new Date(2026, 8, 28, 0, 0)), now), "30m");
});

test("clock keeps the time for today, the date this year, and the year before that", () => {
    const now = new Date(2026, 8, 28, 15, 30).getTime();
    assert.equal(clock(utc(new Date(2026, 8, 28, 9, 5)), now), "09:05");
    assert.equal(clock(utc(new Date(2026, 0, 1, 12)), now), "Jan 1");
    assert.equal(clock(utc(new Date(2025, 8, 3, 12)), now), "Sep 3, 2025");
});

test("countdown is minutes and padded seconds, rounded up, never below zero", () => {
    assert.equal(countdown(252_000), "4:12");
    assert.equal(countdown(45_000), "0:45");
    assert.equal(countdown(1), "0:01");
    assert.equal(countdown(0), "0:00");
    assert.equal(countdown(-1), "0:00");
    assert.equal(countdown(-90_000), "0:00");
});

test("countdown past an hour, a question's wait, carries the hours", () => {
    assert.equal(countdown(3_599_000), "59:59");
    assert.equal(countdown(3_600_000), "1:00:00");
    assert.equal(countdown(12 * 3_600_000 - 52_000), "11:59:08");
});

test("a delegation thread is a hand-set title that starts with the arrow", () => {
    assert.equal(isDelegation({ title: "← Draft reply", titleByUser: true }), true);
    assert.equal(isDelegation({ title: "← Draft reply", titleByUser: false }), false);
    assert.equal(isDelegation({ title: "Draft reply", titleByUser: true }), false);
    assert.equal(isDelegation({ title: null, titleByUser: true }), false);
});
