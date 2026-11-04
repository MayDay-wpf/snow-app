import { createContext, useContext } from "react";

/** 把 HTML 文件路径在内置浏览器打开；返回是否已受理。 */
export type HtmlArtifactOpenHandler = (rawPath: string) => boolean;

type HtmlArtifactOpenValue = {
  open: HtmlArtifactOpenHandler;
};

const HtmlArtifactOpenContext = createContext<
  HtmlArtifactOpenValue | undefined
>(undefined);

export const HtmlArtifactOpenProvider = HtmlArtifactOpenContext.Provider;

/** 无 Provider 时返回 undefined，调用方需自行兜底。 */
export const useHtmlArtifactOpen = (): HtmlArtifactOpenHandler | undefined =>
  useContext(HtmlArtifactOpenContext)?.open;
