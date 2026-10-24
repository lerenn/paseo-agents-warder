import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { NoteRow } from "./client/note";
import { WarderScreen } from "./client/screen";
import { commandRpc } from "./shared/rpc";

function WarderItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ShieldCheck"
      active={currentScreen?.screenId === "warder"}
      onPress={() => openScreen({ screenId: "warder" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "warder", title: "Agents Warder", Component: WarderScreen });
  client.addSidebarHeaderItem({ id: "warder", title: "Agents Warder", Component: WarderItem });
  client.addSlashCommand({
    name: "warder",
    description: "Watch this agent: /warder <task>, stop, supervise, or no args for status",
    argumentHint: "<task> [--interval <minutes>] | stop | supervise [stop]",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      await rpc(commandRpc, { agentId: agent.id, args });
    },
  });
  client.addTimelineRenderer({ kind: "warder-note", version: 1, schema: z.object({ text: z.string() }), Component: NoteRow });
  return () => {};
}
