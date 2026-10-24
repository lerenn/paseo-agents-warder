import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cancelTaskRpc, listTasksRpc } from "../shared/rpc";
import type { TaskStatus, TaskView } from "../shared/task";

function ago(now: number, at: number | null): string {
  if (at === null) return "never";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

function turnLabel(t: TaskView, now: number): string {
  switch (t.turn) {
    case "running":
      return "running";
    case "idle":
      return `idle since ${t.idleSince ? Math.max(0, Math.round((now - t.idleSince) / 60_000)) : 0}m`;
    case "waiting-permission":
      return "waiting for permission";
    default:
      return "turn state unknown";
  }
}

type Colors = PluginScreenProps["theme"]["colors"];

/** Badge color per status, taken from the theme so it works in every theme. */
function badgeColor(status: TaskStatus, c: Colors): string {
  switch (status) {
    case "ok":
      return c.statusSuccess;
    case "pinged":
      return c.statusWarning;
    case "escalated":
    case "gave-up":
      return c.statusDanger;
    case "waiting-permission":
      return c.accent;
    case "done":
      return c.statusSuccess;
    default:
      return c.foregroundMuted;
  }
}

/** Soft tinted background for a #rrggbb color; other formats fall back to no fill. */
function tint(color: string, alpha: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : undefined;
}

const ACTIVE: TaskStatus[] = ["ok", "pinged", "escalated", "waiting-permission"];

function StatusBadge({ status, styles, colors }: { status: TaskStatus; styles: any; colors: Colors }) {
  const color = badgeColor(status, colors);
  const fill = tint(color, "26");
  return (
    <View accessibilityLabel={`Status: ${status}`} style={[styles.badge, { borderColor: tint(color, "66") ?? color }, fill ? { backgroundColor: fill } : null]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{status}</Text>
    </View>
  );
}

/** Chevron header that shows its children only while open; closed by default. */
function Collapsible({ title, summary, styles, children }: { title: string; summary?: string; styles: any; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen((v) => !v)}>
        <Text style={styles.h}>
          {open ? "▾" : "▸"} {title}
          {summary ? ` · ${summary}` : ""}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function WarderScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listTasksRpc);
  const cancel = useRpc(cancelTaskRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["warder", "tasks"], queryFn: () => list({}), refetchInterval: 10_000 });
  const stop = useMutation({
    mutationFn: (taskId: string) => cancel({ taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["warder", "tasks"] }),
  });

  const s = useMemo(() => {
    const color = theme.colors;
    const pad = layout.compact ? 12 : 20;
    return {
      screen: { flex: 1, backgroundColor: color.surface0 },
      body: { padding: pad, gap: 12 },
      h: { color: color.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      muted: { color: color.foregroundMuted, fontSize: 13 },
      text: { color: color.foreground, fontSize: 14 },
      card: { padding: 12, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface1 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      badge: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingVertical: 2, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, alignSelf: "flex-start" as const },
      dot: { width: 7, height: 7, borderRadius: 4 },
      badgeText: { fontSize: 12, fontWeight: "600" as const },
      button: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: color.border },
    };
  }, [theme, layout.compact]);

  const data = query.data;
  const tasks = [...(data?.tasks ?? [])].sort((a, b) => Number(ACTIVE.includes(b.status)) - Number(ACTIVE.includes(a.status)) || b.lastActivityAt - a.lastActivityAt);
  const finished = tasks.filter((t) => !ACTIVE.includes(t.status));
  const settings = data?.settings;

  const renderTask = (t: TaskView) => (
    <View key={t.id} style={s.card}>
      <View style={s.row}>
        <Text style={[s.text, { flex: 1 }]}>{t.task}</Text>
        <StatusBadge status={t.status} styles={s} colors={theme.colors} />
      </View>
      <Text style={s.muted}>
        {[t.projectName, t.workspaceName].filter(Boolean).join(" › ") || "Unknown workspace"}
        {" · "}
        {t.agentTitle ?? "Untitled conversation"}
      </Text>
      <Text style={s.muted} selectable>
        Agent {t.agentId}
      </Text>
      <Text style={s.muted}>
        {turnLabel(t, data!.now)} · pings {settings ? Math.max(1, Math.round(settings.idleGraceSeconds / 60)) : 1} min after it stops · hang check {t.intervalMinutes} min · last activity {ago(data!.now, t.lastActivityAt)}
      </Text>
      <Text style={s.muted}>
        {t.pings} pings sent ({t.unanswered} unanswered) · registered by {t.registeredBy === t.agentId ? "the agent" : t.registeredBy} ({t.source})
        {t.until ? ` · until ${new Date(t.until).toLocaleString()}` : ""}
      </Text>
      {t.notes.length > 0 ? <Text style={s.muted}>Last note: {t.notes[t.notes.length - 1].text}</Text> : null}
      {t.result ? <Text style={s.muted}>Result: {t.result}</Text> : null}
      {ACTIVE.includes(t.status) ? (
        <View style={s.row}>
          <View />
          <Pressable accessibilityRole="button" accessibilityLabel={`Stop watching ${t.task}`} onPress={() => stop.mutate(t.id)} style={s.button}>
            <Text style={s.text}>Stop</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.h}>Watched tasks</Text>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {data?.endpoint.error ? <Text style={s.text}>{data.endpoint.error}</Text> : null}
      {data && tasks.length === 0 ? (
        <Text style={s.muted}>No tasks yet. Agents register them with warder_register; a parent can use warder_register_subagent.</Text>
      ) : null}
      {tasks.filter((t) => ACTIVE.includes(t.status)).map(renderTask)}
      {finished.length > 0 ? (
        <Collapsible title="Finished tasks" summary={`${finished.length}`} styles={s}>
          {finished.map(renderTask)}
        </Collapsible>
      ) : null}
      <Collapsible title="Settings" summary={settings ? (settings.scope === "all" ? "all agents" : "opt-in") : undefined} styles={s}>
      {data?.settingsError ? <Text style={s.text}>Invalid settings: {data.settingsError}</Text> : null}
      {settings ? (
        <View style={s.card}>
          <Text style={s.muted}>Tools for: {settings.scope === "all" ? "all agents (PASEO_WARDER=off opts out)" : "agents created with PASEO_WARDER=on"}</Text>
          <Text style={s.muted}>At most one prompt every {settings.globalGapSeconds} s across agents</Text>
          <Text style={s.muted}>Hang backstop capped at {settings.maxIntervalMinutes} min; backoff x{settings.backoffFactor} up to {settings.maxBackoffIntervals} intervals; parent notified after {settings.notifyParentAfterPings} unanswered pings; give up after {settings.maxUnansweredPings}</Text>
          <Text style={s.muted}>Announced-work detection: {settings.announcedWork.enabled ? `on (every ${settings.announcedWork.intervalMinutes} min)` : "off"}</Text>
          <Text style={s.muted}>Edit these under Settings → Plugins → Agents Warder.</Text>
        </View>
      ) : null}
      </Collapsible>
    </ScrollView>
  );
}
