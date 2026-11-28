import { BrainIcon, GithubLogoIcon, MagnifyingGlassIcon, SquaresFourIcon, TerminalWindowIcon, WrenchIcon, type Icon } from "@phosphor-icons/react";
import { TOOL_IDS, type ToolId } from "@/lib/tools/metadata";

const icons: Record<ToolId, Icon> = {
  web_search: MagnifyingGlassIcon,
  run_code: TerminalWindowIcon,
  github: GithubLogoIcon,
  memory: BrainIcon,
  render_ui: SquaresFourIcon,
};

/** The icon a tool shows on /tools and in the composer's tools panel. Other ids, such as Slice 23 servers, get the wrench. */
export function toolIcon(id: string): Icon {
  return (TOOL_IDS as readonly string[]).includes(id) ? icons[id as ToolId] : WrenchIcon;
}
