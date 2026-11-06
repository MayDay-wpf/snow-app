/**
 * 移动端输入框回填桥：消息操作（编辑到输入框）与输入区模块解耦，
 * 避免 timeline ↔ composer ↔ threads 的循环依赖。
 */
type InputTextSink = (text: string) => void;

let sink: InputTextSink | null = null;
let changeListener: (() => void) | null = null;

export const registerInputTextSink = (handler: InputTextSink): void => {
  sink = handler;
};

/**
 * 程序化改写输入框内容（插入引用 chip、剥离 @ / # 触发词）后通知输入区：
 * 由 composer 重置待发送幂等标识并同步输入框高度。
 */
export const registerInputChangeListener = (handler: () => void): void => {
  changeListener = handler;
};

export const notifyInputChanged = (): void => {
  changeListener?.();
};

/** 把文本写入移动端输入框；输入区未就绪（只读会话等）时返回 false。 */
export const writeBackToMobileInput = (text: string): boolean => {
  if (!sink) return false;
  sink(text);
  return true;
};
