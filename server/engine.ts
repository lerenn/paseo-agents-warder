import type { WarderSettings } from "../shared/settings";
import type { TaskStatus, TaskView } from "../shared/task";
import { render } from "./template";
import type { Store, Task } from "./store";

/** What the engine does to the outside world; the plugin wires it to the Paseo SDK. */
export interface Actions {
  send(agentId: string, text: string): Promise<void>;
  /** Start/stop observing an agent's timeline; activity must be reported through `Engine.activity`. */
  watch(agentId: string): void;
  unwatch(agentId: string): void;
}

export class Engine {
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private readonly permissions = new Set<string>();
  /** Agents whose turn is running, and when idle agents' last turn ended. Unknown agents are in neither. */
  private readonly running = new Set<string>();
  private readonly idleSince = new Map<string, number>();

  constructor(
    readonly store: Store,
    private readonly actions: Actions,
    private readonly settings: () => WarderSettings | null,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- registration ----

  register(input: { agentId: string; task: string; intervalMinutes: number; until: number | null; registeredBy: string; source: Task["source"] }): Task {
    const task = this.store.add({ ...input, intervalMinutes: this.effectiveMinutes(input) }, this.now());
    this.actions.watch(task.agentId);
    return task;
  }

  /** Re-attach observers after a restart. */
  resume(): void {
    for (const agentId of new Set(this.store.active().map((t) => t.agentId))) this.actions.watch(agentId);
  }

  finish(task: Task, state: Task["state"], result: string | null = null): void {
    task.state = state;
    task.result = result ?? task.result;
    task.endedAt = this.now();
    this.store.save();
    if (this.store.active(task.agentId).length === 0) this.actions.unwatch(task.agentId);
  }

  note(task: Task, text: string): void {
    task.notes = [...task.notes, { at: this.now(), text }].slice(-5);
    this.markActive(task);
    this.store.save();
  }

  // ---- inputs from lifecycle and timeline ----

  /** Any activity of the agent other than warder's own prompt. */
  activity(agentId: string): void {
    for (const task of this.store.active(agentId)) this.markActive(task);
  }

  turnStarted(agentId: string): void {
    this.running.add(agentId);
    this.idleSince.delete(agentId);
    this.activity(agentId);
  }

  turnEnded(agentId: string): void {
    this.running.delete(agentId);
    this.idleSince.set(agentId, this.now());
    this.activity(agentId);
  }

  permission(agentId: string, pending: boolean): void {
    if (pending) this.permissions.add(agentId);
    else this.permissions.delete(agentId);
    this.activity(agentId);
  }

  agentArchived(agentId: string): void {
    this.permissions.delete(agentId);
    this.running.delete(agentId);
    this.idleSince.delete(agentId);
    for (const task of this.store.active(agentId)) this.finish(task, "archived");
  }

  private markActive(task: Task): void {
    task.lastActivityAt = this.now();
    task.unanswered = 0;
    task.notifiedParent = false;
    if (task.state === "gave-up") task.state = "active";
  }

  // ---- evaluation ----

  private waitMs(task: Task, s: WarderSettings): number {
    const factor = Math.min(s.backoffFactor ** task.unanswered, s.maxBackoffIntervals);
    return this.effectiveMinutes(task, s) * 60_000 * factor;
  }

  /** The registered interval, clamped to the max setting. */
  private effectiveMinutes(task: { intervalMinutes: number }, s: WarderSettings | null = this.settings()): number {
    return s ? Math.min(task.intervalMinutes, s.maxIntervalMinutes) : task.intervalMinutes;
  }

  /** Backstop used when an agent registers without an interval. */
  defaultIntervalMinutes(): number {
    return this.settings()?.maxIntervalMinutes ?? 15;
  }

  private turnState(agentId: string): TaskView["turn"] {
    if (this.permissions.has(agentId)) return "waiting-permission";
    if (this.running.has(agentId)) return "running";
    return this.idleSince.has(agentId) ? "idle" : "unknown";
  }

  private quietMs(task: Task): number {
    return this.now() - Math.max(task.lastActivityAt, task.lastPingAt ?? 0);
  }

  /**
   * Evaluate every active task once. At most one prompt leaves per call, and none within
   * `globalGapSeconds` of the previous one, so a mass stall can never become a broadcast.
   */
  async tick(): Promise<void> {
    const s = this.settings();
    if (!s?.enabled || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const task of this.store.active()) {
        if (task.until !== null && now >= task.until) this.finish(task, "expired");
      }
      const due = this.store
        .active()
        .filter((t) => !this.store.optedOut(t.agentId) && !this.permissions.has(t.agentId))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      if (now - this.lastSendAt < s.globalGapSeconds * 1000) return;
      for (const task of due) {
        if (await this.step(task, s)) return;
      }
    } finally {
      this.busy = false;
    }
  }

  private async step(task: Task, s: WarderSettings): Promise<boolean> {
    const parentId = this.store.agent(task.agentId)?.parentId ?? null;
    if (task.unanswered >= s.notifyParentAfterPings && !task.notifiedParent && parentId) {
      task.notifiedParent = true;
      this.store.save();
      await this.deliver(parentId, render(s.parentTemplate, this.vars(task)));
      return true;
    }
    const idle = this.idleSince.get(task.agentId);
    const idleAgent = idle !== undefined && !this.running.has(task.agentId);
    if (idleAgent) {
      // Turn over, task still open: ping after the grace period, then back off like any other ping.
      if (this.now() - idle < s.idleGraceSeconds * 1000) return false;
      if (task.unanswered > 0 && this.quietMs(task) < this.waitMs(task, s)) return false;
    } else if (this.quietMs(task) < this.waitMs(task, s)) return false;
    if (task.unanswered >= s.maxUnansweredPings) {
      task.state = "gave-up";
      this.store.save();
      return false;
    }
    task.unanswered += 1;
    task.pings += 1;
    task.lastPingAt = this.now();
    this.store.save();
    await this.deliver(task.agentId, render(idleAgent ? s.idlePingTemplate : s.pingTemplate, this.vars(task)));
    return true;
  }

  private async deliver(agentId: string, text: string): Promise<void> {
    this.lastSendAt = this.now();
    try {
      await this.actions.send(agentId, text);
    } catch (error) {
      console.error(`warder: prompt to ${agentId} failed`, error);
    }
  }

  private vars(task: Task): Record<string, string | number> {
    const agent = this.store.agent(task.agentId);
    return {
      task: task.task,
      taskId: task.id,
      agentId: task.agentId,
      title: agent?.title ?? task.agentId,
      pings: task.pings,
      minutes: Math.max(1, Math.round((this.now() - (this.idleSince.get(task.agentId) ?? task.lastActivityAt)) / 60_000)),
    };
  }

  // ---- screen ----

  status(task: Task): TaskStatus {
    if (task.state !== "active") return task.state;
    if (this.permissions.has(task.agentId)) return "waiting-permission";
    if (task.notifiedParent) return "escalated";
    return task.unanswered > 0 ? "pinged" : "ok";
  }

  views(): TaskView[] {
    return this.store.all().map((t) => {
      const agent = this.store.agent(t.agentId);
      return {
        id: t.id,
        agentId: t.agentId,
        agentTitle: agent?.title ?? null,
        parentId: agent?.parentId ?? null,
        workspaceId: agent?.workspaceId ?? null,
        projectName: agent?.projectName ?? null,
        workspaceName: agent?.workspaceName ?? null,
        task: t.task,
        intervalMinutes: this.effectiveMinutes(t),
        turn: this.turnState(t.agentId),
        idleSince: this.idleSince.get(t.agentId) ?? null,
        until: t.until,
        registeredBy: t.registeredBy,
        source: t.source,
        status: this.status(t),
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt,
        lastPingAt: t.lastPingAt,
        pings: t.pings,
        unanswered: t.unanswered,
        notes: t.notes,
        result: t.result,
      };
    });
  }
}
