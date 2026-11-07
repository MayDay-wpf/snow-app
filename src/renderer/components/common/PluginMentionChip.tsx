import { useEffect } from "react";

import { useI18n } from "../../i18n";
import { pluginMentionTitle } from "../../plugins/pluginMentions";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { PluginIcon } from "./PluginIcon";

type PluginMentionChipProps = {
  pluginId: string;
  name: string;
};

/**
 * 工具插件 chip：图标 + 插件名，样式与技能 chip 共用
 * `user-message-file-chip`。消息气泡、待发送列表与紧凑预览共用这一份实现。
 *
 * 插件列表异步加载，chip 可能先于 store 就绪渲染；订阅 store 让图标在
 * 加载完成后补上，而不是停在占位图标。
 */
export const PluginMentionChip = ({
  pluginId,
  name,
}: PluginMentionChipProps): React.JSX.Element => {
  const { locale } = useI18n();
  const { plugins } = usePluginStore();
  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);
  const plugin = plugins.find((item) => item.pluginId === pluginId) ?? null;
  const title = pluginMentionTitle(name, plugin, locale);

  return (
    <span className="user-message-file-chip plugin-chip" title={title}>
      <PluginIcon
        icon={plugin?.icon ?? ""}
        pluginId={pluginId}
        size={12}
        className="user-message-file-chip-icon"
      />
      <span className="user-message-file-chip-name">{name}</span>
    </span>
  );
};
