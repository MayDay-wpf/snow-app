/**
 * 移动端输入框回填桥：消息操作（编辑到输入框）与输入区模块解耦，
 * 避免 timeline ↔ composer ↔ threads 的循环依赖。
 */
type InputTextSink = (text: string) => void;

let sink: InputTextSink | null = null;

export const registerInputTextSink = (handler: InputTextSink): void => {
  sink = handler;
};

/** 把文本写入移动端输入框；输入区未就绪（只读会话等）时返回 false。 */
export const writeBackToMobileInput = (text: string): boolean => {
  if (!sink) return false;
  sink(text);
  return true;
};
