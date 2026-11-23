import * as React from "react";
import { Play } from "lucide-react";
import { openBrowserFile } from "../utils/browserFileOpen";
import {
  pluginMediaKind,
  pluginMediaUrl,
  type PluginMediaKind,
} from "../utils/pluginMediaUrl";

/**
 * 工具卡里的本地媒体预览。
 *
 * 插件只传本地绝对路径；URL 由宿主通过 plugin-media:// 生成，插件不接触协议拼接。
 * 预览是“只增不改”的 ui.media 能力，旧插件的渲染路径完全不受影响。
 */

export type PluginMediaPreviewProps = Readonly<{
  /** 本地媒体绝对路径（mp4/webm/mp3/wav/png…）。非媒体路径渲染为空。 */
  src: string;
  /** 省略时按扩展名推断。 */
  kind?: PluginMediaKind | "auto";
  /** 可访问名称（插件用自己的字典本地化）。 */
  title?: string;
  /** 视频封面图本地路径；省略时取首帧。 */
  poster?: string;
  /** inline 直接给播放器 / 图片；thumbnail 给“点一下就播”的封面。 */
  mode?: "inline" | "thumbnail";
  className?: string;
}>;

const joinClass = (...parts: Array<string | false | undefined>): string =>
  parts
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");

/** 复用宿主既有文件入口：产物在内置浏览器标签页里播放 / 查看。 */
export const openPluginMedia = (path: string): boolean => openBrowserFile(path);

export const PluginMediaPreview = (
  props: PluginMediaPreviewProps,
): React.ReactElement | null => {
  const {
    src,
    kind = "auto",
    title,
    poster,
    mode = "inline",
    className,
  } = props;
  const [playing, setPlaying] = React.useState(mode === "inline");
  const [failed, setFailed] = React.useState(false);
  const url = pluginMediaUrl(src);
  const resolvedKind = kind === "auto" ? pluginMediaKind(src) : kind;
  const posterUrl = poster ? pluginMediaUrl(poster) : undefined;

  if (!url || !resolvedKind || failed) return null;

  const fail = (): void => setFailed(true);

  if (resolvedKind === "image") {
    return (
      <button
        type="button"
        // The chat container delegates plain clicks on [title] to the file opener;
        // this button already opens the image, so keep the event local.
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openPluginMedia(src);
        }}
        className={joinClass(
          "plugin-media-image-button",
          mode === "thumbnail"
            ? "plugin-media-image-thumb"
            : "plugin-media-image-inline",
          className,
        )}
        title={title ?? src}
      >
        <img
          className="plugin-media-image"
          src={url}
          alt={title ?? ""}
          loading="lazy"
          decoding="async"
          onError={fail}
        />
      </button>
    );
  }

  if (resolvedKind === "audio") {
    // A native control bar is already the smallest sensible preview; thumbnails add nothing.
    return (
      <audio
        className={joinClass("plugin-media-audio", className)}
        src={url}
        controls
        preload="metadata"
        aria-label={title}
        onError={fail}
      />
    );
  }

  if (!playing) {
    return (
      <button
        type="button"
        className={joinClass("plugin-media-thumb", className)}
        title={title ?? src}
        aria-label={title ?? src}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPlaying(true);
        }}
      >
        {posterUrl ? (
          <img
            className="plugin-media-thumb-cover"
            src={posterUrl}
            alt=""
            loading="lazy"
          />
        ) : (
          <video
            className="plugin-media-thumb-cover"
            // #t=0.1 lets Chromium paint a real frame without downloading the whole file.
            src={`${url}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            aria-hidden="true"
          />
        )}
        <span className="plugin-media-thumb-play" aria-hidden="true">
          <Play size={16} />
        </span>
      </button>
    );
  }

  return (
    <video
      className={joinClass("plugin-media-video", className)}
      src={url}
      poster={posterUrl}
      controls
      preload="metadata"
      playsInline
      aria-label={title}
      onError={fail}
    />
  );
};
