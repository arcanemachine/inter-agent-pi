import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAILBOX_MAX_UNREAD,
  MAILBOX_NOTICE_DEBOUNCE_MS_DEFAULT,
  RELOAD_HANDOFF_TTL_MS,
  RELOAD_HANDOFF_VERSION,
  MailboxDispatcher,
  buildNoticeCompact,
  buildNoticeExpanded,
  createProcessGlobalHandoffCarrier,
  deriveInboundMetadata,
  effectiveDeliveryMode,
  effectiveDebounceMs,
  isValidDebounceMs,
  isValidDeliveryMode,
  parseIncoming,
  type InboundDispatch,
  type InboundImmediateMessage,
  type MailboxHost,
  type MailboxNoticeMessage,
  type MailboxMessage,
  type MessageKind,
  type ReloadHandoff,
  type ReloadHandoffCarrier,
} from "../../src/mailbox.js";

interface ImmediateRecord {
  message: InboundImmediateMessage;
  triggerTurn: boolean;
}

interface NoticeRecord {
  message: MailboxNoticeMessage;
  triggerTurn: boolean;
}

interface FakeTimer {
  fn: () => void;
  cancelled: boolean;
}

class FakeHost implements MailboxHost {
  readonly notices: NoticeRecord[] = [];
  readonly immediates: ImmediateRecord[] = [];
  readonly warnings: string[] = [];
  readonly timers: FakeTimer[] = [];
  idle = true;
  pendingMessages = false;

  isIdle(): boolean {
    return this.idle;
  }

  hasPendingMessages(): boolean {
    return this.pendingMessages;
  }

  sendNotice(message: MailboxNoticeMessage, triggerTurn: boolean): void {
    this.notices.push({ message, triggerTurn });
  }

  sendImmediate(message: InboundImmediateMessage, triggerTurn: boolean): void {
    this.immediates.push({ message, triggerTurn });
  }

  notifyWarning(body: string): void {
    this.warnings.push(body);
  }

  // The dispatcher cancels prior notice timers itself via the returned cancel
  // function, so the host only needs to record each timer and let callers fire
  // them. This lets a deferred settlement timer coexist with a notice timer.
  schedule(fn: () => void, _ms: number): () => void {
    const timer: FakeTimer = { fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Fire the latest non-cancelled timer (debounce timers fire one at a time). */
  firePending(): void {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const timer = this.timers[i];
      if (!timer.cancelled) {
        timer.cancelled = true;
        timer.fn();
        return;
      }
    }
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

function immediateMessage(
  id: string,
  body = `body-${id}`,
  sender = "peer",
): InboundImmediateMessage {
  return {
    customType: "inter-agent-message",
    content: `content-${id}`,
    display: true,
    details: {
      from: sender,
      text: body,
      toInfo: "to me",
      displayContent: `display-${id}`,
    },
  };
}

function queuedDispatch(
  id: string,
  body = `body-${id}`,
  sender = "peer",
  kind: MessageKind = "direct",
  channel?: string,
  target?: string,
): InboundDispatch {
  return { msgId: id, sender, body, kind, channel, target };
}

function makeDispatcher(
  host: FakeHost,
  mode: "queued" | "immediate" = "queued",
  debounceMs = 0,
): MailboxDispatcher {
  return new MailboxDispatcher(host, mode, debounceMs);
}

/** Mirrors the process-global carrier so reload cases stay hermetic. */
class FakeCarrier implements ReloadHandoffCarrier {
  gen = 0;
  slot: ReloadHandoff | null = null;
  getGeneration(): number {
    return this.gen;
  }
  store(handoff: ReloadHandoff): void {
    this.gen = handoff.gen;
    this.slot = handoff;
  }
  take(): { handoff: ReloadHandoff | null; genBefore: number } {
    const handoff = this.slot;
    const genBefore = this.gen;
    this.slot = null;
    this.gen = this.gen + 1;
    return { handoff, genBefore };
  }
  reset(): void {
    this.slot = null;
    this.gen = this.gen + 1;
  }
}

const SESSION = "reload-session-1";

test("queued is the default and bodies stay out of notices until read", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  const body = "SECRET-MARKER-queued-body";
  mailbox.deliverInbound(queuedDispatch("m1", body, "alice"));

  assert.equal(host.notices.length, 0);
  host.firePending();
  assert.equal(host.notices.length, 1);
  // A queued arrival while idle provokes one mailbox-awareness turn.
  assert.equal(host.notices[0].triggerTurn, true);
  const notice = host.notices[0].message;
  assert.equal(notice.customType, "inter-agent-mailbox");
  assert.equal(notice.details.unread, 1);
  assert.deepEqual(notice.details.messages, [
    {
      id: "m1",
      sender: "alice",
      kind: "direct",
      channel: undefined,
      target: undefined,
    },
  ]);
  assert.equal(notice.details.bySender.length, 1);
  assert.equal(notice.details.bySender[0].sender, "alice");
  // Body never reaches model-visible notice content or details.
  assert.ok(!notice.content.includes(body));
  assert.ok(!JSON.stringify(notice.details).includes(body));
  assert.ok(notice.content.includes("m1"));
  assert.ok(notice.content.includes("alice"));
});

test("direct, broadcast, and channel bodies share one mailbox with metadata distinct", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(
    queuedDispatch("d1", "bd", "a", "direct", undefined, "me"),
  );
  mailbox.deliverInbound(queuedDispatch("b1", "bb", "a", "broadcast"));
  mailbox.deliverInbound(queuedDispatch("c1", "bc", "a", "channel", "updates"));

  host.firePending();
  const snap = host.notices[0].message.details;
  assert.equal(snap.unread, 3);
  const ids = snap.messages.map((m) => m.id);
  assert.deepEqual(["d1", "b1", "c1"], ids);
  assert.equal(snap.messages[2].channel, "updates");
  assert.equal(snap.messages[0].target, "me");
  // No body text anywhere in the notice.
  assert.ok(!JSON.stringify(snap).includes("bd"));
  assert.ok(!JSON.stringify(snap).includes("bb"));
  assert.ok(!JSON.stringify(snap).includes("bc"));
});

test("read-all returns messages in arrival order and empties the mailbox", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  mailbox.deliverInbound(queuedDispatch("b", "2", "bob"));
  mailbox.deliverInbound(
    queuedDispatch("c", "3", "alice", "channel", "updates"),
  );

  const result = mailbox.read();
  assert.equal(result.read.length, 3);
  assert.deepEqual(
    result.read.map((m) => m.msgId),
    ["a", "b", "c"],
  );
  assert.equal(result.remaining, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(mailbox.size, 0);
  // Reading performs no outbound action.
  assert.equal(host.notices.length, 0);
  assert.equal(host.immediates.length, 0);
});

test("read selected ids returns arrival order regardless of request order", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "1"));
  mailbox.deliverInbound(queuedDispatch("b", "2"));
  mailbox.deliverInbound(queuedDispatch("c", "3"));

  const result = mailbox.read(["c", "a"]);
  assert.deepEqual(
    result.read.map((m) => m.msgId),
    ["a", "c"],
  );
  assert.equal(result.remaining, 1);
  // Remaining unread set is the untouched message.
  assert.deepEqual(
    mailbox.read().read.map((m) => m.msgId),
    ["b"],
  );
});

test("mixed valid and missing ids succeed and report missing separately", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "1"));

  const result = mailbox.read(["a", "ghost", "a"]);
  assert.deepEqual(
    result.read.map((m) => m.msgId),
    ["a"],
  );
  assert.deepEqual(result.missing, ["ghost"]);
});

test("explicitly empty ids selection and empty mailbox reads succeed", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  // Empty mailbox, no ids.
  const empty = mailbox.read();
  assert.equal(empty.read.length, 0);
  assert.equal(empty.missing.length, 0);
  // Empty mailbox, explicitly empty ids array.
  const emptyIds = mailbox.read([]);
  assert.equal(emptyIds.read.length, 0);
  assert.equal(emptyIds.missing.length, 0);
  // Non-empty mailbox with explicitly empty ids selects nothing.
  mailbox.deliverInbound(queuedDispatch("a", "1"));
  const selection = mailbox.read([]);
  assert.equal(selection.read.length, 0);
  assert.equal(selection.remaining, 1);
});

test("reading a previously-shown id after clearing reports missing", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "1"));
  const before = mailbox.read(["a"]);
  assert.equal(before.read.length, 1);
  // Simulate reload/replacement clearing in-memory state.
  mailbox.shutdown();
  const after = mailbox.read(["a"]);
  assert.equal(after.read.length, 0);
  assert.deepEqual(after.missing, ["a"]);
});

test("immediate mode while idle delivers the body immediately with a trigger", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "immediate", 0);
  host.idle = true;
  mailbox.deliverInbound({
    ...queuedDispatch("m1", "SECRET-body", "alice"),
    immediateMessage: immediateMessage("m1", "SECRET-body", "alice"),
  });

  assert.equal(host.immediates.length, 1);
  assert.equal(host.immediates[0].triggerTurn, true);
  // Immediate bodies never enter the unread mailbox.
  assert.equal(mailbox.size, 0);
  assert.equal(host.notices.length, 0);
});

test("queued messages are retained when switching to immediate and back", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("old", "queued-body", "alice"));
  host.firePending();

  mailbox.setDeliveryMode("immediate");
  host.idle = true;
  mailbox.deliverInbound({
    ...queuedDispatch("new", "immediate-body", "bob"),
    immediateMessage: immediateMessage("new", "immediate-body", "bob"),
  });
  assert.equal(host.immediates.length, 1);
  // Old queued message is retained as unread.
  assert.equal(mailbox.size, 1);
  assert.deepEqual(
    mailbox.read().read.map((m) => m.msgId),
    ["old"],
  );

  // Switch back to queued; future arrivals queue again.
  mailbox.setDeliveryMode("queued");
  mailbox.deliverInbound(queuedDispatch("after", "again", "alice"));
  assert.equal(mailbox.size, 1);
  assert.deepEqual(
    mailbox.read().read.map((m) => m.msgId),
    ["after"],
  );
});

test("immediate burst waiting behind active work triggers at most one new turn", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "immediate", 0);
  host.idle = false;

  mailbox.deliverInbound({
    ...queuedDispatch("a"),
    immediateMessage: immediateMessage("a"),
  });
  mailbox.deliverInbound({
    ...queuedDispatch("b"),
    immediateMessage: immediateMessage("b"),
  });
  mailbox.deliverInbound({
    ...queuedDispatch("c"),
    immediateMessage: immediateMessage("c"),
  });
  // Nothing delivered while active.
  assert.equal(host.immediates.length, 0);

  host.idle = true;
  mailbox.settle();
  const triggered = host.immediates.filter((i) => i.triggerTurn).length;
  const followups = host.immediates.filter((i) => !i.triggerTurn).length;
  assert.equal(triggered, 1);
  assert.equal(followups, 2);
  assert.equal(host.immediates.length, 3);
  // First delivered with a trigger, rest as follow-up context.
  assert.equal(host.immediates[0].triggerTurn, true);
  assert.equal(host.immediates[1].triggerTurn, false);
  assert.equal(host.immediates[2].triggerTurn, false);

  // A second waiting burst after the agent runs again also triggers once.
  host.immediates.length = 0;
  host.idle = false;
  mailbox.deliverInbound({
    ...queuedDispatch("d"),
    immediateMessage: immediateMessage("d"),
  });
  mailbox.deliverInbound({
    ...queuedDispatch("e"),
    immediateMessage: immediateMessage("e"),
  });
  host.idle = true;
  mailbox.settle();
  assert.equal(host.immediates.filter((i) => i.triggerTurn).length, 1);
});

test("immediate arrival waits while idle with a queued continuation", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "immediate", 0);
  host.idle = true;
  host.pendingMessages = true;

  mailbox.deliverInbound({
    ...queuedDispatch("a", "body-a", "alice"),
    immediateMessage: immediateMessage("a", "body-a", "alice"),
  });
  // isIdle() alone is insufficient: a queued continuation must settle first.
  assert.equal(host.immediates.length, 0);

  mailbox.settle();
  assert.equal(host.immediates.length, 0);

  host.pendingMessages = false;
  mailbox.settle();
  assert.equal(host.immediates.length, 1);
  assert.equal(host.immediates[0].triggerTurn, true);
  assert.equal(host.immediates[0].message.details.text, "body-a");
});

test("immediate delivery never calls steer or abort", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "immediate", 0);
  host.idle = true;
  mailbox.deliverInbound({
    ...queuedDispatch("a"),
    immediateMessage: immediateMessage("a"),
  });
  // The host interface exposes no steer or abort; delivery only uses
  // sendImmediate with follow-up delivery.
  assert.equal(host.immediates.length, 1);
  assert.equal(host.warnings.length, 0);
  assert.equal(host.notices.length, 0);
});

test("128-message overflow evicts the oldest unread and warns once", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  for (let i = 0; i <= MAILBOX_MAX_UNREAD; i++) {
    mailbox.deliverInbound(queuedDispatch(`m-${i}`, `body-${i}`, "peer"));
  }
  assert.equal(mailbox.size, MAILBOX_MAX_UNREAD);
  const evictionWarnings = host.warnings.filter((w) => w.includes("evicted"));
  assert.equal(evictionWarnings.length, 1);
  const remaining = mailbox.read().read.map((m) => m.msgId);
  assert.ok(!remaining.includes("m-0"));
  assert.deepEqual(remaining[0], "m-1");
  assert.deepEqual(remaining[remaining.length - 1], `m-${MAILBOX_MAX_UNREAD}`);
});

test("duplicate live msg_id keeps the first body and warns", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("dup", "first-body", "alice"));
  mailbox.deliverInbound(queuedDispatch("dup", "second-body", "alice"));

  assert.equal(mailbox.size, 1);
  const dupWarnings = host.warnings.filter((w) => w.includes("duplicate"));
  assert.equal(dupWarnings.length, 1);
  const result = mailbox.read(["dup"]);
  assert.equal(result.read[0].body, "first-body");
});

test("malformed msg_id without a valid id is rejected with a warning", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound({ ...queuedDispatch("ok"), msgId: "" });
  assert.equal(mailbox.size, 0);
  assert.equal(host.warnings.length, 1);
  assert.equal(host.notices.length, 0);
});

test("debounce 0 delivers a notice for the latest snapshot on fire", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  mailbox.deliverInbound(queuedDispatch("b", "2", "bob"));
  mailbox.deliverInbound(queuedDispatch("c", "3", "alice"));

  assert.equal(host.notices.length, 0);
  host.firePending();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].message.details.unread, 3);
});

test("debounce coalesces a burst into one notice with the latest snapshot", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 200);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  mailbox.deliverInbound(queuedDispatch("b", "2", "bob"));
  mailbox.deliverInbound(queuedDispatch("c", "3", "alice"));

  assert.equal(host.pendingCount(), 1);
  host.firePending();
  assert.equal(host.notices.length, 1);
  assert.deepEqual(
    host.notices[0].message.details.messages.map((m) => m.id),
    ["a", "b", "c"],
  );
});

test("debounce replaces the pending timer with the latest snapshot", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 200);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  const firstTimer = host.timers[host.timers.length - 1];
  mailbox.deliverInbound(queuedDispatch("b", "2", "bob"));

  assert.equal(host.timers.length, 2);
  assert.equal(firstTimer.cancelled, true);
  assert.equal(host.pendingCount(), 1);
  host.firePending();
  assert.deepEqual(
    host.notices[0].message.details.messages.map((m) => m.id),
    ["a", "b"],
  );
});

test("shutdown cancels pending notice timers and clears mailbox state", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 200);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  assert.equal(host.pendingCount(), 1);
  mailbox.shutdown();
  assert.equal(host.pendingCount(), 0);
  host.firePending();
  assert.equal(host.notices.length, 0);
  assert.equal(mailbox.size, 0);
  assert.deepEqual(mailbox.read(["a"]).missing, ["a"]);
});

test("stale immediate callbacks after shutdown cannot deliver bodies", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "immediate", 0);
  host.idle = false;
  mailbox.deliverInbound({
    ...queuedDispatch("a"),
    immediateMessage: immediateMessage("a"),
  });
  // Bodies were waiting; shutdown clears them and bumps the generation so a
  // late flush is a no-op.
  mailbox.shutdown();
  mailbox.flushImmediate();
  assert.equal(host.immediates.length, 0);
});

test("stale notice timer after a simulated reload does not emit", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 200);
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  // Reload replaces the runtime; emulate it with shutdown on the prior owner.
  mailbox.shutdown();
  host.firePending();
  assert.equal(host.notices.length, 0);
});

test("config validation: delivery mode bounds and fallback", () => {
  assert.equal(effectiveDeliveryMode("immediate"), "immediate");
  assert.equal(effectiveDeliveryMode("queued"), "queued");
  assert.equal(effectiveDeliveryMode(undefined), "queued");
  assert.equal(effectiveDeliveryMode("bogus"), "queued");
  assert.ok(isValidDeliveryMode("queued"));
  assert.ok(isValidDeliveryMode("immediate"));
  assert.ok(!isValidDeliveryMode("bogus"));
  assert.ok(!isValidDeliveryMode(123));
});

test("config validation: debounce bounds and fallback", () => {
  assert.equal(MAILBOX_NOTICE_DEBOUNCE_MS_DEFAULT, 0);
  assert.equal(effectiveDebounceMs(undefined), 0);
  assert.equal(effectiveDebounceMs(0), 0);
  assert.equal(effectiveDebounceMs(200), 200);
  assert.equal(effectiveDebounceMs(5000), 5000);
  assert.equal(effectiveDebounceMs(5001), 0);
  assert.equal(effectiveDebounceMs(-1), 0);
  assert.equal(effectiveDebounceMs(1.5), 0);
  assert.equal(effectiveDebounceMs("200"), 0);
  assert.equal(effectiveDebounceMs(NaN), 0);
  assert.equal(effectiveDebounceMs(Infinity), 0);
  assert.ok(isValidDebounceMs(0));
  assert.ok(isValidDebounceMs(5000));
  assert.ok(!isValidDebounceMs(5001));
  assert.ok(!isValidDebounceMs(-1));
  assert.ok(!isValidDebounceMs(1.5));
  assert.ok(!isValidDebounceMs("200"));
});

test("notice renders complete metadata compactly and expanded without bodies", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(
    queuedDispatch("a", "SECRET-a", "alice", "direct", undefined, "me"),
  );
  mailbox.deliverInbound(
    queuedDispatch("b", "SECRET-b", "alice", "channel", "updates"),
  );
  mailbox.deliverInbound(queuedDispatch("c", "SECRET-c", "bob", "broadcast"));

  host.firePending();
  const snap = host.notices[0].message.details;

  const compact = buildNoticeCompact(snap);
  assert.ok(compact.includes("3 unread"));
  assert.ok(compact.includes("alice"));
  assert.ok(!compact.includes("SECRET"));

  const expanded = buildNoticeExpanded(snap);
  assert.equal(expanded.length, 3);
  for (const line of expanded) {
    assert.ok(!line.includes("SECRET"));
  }
  assert.ok(expanded[0].includes("a"));
  assert.ok(expanded[0].includes("alice"));
  assert.ok(expanded[1].includes("updates"));
  assert.ok(expanded[1].includes("channel"));
  assert.ok(expanded[2].includes("bob"));
  assert.ok(expanded[2].includes("broadcast"));
});

test("queued notices are metadata-only and never include bodies across kinds", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(
    queuedDispatch("d", "D-MARKER", "a", "direct", undefined, "me"),
  );
  mailbox.deliverInbound(queuedDispatch("br", "BR-MARKER", "a", "broadcast"));
  mailbox.deliverInbound(
    queuedDispatch("ch", "CH-MARKER", "a", "channel", "x"),
  );

  host.firePending();
  const notice = host.notices[0].message;
  for (const marker of ["D-MARKER", "BR-MARKER", "CH-MARKER"]) {
    assert.ok(!notice.content.includes(marker));
    assert.ok(!JSON.stringify(notice.details).includes(marker));
  }
});

test("queued notice provokes one non-steering awareness turn while idle", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = true;
  mailbox.deliverInbound(queuedDispatch("a", "1", "alice"));
  host.firePending();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].triggerTurn, true);
  // Hold for read decision only; no outbound action prescribed.
  assert.ok(
    host.notices[0].message.content.includes(
      "Decide for yourself whether reading",
    ),
  );
  assert.ok(
    host.notices[0].message.content.includes(
      "does not require a reply, acknowledgment, or any outbound action",
    ),
  );
});

test("queued active burst holds one pending notice and flushes the latest snapshot", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = false;

  // Three active arrivals each fire their debounce timer while the agent is
  // active, so they coalesce into a single pending notice rather than stale
  // intermediate snapshots [a], [a,b], [a,b,c].
  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  mailbox.deliverInbound(queuedDispatch("b", "body-b", "bob"));
  host.firePending();
  mailbox.deliverInbound(queuedDispatch("c", "body-c", "alice"));
  host.firePending();
  // Nothing delivered while the agent is active.
  assert.equal(host.notices.length, 0);

  host.idle = true;
  mailbox.settle();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].triggerTurn, true);
  // The single flushed notice is rebuilt from the current mailbox, so it is
  // the latest complete snapshot, not an accumulated list of stale ones.
  assert.deepEqual(
    host.notices[0].message.details.messages.map((m) => m.id),
    ["a", "b", "c"],
  );
  for (const marker of ["body-a", "body-b", "body-c"]) {
    assert.ok(!host.notices[0].message.content.includes(marker));
    assert.ok(
      !JSON.stringify(host.notices[0].message.details).includes(marker),
    );
  }
});

test("reads that empty the mailbox before a pending notice flush emit nothing", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = false;

  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  mailbox.deliverInbound(queuedDispatch("b", "body-b", "bob"));
  host.firePending();
  mailbox.deliverInbound(queuedDispatch("c", "body-c", "alice"));
  host.firePending();
  assert.equal(host.notices.length, 0);

  // The agent reads and removes everything before the settlement check.
  mailbox.read();
  host.idle = true;
  mailbox.settle();
  assert.equal(host.notices.length, 0);
  assert.equal(mailbox.size, 0);
});

test("queued arrival waits while idle with a queued continuation", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = true;
  host.pendingMessages = true;

  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  // A queued continuation holds the mailbox-awareness notice even though Pi is
  // momentarily idle between runs.
  assert.equal(host.notices.length, 0);

  mailbox.settle();
  assert.equal(host.notices.length, 0);

  host.pendingMessages = false;
  mailbox.settle();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].triggerTurn, true);
  assert.deepEqual(
    host.notices[0].message.details.messages.map((m) => m.id),
    ["a"],
  );
});

test("queued notice never steers or aborts, and is body-free", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = true;
  mailbox.deliverInbound(queuedDispatch("a", "SECRET-q", "alice"));
  host.firePending();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].triggerTurn, true);
  assert.ok(!host.notices[0].message.content.includes("SECRET-q"));
  assert.ok(
    !JSON.stringify(host.notices[0].message.details).includes("SECRET-q"),
  );
  // The host interface exposes no steer or abort path; nothing else recorded.
  assert.equal(host.immediates.length, 0);
});

test("settlement flushes once after the final agent_settled with no pending continuations", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);

  // Active run with queued continuations: the settled handler finds pending
  // messages and flushes nothing, leaving the next agent_settled to retry.
  host.idle = false;
  host.pendingMessages = true;
  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  mailbox.settle();
  assert.equal(host.notices.length, 0);

  // A queued continuation runs and ends; still pending, so still no flush.
  mailbox.settle();
  assert.equal(host.notices.length, 0);

  // The final continuation ends with the agent idle and nothing pending: the
  // settled event flushes exactly one latest notice.
  host.idle = true;
  host.pendingMessages = false;
  mailbox.settle();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].triggerTurn, true);
  assert.deepEqual(
    host.notices[0].message.details.messages.map((m) => m.id),
    ["a"],
  );
  assert.equal(host.pendingCount(), 0);
});

test("shutdown drops a pending settlement without flushing", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  host.idle = false;
  host.pendingMessages = true;
  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  mailbox.settle();
  // Shutdown clears the pending notice before terminal settlement.
  mailbox.shutdown();
  assert.equal(host.notices.length, 0);
  assert.equal(mailbox.size, 0);
});

test("settlement does not poll indefinitely while pending messages remain", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  // Active run holds the notice pending; queued continuations remain.
  host.idle = false;
  host.pendingMessages = true;
  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  host.firePending();
  assert.equal(host.notices.length, 0);
  // The agent ends but continuations remain; settlement flushes nothing and
  // does not reschedule itself.
  mailbox.settle();
  assert.equal(host.notices.length, 0);
  assert.equal(host.pendingCount(), 0);
  // The mailbox still holds the message for the next agent_settled to settle.
  assert.equal(mailbox.size, 1);
});

test("mailbox state survives a simulated listener stop/start with no reconnect method", () => {
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "body-a", "alice"));
  mailbox.deliverInbound(queuedDispatch("b", "body-b", "bob"));
  host.firePending();
  assert.equal(mailbox.size, 2);
  // Listener stop/start within the same extension runtime does not clear the
  // dispatcher; there is no reconnect() method to call.
  assert.equal(
    typeof (mailbox as unknown as { reconnect?: unknown }).reconnect,
    "undefined",
  );
  assert.equal(mailbox.size, 2);
  const result = mailbox.read();
  assert.deepEqual(
    result.read.map((m) => m.msgId),
    ["a", "b"],
  );
});

test("deriveInboundMetadata derives kind and labels in channel/direct/broadcast order", () => {
  const channel = deriveInboundMetadata({
    msg_id: "c1",
    from_name: "alice",
    text: "hi",
    channel: "updates",
  });
  assert.equal(channel?.kind, "channel");
  assert.equal(channel?.toInfo, "on updates");
  assert.equal(channel?.channel, "updates");

  const direct = deriveInboundMetadata({
    msg_id: "d1",
    from_name: "alice",
    text: "hi",
    to: "me",
  });
  assert.equal(direct?.kind, "direct");
  assert.equal(direct?.toInfo, "to me");
  assert.equal(direct?.target, "me");

  // Broadcast uses the `via broadcast` label, never `to undefined`.
  const broadcast = deriveInboundMetadata({
    msg_id: "b1",
    from_name: "alice",
    text: "hi",
  });
  assert.equal(broadcast?.kind, "broadcast");
  assert.equal(broadcast?.toInfo, "via broadcast");
  assert.equal(broadcast?.target, undefined);
});

test("parseIncoming strips an optional [from: name] prefix and deriveInboundMetadata uses it", () => {
  assert.deepEqual(parseIncoming("[from: bob] hello"), {
    from: "bob",
    text: "hello",
  });
  assert.deepEqual(parseIncoming("no prefix"), {
    from: null,
    text: "no prefix",
  });

  const meta = deriveInboundMetadata({
    msg_id: "p1",
    from_name: "server-name",
    text: "[from: bob] real body",
  });
  assert.equal(meta?.sender, "bob");
  assert.equal(meta?.body, "real body");
  assert.equal(meta?.kind, "broadcast");
});

test("deriveInboundMetadata returns null for a malformed frame so the caller can continue", () => {
  assert.equal(deriveInboundMetadata({ from_name: "a", text: "x" }), null);
  assert.equal(deriveInboundMetadata({ msg_id: "", text: "x" }), null);
  assert.equal(deriveInboundMetadata({ msg_id: 5, text: "x" }), null);
  // A later valid frame in the same chunk is still selectable when present.
  assert.ok(deriveInboundMetadata({ msg_id: "ok", text: "x" }));
});

test("immediate delivery carries the body while queued notices stay metadata-only", () => {
  const marker = "IMMEDIATE-vs-QUEUED-body";
  const hostQ = new FakeHost();
  const queued = makeDispatcher(hostQ, "queued", 0);
  queued.deliverInbound(queuedDispatch("q1", marker, "alice"));
  hostQ.firePending();
  assert.equal(hostQ.immediates.length, 0);
  assert.equal(hostQ.notices.length, 1);
  assert.ok(!hostQ.notices[0].message.content.includes(marker));
  assert.ok(!JSON.stringify(hostQ.notices[0].message.details).includes(marker));

  const hostI = new FakeHost();
  const immediate = makeDispatcher(hostI, "immediate", 0);
  hostI.idle = true;
  immediate.deliverInbound({
    ...queuedDispatch("i1", marker, "alice"),
    immediateMessage: immediateMessage("i1", marker, "alice"),
  });
  assert.equal(hostI.immediates.length, 1);
  assert.equal(hostI.notices.length, 0);
  assert.equal(hostI.immediates[0].message.details.text, marker);
  assert.equal(hostI.immediates[0].triggerTurn, true);
});

// ── Same-process reload handoff ─────────────────────────────────────────────

function reloadCycle(
  hostA: FakeHost,
  a: MailboxDispatcher,
  carrier: ReloadHandoffCarrier,
  session: string,
  now = 1000,
): {
  hostB: FakeHost;
  b: MailboxDispatcher;
  result: ReturnType<MailboxDispatcher["restoreReloadHandoff"]>;
} {
  a.exportReloadHandoff(session, carrier, now);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  const result = b.restoreReloadHandoff(session, carrier, now + 1);
  return { hostB, b, result };
}

test("reload preserves direct/broadcast/channel IDs, bodies, and arrival order", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(
    queuedDispatch("d1", "BODY-d1", "alice", "direct", undefined, "me"),
  );
  a.deliverInbound(queuedDispatch("b1", "BODY-b1", "bob", "broadcast"));
  a.deliverInbound(
    queuedDispatch("c1", "BODY-c1", "cara", "channel", "updates"),
  );
  // Read d1 before reload; it must not resurrect.
  const pre = a.read(["d1"]);
  assert.equal(pre.read.length, 1);

  const { b, result } = reloadCycle(hostA, a, carrier, SESSION);
  assert.equal(result.reason, "ok");
  assert.equal(result.restored, 2);
  assert.equal(b.size, 2);

  const one = b.read(["c1"]);
  assert.equal(one.read.length, 1);
  assert.equal(one.read[0].msgId, "c1");
  assert.equal(one.read[0].body, "BODY-c1");
  assert.equal(one.read[0].kind, "channel");
  assert.equal(one.read[0].channel, "updates");

  const rest = b.read();
  assert.deepEqual(
    rest.read.map((m) => m.msgId),
    ["b1"],
  );
  assert.equal(rest.read[0].body, "BODY-b1");
  // d1 was read pre-reload; it is missing/not unread after reload.
  assert.deepEqual(b.read(["d1"]).missing, ["d1"]);
  assert.equal(b.size, 0);
});

test("reload preserves 128-entry overflow state and the next eviction order", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  for (let i = 0; i <= MAILBOX_MAX_UNREAD; i++) {
    a.deliverInbound(queuedDispatch(`m-${i}`, `body-${i}`, "peer"));
  }
  assert.equal(a.size, MAILBOX_MAX_UNREAD);

  const { b, result } = reloadCycle(hostA, a, carrier, SESSION);
  assert.equal(result.reason, "ok");
  assert.equal(b.size, MAILBOX_MAX_UNREAD);
  // The evicted m-0 does not resurrect after reload.
  const snap = b.snapshot();
  assert.ok(!snap.messages.some((m) => m.id === "m-0"));
  assert.equal(snap.messages[0].id, "m-1");
  assert.equal(snap.messages[127].id, `m-${MAILBOX_MAX_UNREAD}`);

  // A post-reload arrival evicts the oldest remaining (m-1), not a resurrected one.
  b.deliverInbound(queuedDispatch("new", "body-new", "peer"));
  assert.equal(b.size, MAILBOX_MAX_UNREAD);
  const all = b.read().read.map((m) => m.msgId);
  assert.ok(!all.includes("m-1"));
  assert.ok(all.includes("new"));
  assert.equal(all[0], "m-2");
  assert.equal(all[all.length - 1], "new");
});

test("reload export happens before clear; stale pre-reload timers cannot reach the new runtime", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 200);
  a.deliverInbound(queuedDispatch("a1", "BODY-a1", "alice"));
  // A pending debounce timer is queued but has not fired yet.
  assert.equal(hostA.pendingCount(), 1);
  a.exportReloadHandoff(SESSION, carrier);
  // Export captures unread before shutdown clears/cancels.
  assert.equal(carrier.slot?.messages.length, 1);
  a.shutdown();
  assert.equal(hostA.pendingCount(), 0);
  // A stale timer firing against the discarded runtime no-ops via generation.
  hostA.firePending();
  assert.equal(hostA.notices.length, 0);

  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  const result = b.restoreReloadHandoff(SESSION, carrier);
  assert.equal(result.reason, "ok");
  // Stale A callbacks/flushes cannot emit into hostB.
  hostA.firePending();
  a.settle();
  assert.equal(hostB.notices.length, 0);
  // The single restored unread is still readable.
  assert.equal(b.read().read[0].body, "BODY-a1");
});

test("reload handoff is one-use and cannot duplicate on repeated restore", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("x1", "BODY-x1", "alice"));
  const { b, result } = reloadCycle(hostA, a, carrier, SESSION);
  assert.equal(result.reason, "ok");
  assert.equal(b.size, 1);

  // A second matching reload start finds the carrier empty (one-use).
  const hostC = new FakeHost();
  const c = makeDispatcher(hostC, "queued", 0);
  const second = c.restoreReloadHandoff(SESSION, carrier);
  assert.equal(second.reason, "missing");
  assert.equal(c.size, 0);
});

test("reload carrier is the process-global survivor across a fresh module instance", () => {
  // The real carrier backs a private globalThis symbol. Two dispatchers in the
  // same process (a fresh module instance) share it without module-local state.
  const carrier = createProcessGlobalHandoffCarrier();
  try {
    carrier.reset();
    const hostA = new FakeHost();
    const a = makeDispatcher(hostA, "queued", 0);
    a.deliverInbound(queuedDispatch("g1", "BODY-g1", "alice"));
    a.exportReloadHandoff(SESSION, carrier);
    a.shutdown();
    // A brand-new dispatcher (simulated reloaded module) restores via the same
    // process-global carrier; no module-local variable is consulted.
    const hostB = new FakeHost();
    const b = makeDispatcher(hostB, "queued", 0);
    const result = b.restoreReloadHandoff(SESSION, carrier);
    assert.equal(result.reason, "ok");
    assert.equal(b.read().read[0].body, "BODY-g1");
    // The carrier is empty after one-use consumption.
    assert.equal(carrier.take().handoff, null);
  } finally {
    carrier.reset();
  }
});

test("reload restore fails closed for missing, malformed, incompatible, session, generation, and expired", () => {
  const carrier = new FakeCarrier();
  const host = new FakeHost();
  const b = makeDispatcher(host, "queued", 0);

  // Missing handoff.
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "missing");

  // Malformed carrier (tampered shape).
  const malformed = { v: "no" } as unknown as ReloadHandoff;
  carrier.gen = 5;
  carrier.store(malformed);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "malformed");
  assert.equal(b.size, 0);

  // Incompatible version (and capacity).
  carrier.gen = 0;
  carrier.store({
    v: 999,
    gen: 1,
    session: SESSION,
    storedAt: 1000,
    maxUnread: MAILBOX_MAX_UNREAD,
    messages: [],
    seq: 0,
    noticeCurrent: false,
  });
  assert.equal(
    b.restoreReloadHandoff(SESSION, carrier, 1001).reason,
    "incompatible",
  );
  carrier.gen = 0;
  carrier.store({
    v: RELOAD_HANDOFF_VERSION,
    gen: 1,
    session: SESSION,
    storedAt: 1000,
    maxUnread: 50,
    messages: [],
    seq: 0,
    noticeCurrent: false,
  });
  assert.equal(
    b.restoreReloadHandoff(SESSION, carrier, 1001).reason,
    "incompatible",
  );

  // Mismatched session (snapshot is otherwise well-formed so this is the
  // session check that fails, not a malformed-shape check).
  carrier.gen = 0;
  carrier.store({
    v: RELOAD_HANDOFF_VERSION,
    gen: 1,
    session: "other-session",
    storedAt: 1000,
    maxUnread: MAILBOX_MAX_UNREAD,
    messages: [
      {
        msgId: "s1",
        sender: "alice",
        body: "SECRET-s",
        kind: "direct",
        arrival: 0,
      },
    ],
    seq: 1,
    noticeCurrent: false,
  });
  const sessionResult = b.restoreReloadHandoff(SESSION, carrier, 1001);
  assert.equal(sessionResult.reason, "session");
  assert.equal(b.size, 0);
  // No body disclosed.
  assert.equal(host.notices.length, 0);
  assert.equal(host.immediates.length, 0);

  // Mismatched generation (handoff gen != carrier generation at take).
  carrier.gen = 0;
  carrier.store({
    v: RELOAD_HANDOFF_VERSION,
    gen: 1,
    session: SESSION,
    storedAt: 1000,
    maxUnread: MAILBOX_MAX_UNREAD,
    messages: [],
    seq: 0,
    noticeCurrent: false,
  });
  carrier.gen = 99; // tamper after store
  assert.equal(
    b.restoreReloadHandoff(SESSION, carrier, 1001).reason,
    "generation",
  );

  // Expired handoff.
  carrier.gen = 0;
  carrier.store({
    v: RELOAD_HANDOFF_VERSION,
    gen: 1,
    session: SESSION,
    storedAt: 1000,
    maxUnread: MAILBOX_MAX_UNREAD,
    messages: [],
    seq: 0,
    noticeCurrent: false,
  });
  assert.equal(
    b.restoreReloadHandoff(SESSION, carrier, 1000 + RELOAD_HANDOFF_TTL_MS + 1)
      .reason,
    "expired",
  );
});

test("non-reload lifecycle clears the handoff so a later reload starts empty", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("q1", "BODY-q1", "alice"));
  a.exportReloadHandoff(SESSION, carrier);
  // A quit/new/resume/fork shutdown clears the pending handoff (fail closed).
  carrier.reset();
  a.shutdown();

  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  const result = b.restoreReloadHandoff(SESSION, carrier);
  assert.equal(result.reason, "missing");
  assert.equal(b.size, 0);
  // The old unread id reports missing/not unread.
  assert.deepEqual(b.read(["q1"]).missing, ["q1"]);
});

test("listener disconnect/reconnect inside one runtime never uses the reload carrier", () => {
  const carrier = new FakeCarrier();
  const host = new FakeHost();
  const mailbox = makeDispatcher(host, "queued", 0);
  mailbox.deliverInbound(queuedDispatch("a", "BODY-a", "alice"));
  mailbox.deliverInbound(queuedDispatch("b", "BODY-b", "bob"));
  // An in-runtime stop/start (no shutdown) does not export or clear the carrier.
  assert.equal(carrier.slot, null);
  assert.equal(carrier.getGeneration(), 0);
  assert.equal(mailbox.size, 2);
  const result = mailbox.read();
  assert.deepEqual(
    result.read.map((m) => m.msgId),
    ["a", "b"],
  );
  assert.equal(carrier.slot, null);
});

test("config delivery mode reapplies after reload while restored unread stay queued", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("keep", "BODY-keep", "alice"));

  // The reloaded module recomputes mode from current config -> immediate.
  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "immediate", 0);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "ok");
  assert.equal(b.size, 1); // restored unread remain queued and unread
  assert.equal(b.getDeliveryMode(), "immediate");

  // A new arrival in the reapplied immediate mode is delivered immediately, not queued.
  hostB.idle = true;
  b.deliverInbound({
    ...queuedDispatch("fresh", "BODY-fresh", "bob"),
    immediateMessage: immediateMessage("fresh", "BODY-fresh", "bob"),
  });
  assert.equal(hostB.immediates.length, 1);
  assert.equal(b.size, 1); // the fresh body did not enter the unread mailbox
  // Restored unread is still readable.
  const rest = b.read();
  assert.equal(rest.read[0].msgId, "keep");
  assert.equal(rest.read[0].body, "BODY-keep");
});

test("pending immediate bodies are not preserved across reload", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "immediate", 0);
  hostA.idle = false;
  a.deliverInbound({
    ...queuedDispatch("imm1", "SECRET-imm", "alice"),
    immediateMessage: immediateMessage("imm1", "SECRET-imm", "alice"),
  });
  assert.equal(hostA.immediates.length, 0);

  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "immediate", 0);
  const result = b.restoreReloadHandoff(SESSION, carrier);
  assert.equal(result.reason, "ok");
  assert.equal(result.restored, 0);
  assert.equal(b.size, 0);
  // The pending immediate body from the old runtime never reached the new one.
  assert.equal(hostB.immediates.length, 0);
});

test("reload restores exactly one body-free notice when none had entered context", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 200);
  a.deliverInbound(queuedDispatch("n1", "BODY-n1", "alice"));
  a.deliverInbound(queuedDispatch("n2", "BODY-n2", "bob"));
  // The debounce notice has not fired yet, so no awareness notice entered context.
  assert.equal(hostA.notices.length, 0);

  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "ok");
  hostB.idle = true;
  b.settle();
  // Exactly one latest complete body-free awareness turn is restored.
  assert.equal(hostB.notices.length, 1);
  assert.equal(hostB.notices[0].triggerTurn, true);
  const notice = hostB.notices[0].message;
  assert.equal(notice.details.unread, 2);
  assert.deepEqual(
    notice.details.messages.map((m: { id: string }) => m.id),
    ["n1", "n2"],
  );
  assert.ok(!notice.content.includes("BODY-n1"));
  assert.ok(!notice.content.includes("BODY-n2"));
  assert.ok(!JSON.stringify(notice.details).includes("BODY"));
  // A second settle does not duplicate the awareness turn.
  b.settle();
  assert.equal(hostB.notices.length, 1);

  // The restored unread are still readable in arrival order.
  const rest = b.read();
  assert.deepEqual(
    rest.read.map((m) => m.msgId),
    ["n1", "n2"],
  );
});

test("reload adds no notice when the latest complete snapshot already entered context and no later arrival pends", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("e1", "BODY-e1", "alice"));
  hostA.firePending(); // idle -> awareness notice for [e1] delivered
  assert.equal(hostA.notices.length, 1);
  assert.equal(hostA.notices[0].message.details.unread, 1);

  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "ok");
  assert.equal(b.size, 1);
  hostB.idle = true;
  b.settle();
  // The latest complete unread snapshot already covered [e1]; reload adds none.
  assert.equal(hostB.notices.length, 0);
  const rest = b.read();
  assert.deepEqual(
    rest.read.map((m) => m.msgId),
    ["e1"],
  );
});

test("reload emits exactly one latest body-free notice after a notice entered context and a later arrival pends", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("e1", "BODY-e1", "alice"));
  hostA.firePending(); // notice for [e1] delivered (current)
  assert.equal(hostA.notices.length, 1);
  // A later arrival makes the prior snapshot stale, even while a notice was
  // already delivered; its awareness notice has not yet entered context.
  hostA.idle = false;
  hostA.pendingMessages = true;
  a.deliverInbound(queuedDispatch("e2", "BODY-e2", "bob"));
  hostA.firePending(); // holds one pending notice while active
  assert.equal(hostA.notices.length, 1);

  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "ok");
  assert.equal(b.size, 2);
  hostB.idle = true;
  b.settle();
  // Exactly one latest body-free notice covering the present unread set [e1,e2].
  assert.equal(hostB.notices.length, 1);
  assert.equal(hostB.notices[0].triggerTurn, true);
  const notice = hostB.notices[0].message;
  assert.equal(notice.details.unread, 2);
  assert.deepEqual(
    notice.details.messages.map((m: { id: string }) => m.id),
    ["e1", "e2"],
  );
  assert.ok(!notice.content.includes("BODY-e1"));
  assert.ok(!notice.content.includes("BODY-e2"));
  b.settle(); // no duplicate
  assert.equal(hostB.notices.length, 1);
  const rest = b.read();
  assert.deepEqual(
    rest.read.map((m) => m.msgId),
    ["e1", "e2"],
  );
});

test("reload announces only a later unread arrival when an earlier noticed one was read", () => {
  const carrier = new FakeCarrier();
  const hostA = new FakeHost();
  const a = makeDispatcher(hostA, "queued", 0);
  a.deliverInbound(queuedDispatch("e1", "BODY-e1", "alice"));
  hostA.firePending(); // notice for [e1] delivered (current)
  // The agent reads e1, then a later arrival e2 is queued; the prior snapshot is
  // staled by the new arrival and held pending while active (not yet sent).
  a.read(["e1"]);
  hostA.idle = false;
  hostA.pendingMessages = true;
  a.deliverInbound(queuedDispatch("e2", "BODY-e2", "bob"));
  hostA.firePending();

  a.exportReloadHandoff(SESSION, carrier);
  a.shutdown();
  const hostB = new FakeHost();
  const b = makeDispatcher(hostB, "queued", 0);
  assert.equal(b.restoreReloadHandoff(SESSION, carrier).reason, "ok");
  assert.equal(b.size, 1);
  hostB.idle = true;
  b.settle();
  // Only e2 is unread and unpublished; the read e1 is not resurrected.
  assert.equal(hostB.notices.length, 1);
  const notice = hostB.notices[0].message;
  assert.equal(notice.details.unread, 1);
  assert.deepEqual(
    notice.details.messages.map((m: { id: string }) => m.id),
    ["e2"],
  );
  assert.ok(!notice.content.includes("BODY-e1"));
  assert.ok(!notice.content.includes("BODY-e2"));
  const rest = b.read();
  assert.deepEqual(
    rest.read.map((m) => m.msgId),
    ["e2"],
  );
});

// ── Malformed-carrier validation (fail closed, one-use, body-silent) ────────

function validMessage(
  id: string,
  arrival: number,
  body = `BODY-${id}`,
  extra: Partial<{ kind: MessageKind; channel?: string; target?: string }> = {},
): MailboxMessage {
  return {
    msgId: id,
    sender: "alice",
    body,
    kind: extra.kind ?? "direct",
    channel: extra.channel,
    target: extra.target,
    arrival,
  };
}

function baseHandoff(over: Partial<ReloadHandoff>): ReloadHandoff {
  return {
    v: RELOAD_HANDOFF_VERSION,
    gen: 1,
    session: SESSION,
    storedAt: 1000,
    maxUnread: MAILBOX_MAX_UNREAD,
    messages: [],
    seq: 0,
    noticeCurrent: false,
    ...over,
  } as ReloadHandoff;
}

function assertMalformed(
  label: string,
  over: Partial<ReloadHandoff>,
  now = 1001,
): void {
  const carrier = new FakeCarrier();
  const host = new FakeHost();
  const b = makeDispatcher(host, "queued", 0);
  carrier.gen = 0;
  carrier.store(baseHandoff(over));
  const result = b.restoreReloadHandoff(SESSION, carrier, now);
  assert.equal(result.reason, "malformed", label);
  assert.equal(b.size, 0, `${label}: mailbox stayed empty`);
  // One-use: the carrier slot was consumed regardless.
  assert.equal(carrier.slot, null, `${label}: carrier consumed`);
  // Body-silent: no notice or immediate disclosure even for failing snapshots.
  assert.equal(host.notices.length, 0, `${label}: no notice`);
  assert.equal(host.immediates.length, 0, `${label}: no immediate`);
}

test("malformed-carrier scalar fields fail closed without body disclosure", () => {
  assertMalformed("gen NaN", { gen: Number.NaN });
  assertMalformed("gen non-integer", { gen: 1.5 });
  assertMalformed("gen negative", { gen: -1 });
  assertMalformed("gen non-number string", { gen: "1" as unknown as number });
  assertMalformed("storedAt NaN", { storedAt: Number.NaN });
  assertMalformed("storedAt non-integer", { storedAt: 1.5 });
  assertMalformed("storedAt negative", { storedAt: -1 });
  assertMalformed("seq NaN", { seq: Number.NaN });
  assertMalformed("seq non-integer", { seq: 2.5 });
  assertMalformed("seq negative", { seq: -1 });
  assertMalformed("arrival NaN", {
    messages: [validMessage("a", Number.NaN)],
    seq: 1,
  });
  assertMalformed("arrival non-integer", {
    messages: [validMessage("a", 0.5)],
    seq: 1,
  });
  assertMalformed("arrival negative", {
    messages: [validMessage("a", -1)],
    seq: 1,
  });
  assertMalformed("arrival non-number", {
    messages: [{ ...validMessage("a", 0), arrival: "0" as unknown as number }],
    seq: 1,
  });
});

test("malformed-carrier message-level fields fail closed", () => {
  assertMalformed("duplicate ids", {
    messages: [validMessage("dup", 0), validMessage("dup", 1)],
    seq: 2,
  });
  assertMalformed("unordered arrivals", {
    messages: [validMessage("b", 2), validMessage("a", 1)],
    seq: 3,
  });
  assertMalformed("duplicate arrival values", {
    messages: [validMessage("a", 1), validMessage("b", 1)],
    seq: 2,
  });
  assertMalformed("invalid channel type", {
    messages: [{ ...validMessage("a", 0), channel: 9 as unknown as string }],
    seq: 1,
  });
  assertMalformed("invalid target type", {
    messages: [{ ...validMessage("a", 0), target: null as unknown as string }],
    seq: 1,
  });
  assertMalformed("invalid kind", {
    messages: [{ ...validMessage("a", 0), kind: "nope" as MessageKind }],
    seq: 1,
  });
  assertMalformed("empty msgId", {
    messages: [{ ...validMessage("a", 0), msgId: "" }],
    seq: 1,
  });
  assertMalformed("non-string body", {
    messages: [{ ...validMessage("a", 0), body: 5 as unknown as string }],
    seq: 1,
  });
});

test("malformed-carrier seq/arrival consistency fails closed while valid empty/evicted histories restore", () => {
  // seq inconsistent with a non-empty snapshot.
  assertMalformed("seq not max+1", {
    messages: [validMessage("a", 0), validMessage("b", 1)],
    seq: 5,
  });
  assertMalformed("seq too low", {
    messages: [validMessage("a", 0), validMessage("b", 1)],
    seq: 1,
  });

  // Valid empty history restores with any non-negative seq.
  {
    const carrier = new FakeCarrier();
    const host = new FakeHost();
    const b = makeDispatcher(host, "queued", 0);
    carrier.gen = 0;
    carrier.store(baseHandoff({ messages: [], seq: 0 }));
    assert.equal(b.restoreReloadHandoff(SESSION, carrier, 1001).reason, "ok");
    assert.equal(b.size, 0);
    carrier.gen = 0;
    carrier.store(baseHandoff({ messages: [], seq: 42 }));
    assert.equal(b.restoreReloadHandoff(SESSION, carrier, 1001).reason, "ok");
  }

  // Valid evicted history: arrivals start beyond 0 and seq is one past the newest.
  {
    const carrier = new FakeCarrier();
    const host = new FakeHost();
    const b = makeDispatcher(host, "queued", 0);
    const msgs: MailboxMessage[] = [];
    for (let i = 10; i < 10 + 3; i++) msgs.push(validMessage(`m-${i}`, i));
    carrier.gen = 0;
    carrier.store(baseHandoff({ messages: msgs, seq: 13 }));
    const res = b.restoreReloadHandoff(SESSION, carrier, 1001);
    assert.equal(res.reason, "ok");
    assert.equal(b.size, 3);
    // Post-reload arrival continues from the restored seq (13) and evicts oldest.
    for (let i = 0; i <= MAILBOX_MAX_UNREAD; i++) {
      b.deliverInbound(queuedDispatch(`n-${i}`, `body-${i}`, "peer"));
    }
    assert.equal(b.size, MAILBOX_MAX_UNREAD);
    const all = b.read().read.map((m) => m.msgId);
    assert.ok(!all.includes("m-10")); // oldest restored was evicted, not resurrected
  }
});
