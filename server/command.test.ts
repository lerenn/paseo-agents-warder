import { describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { parseCommand, runCommand } from "./command";
import { Engine, type Actions } from "./engine";
import { Store } from "./store";

const MIN = 60_000;

function setup() {
  let t = 1_000_000;
  const sent: { to: string; text: string }[] = [];
  const watched = new Set<string>();
  const actions: Actions = {
    async send(to, text) {
      sent.push({ to, text });
    },
    watch: (id) => void watched.add(id),
    unwatch: (id) => void watched.delete(id),
  };
  const settings = settingsSchema.parse({ globalGapSeconds: 1 });
  const store = new Store(null);
  const engine = new Engine(store, actions, () => settings, () => t);
  return { engine, store, sent, watched, advance: (ms: number) => (t += ms) };
}

describe("parseCommand", () => {
  it("parses the forms", () => {
    expect(parseCommand("")).toEqual({ kind: "status" });
    expect(parseCommand("stop").kind).toBe("stop");
    expect(parseCommand("done").kind).toBe("stop");
    expect(parseCommand("supervise").kind).toBe("supervise");
    expect(parseCommand("supervise stop").kind).toBe("supervise-stop");
    expect(parseCommand("wait for CI")).toEqual({ kind: "watch", task: "wait for CI", intervalMinutes: undefined });
    expect(parseCommand("--interval 5 wait for CI")).toMatchObject({ task: "wait for CI", intervalMinutes: 5 });
    expect(parseCommand("wait for CI --interval=7m")).toMatchObject({ task: "wait for CI", intervalMinutes: 7 });
  });
  it("rejects a bad interval or an empty task", () => {
    expect(() => parseCommand("x --interval soon")).toThrow(/--interval/);
    expect(() => parseCommand("--interval 5")).toThrow(/Usage/);
  });
});

describe("runCommand", () => {
  it("registers a task as the user, steers the agent, then stops it", async () => {
    const { engine, store, sent, watched } = setup();
    const message = await runCommand(engine, "a", parseCommand("deploy --interval 5"));
    const [task] = store.active("a");
    expect(task).toMatchObject({ registeredBy: "user", source: "user", intervalMinutes: 5, task: "deploy" });
    expect(watched.has("a")).toBe(true);
    expect(message).toContain("watching");
    expect(sent[0].to).toBe("a");
    expect(sent[0].text).toContain(`warder_done with task_id ${task.id}`);
    expect(engine.views()[0].registeredBy).toBe("user");

    expect(await runCommand(engine, "a", parseCommand(""))).toContain("deploy");
    await runCommand(engine, "a", parseCommand("stop"));
    expect(store.active("a")).toEqual([]);
    expect(store.get(task.id)?.state).toBe("cancelled");
    expect(sent).toHaveLength(2);
    expect(await runCommand(engine, "a", parseCommand("stop"))).toContain("nothing to stop");
  });

  it("pings a user-registered task 1 min after the agent stops", async () => {
    const { engine, sent, advance } = setup();
    await runCommand(engine, "a", parseCommand("deploy"));
    sent.length = 0;
    engine.turnStarted("a");
    engine.turnEnded("a");
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("not finished");
  });
});

describe("supervise", () => {
  const child = (store: Store, id: string, parent = "boss") => store.upsertAgent(id, { title: `child ${id}`, parentId: parent });

  it("stays silent while children run, and never pings the coordinator for idling itself", async () => {
    const { engine, store, sent, advance } = setup();
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnStarted("boss");
    engine.turnEnded("boss");
    advance(10 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });

  it("pings after the react delay when a child finishes, once", async () => {
    const { engine, store, sent, advance } = setup();
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.childSeen("c1");
    engine.turnStarted("c1");
    advance(MIN);
    engine.turnEnded("c1");
    advance(4 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("boss");
    expect(sent[0].text).toContain("child c1");
    expect(sent[0].text).toContain("finished its turn");
    advance(30 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
  });

  it("does not ping when the coordinator prompted the child, but not for warder's own message", async () => {
    const { engine, store, sent, advance } = setup();
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    child(store, "c2");
    for (const id of ["c1", "c2"]) {
      engine.turnStarted(id);
      engine.turnEnded(id);
    }
    advance(MIN);
    engine.userMessage("c1");
    advance(6 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("child c2");
    expect(sent[0].text).not.toContain("child c1");
  });

  it("flags a permission request, clears when answered, and a hung running child", async () => {
    const { engine, store, sent, advance } = setup();
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    child(store, "c2");
    engine.turnStarted("c1");
    engine.turnStarted("c2");
    engine.permission("c1", true);
    advance(6 * MIN);
    await engine.tick();
    expect(sent[0].text).toContain("permission request");
    expect(engine.supervisionViews()[0]).toMatchObject({ children: 2, needAttention: 1 });
    engine.permission("c1", false);
    expect(engine.supervisionViews()[0].needAttention).toBe(0);
    advance(10 * MIN);
    expect(engine.supervisionViews()[0].needAttention).toBe(0); // hang check + react not reached yet
    advance(6 * MIN);
    engine.activity("c1");
    await engine.tick();
    expect(sent.at(-1)!.text).toContain("child c2");
    expect(sent.at(-1)!.text).toContain("no activity");
  });

  it("ignores archived children and stops on /warder supervise stop", async () => {
    const { engine, store, sent, advance } = setup();
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    engine.agentArchived("c1");
    advance(10 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.supervisionViews()[0].children).toBe(0);
    await runCommand(engine, "boss", parseCommand("supervise stop"));
    expect(engine.supervisionViews()).toEqual([]);
  });
});
