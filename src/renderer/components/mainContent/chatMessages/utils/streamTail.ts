/** 运行中工具输出在内存中保留的尾部上限：长时间运行的命令不会让输出无限增长。 */
const STREAM_TAIL_MAX_CHARS = 256 * 1024;

/**
 * 追加流式输出并只保留尾部（从下一行行首截起，避免半行）。最终结果由后端
 * 返回，这里只约束运行期间的实时展示与中断时附带的部分输出。
 */
export const appendStreamTail = (
  previous: string | undefined,
  data: string,
): string => {
  const next = `${previous ?? ""}${data}`;
  if (next.length <= STREAM_TAIL_MAX_CHARS) {
    return next;
  }
  const tail = next.slice(next.length - STREAM_TAIL_MAX_CHARS);
  const lineBreak = tail.indexOf("\n");
  return lineBreak >= 0 && lineBreak < tail.length - 1
    ? tail.slice(lineBreak + 1)
    : tail;
};
