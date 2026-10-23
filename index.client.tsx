import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { hostBadgeComponent } from "./client/host-badge";
import { WarderScreen } from "./client/screen";

const HostBadge = hostBadgeComponent();

function WarderItem({ currentScreen, openScreen, host }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="ShieldCheck"
      active={currentScreen?.screenId === "warder"}
      onPress={() => openScreen({ screenId: "warder" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "warder", title: "Agents Warder", Component: WarderScreen });
  client.addSidebarHeaderItem({ id: "warder", title: "Agents Warder", Component: WarderItem });
  return () => {};
}
