/**
 * 用户消息导航面板的本地搜索：纯函数，不依赖 DOM / React。
 *
 * 匹配规则（逐词 AND）：
 * - 精确：词作为连续子串出现；
 * - 模糊：词的字符按顺序出现（子序列），且命中跨度足够紧凑——
 *   「控制器重启」能匹配「控制器报错重启」，但不会被长文里零散的同字凑出来。
 * 单字词只做子串匹配，否则几乎每条消息都会命中。
 */

/** 命中区间，[start, end) 以 UTF-16 下标计。 */
export type MatchRange = [number, number];

export type QueryMatch = {
  /** 以模糊（非连续）方式命中的词数：0 表示全部精确命中，用于排序分层。 */
  fuzzyTerms: number;
  /** 合并后的命中区间（升序、互不重叠）。 */
  ranges: MatchRange[];
};

/**
 * 搜索归一化：逐字符 NFKC + 小写（全角字母数字转半角、大小写不敏感）。
 * 变换会改变长度的字符保持原样，保证结果与原文下标一一对应，
 * 命中区间可以直接用来高亮原文。
 */
export const normalizeForSearch = (text: string): string => {
  let out = "";
  for (const ch of text) {
    const mapped = ch.normalize("NFKC").toLowerCase();
    if (mapped.length === ch.length) {
      out += mapped;
      continue;
    }
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
};

/** 搜索词：按空白切分并归一化。 */
export const parseSearchTerms = (query: string): string[] =>
  normalizeForSearch(query.trim()).split(/\s+/).filter(Boolean);

/** 模糊命中允许的最大跨度：词长的两倍，且至少容纳 4 个间隔字符。 */
const maxFuzzySpan = (termLength: number): number =>
  termLength + Math.max(4, termLength);

/**
 * 在 haystack 中找 term 作为子序列的最短窗口（正向贪心定终点，反向贪心收紧
 * 起点，再从起点后一位继续）。返回命中的各字符下标；超出跨度上限视为不命中。
 */
const findFuzzyPositions = (
  haystack: string,
  term: string,
): number[] | null => {
  const limit = maxFuzzySpan(term.length);
  let best: number[] | null = null;
  let from = haystack.indexOf(term[0]);
  while (from >= 0) {
    // 正向：从 from 起依序吃掉 term 的每个字符。
    let ti = 0;
    let end = -1;
    for (let i = from; i < haystack.length; i++) {
      if (haystack[i] === term[ti]) {
        ti++;
        if (ti === term.length) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) {
      break;
    }
    // 反向：从终点往回收紧起点，得到以 end 结尾的最短窗口。
    const positions: number[] = new Array(term.length);
    ti = term.length - 1;
    for (let i = end; i >= from && ti >= 0; i--) {
      if (haystack[i] === term[ti]) {
        positions[ti] = i;
        ti--;
      }
    }
    const span = end - positions[0] + 1;
    if (
      span <= limit &&
      (!best || span < best[best.length - 1] - best[0] + 1)
    ) {
      best = positions;
      if (span === term.length) {
        break;
      }
    }
    from = haystack.indexOf(term[0], positions[0] + 1);
  }
  return best;
};

/** 下标列表 → 合并后的连续区间。 */
const positionsToRanges = (positions: number[]): MatchRange[] => {
  const ranges: MatchRange[] = [];
  for (const pos of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === pos) {
      last[1] = pos + 1;
    } else {
      ranges.push([pos, pos + 1]);
    }
  }
  return ranges;
};

/** 区间排序并合并重叠 / 相邻部分。 */
const mergeRanges = (ranges: MatchRange[]): MatchRange[] => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: MatchRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

/**
 * 用已归一化的搜索词匹配已归一化的文本。任一词不命中返回 null。
 */
export const matchSearchTerms = (
  haystack: string,
  terms: string[],
): QueryMatch | null => {
  let fuzzyTerms = 0;
  const ranges: MatchRange[] = [];
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at >= 0) {
      ranges.push([at, at + term.length]);
      continue;
    }
    if (term.length < 2) {
      return null;
    }
    const positions = findFuzzyPositions(haystack, term);
    if (!positions) {
      return null;
    }
    fuzzyTerms++;
    ranges.push(...positionsToRanges(positions));
  }
  return { fuzzyTerms, ranges: mergeRanges(ranges) };
};

export type HighlightSnippet = {
  text: string;
  ranges: MatchRange[];
};

/** 片段起点距首个命中的保留前文长度。 */
const SNIPPET_LEAD = 12;
/** 片段最大长度：两行展示足够，超长原文不整段塞进 DOM。 */
const SNIPPET_MAX_LENGTH = 160;

/**
 * 截取展示片段：首个命中太靠后时从命中前一小段开始（前缀省略号），
 * 保证命中处出现在两行截断范围内；区间同步平移并裁到片段内。
 */
export const buildHighlightSnippet = (
  text: string,
  ranges: MatchRange[],
): HighlightSnippet => {
  const visible = ranges.filter(([start]) => start < text.length);
  let start = 0;
  if (visible.length > 0 && visible[0][0] > SNIPPET_LEAD + 4) {
    start = visible[0][0] - SNIPPET_LEAD;
    // 不从代理对中间切开。
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) {
      start--;
    }
  }
  const end = Math.min(text.length, start + SNIPPET_MAX_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const offset = prefix.length - start;
  const shifted: MatchRange[] = [];
  for (const [rangeStart, rangeEnd] of visible) {
    if (rangeEnd <= start || rangeStart >= end) continue;
    shifted.push([
      Math.max(rangeStart, start) + offset,
      Math.min(rangeEnd, end) + offset,
    ]);
  }
  return { text: prefix + text.slice(start, end), ranges: shifted };
};
