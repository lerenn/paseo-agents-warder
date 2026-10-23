import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WarderScreen } from "./client/screen";

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
  client.addScreen({ id: "warder", title: "Agents warder", Component: WarderScreen });
  client.addSidebarHeaderItem({ id: "warder", title: "Agents warder", Component: WarderItem });
  return () => {};
}
