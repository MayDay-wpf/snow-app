import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, Trash2, X } from "lucide-react";

import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { useI18n } from "../../../i18n";

export type EmojiPickerProps = {
  /** 触发元素的 ref，用于定位面板 */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** 当前已选 emoji（空字符串表示未选） */
  currentEmoji: string;
  /** 选择 emoji 时触发，空字符串表示清除 */
  onSelect: (emoji: string) => void;
  /** 关闭面板 */
  onClose: () => void;
  /** 鼠标进入面板（用于悬停控制时取消延迟关闭） */
  onPanelMouseEnter?: () => void;
  /** 鼠标离开面板（用于悬停控制时调度延迟关闭） */
  onPanelMouseLeave?: () => void;
  /** 焦点移入该区域时保持面板打开（用于嵌入菜单等场景，避免点击菜单项时面板先关闭吞掉点击） */
  focusOutKeepRef?: React.RefObject<HTMLElement | null>;
};

type PanelPosition = {
  top: number;
  left: number;
} | null;

type EmojiEntry = { char: string; keywords: string[] };

const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * 精选常用 emoji，按类别分组。每组附带关键词（英文小写）用于搜索匹配。
 * 避免引入完整 emoji 数据集，保持包体积精简。如需扩展可在此处追加。
 */
const EMOJI_GROUPS: Array<{ key: string; emojis: EmojiEntry[] }> = [
  {
    key: "status",
    emojis: [
      {
        char: "✅",
        keywords: ["check", "done", "yes", "success", "pass", "ok"],
      },
      { char: "✔️", keywords: ["check", "mark", "ok", "done"] },
      { char: "☑️", keywords: ["ballot", "check", "box", "vote"] },
      {
        char: "❌",
        keywords: ["cross", "no", "wrong", "error", "fail", "reject"],
      },
      { char: "❎", keywords: ["cross", "button", "no", "deny"] },
      { char: "⚠️", keywords: ["warning", "alert", "caution", "danger"] },
      {
        char: "🚫",
        keywords: ["ban", "prohibit", "deny", "reject", "block", "forbidden"],
      },
      { char: "⛔", keywords: ["no", "entry", "forbidden", "stop"] },
      { char: "🛑", keywords: ["stop", "halt", "sign"] },
      { char: "ℹ️", keywords: ["info", "information", "about"] },
      { char: "❓", keywords: ["question", "help", "unknown"] },
      { char: "❗", keywords: ["exclamation", "alert", "important"] },
      { char: "❕", keywords: ["exclamation", "white"] },
      { char: "❔", keywords: ["question", "white"] },
      { char: "‼️", keywords: ["exclamation", "double", "urgent"] },
      { char: "⁉️", keywords: ["exclamation", "question", "surprise"] },
      { char: "💯", keywords: ["100", "hundred", "perfect", "score"] },
      { char: "🆗", keywords: ["ok", "okay", "button"] },
      { char: "🆖", keywords: ["ng", "no", "good", "bad", "button"] },
      { char: "🆙", keywords: ["up", "button", "new"] },
      { char: "🆕", keywords: ["new", "button"] },
      { char: "🆓", keywords: ["free", "button"] },
      { char: "🆒", keywords: ["cool", "button"] },
      { char: "📛", keywords: ["badge", "name", "tag"] },
      { char: "🔞", keywords: ["18", "restricted", "adult"] },
      { char: "♻️", keywords: ["recycle", "reuse", "green"] },
      { char: "🔴", keywords: ["circle", "red", "offline", "busy", "error"] },
      { char: "🟠", keywords: ["circle", "orange", "away"] },
      { char: "🟡", keywords: ["circle", "yellow", "pending", "idle"] },
      {
        char: "🟢",
        keywords: ["circle", "green", "online", "active", "success"],
      },
      { char: "🔵", keywords: ["circle", "blue", "info"] },
      { char: "🟣", keywords: ["circle", "purple"] },
      { char: "🟤", keywords: ["circle", "brown"] },
      { char: "⚫", keywords: ["circle", "black", "off"] },
      { char: "⚪", keywords: ["circle", "white", "neutral"] },
    ],
  },
  {
    key: "smileys",
    emojis: [
      { char: "😀", keywords: ["smile", "happy", "grin"] },
      { char: "😃", keywords: ["happy", "joy"] },
      { char: "😄", keywords: ["happy", "joy", "laugh"] },
      { char: "😁", keywords: ["grin", "happy"] },
      { char: "😆", keywords: ["laugh", "happy"] },
      { char: "😅", keywords: ["sweat", "laugh"] },
      { char: "🤣", keywords: ["rofl", "laugh"] },
      { char: "😂", keywords: ["joy", "tear", "laugh"] },
      { char: "🙂", keywords: ["smile", "slight"] },
      { char: "🙃", keywords: ["upside", "smile"] },
      { char: "😉", keywords: ["wink"] },
      { char: "😊", keywords: ["blush", "smile"] },
      { char: "😇", keywords: ["angel", "halo"] },
      { char: "🥰", keywords: ["love", "heart"] },
      { char: "😍", keywords: ["love", "heart", "eyes"] },
      { char: "🤩", keywords: ["star", "eyes"] },
      { char: "😘", keywords: ["kiss", "love"] },
      { char: "😋", keywords: ["yum", "tongue"] },
      { char: "😛", keywords: ["tongue"] },
      { char: "😜", keywords: ["wink", "tongue"] },
      { char: "🤪", keywords: ["crazy", "zany"] },
      { char: "🤔", keywords: ["think", "hmm"] },
      { char: "🤨", keywords: ["suspicious"] },
      { char: "😐", keywords: ["neutral"] },
      { char: "😑", keywords: ["expressionless"] },
      { char: "😶", keywords: ["silent"] },
      { char: "😏", keywords: ["smirk"] },
      { char: "😒", keywords: ["unamused"] },
      { char: "🙄", keywords: ["roll", "eyes"] },
      { char: "😬", keywords: ["grimace"] },
      { char: "😌", keywords: ["relieved"] },
      { char: "😔", keywords: ["sad", "pensive"] },
      { char: "😪", keywords: ["sleepy"] },
      { char: "😴", keywords: ["sleep", "zzz"] },
      { char: "😷", keywords: ["mask", "sick"] },
      { char: "🤒", keywords: ["sick", "thermometer"] },
      { char: "🤕", keywords: ["hurt", "bandage"] },
      { char: "🤢", keywords: ["nauseous", "sick"] },
      { char: "🤮", keywords: ["vomit", "sick"] },
      { char: "🥵", keywords: ["hot"] },
      { char: "🥶", keywords: ["cold", "freeze"] },
      { char: "🥳", keywords: ["party", "celebrate"] },
      { char: "😎", keywords: ["cool", "sunglasses"] },
      { char: "🤓", keywords: ["nerd", "glasses"] },
      { char: "🧐", keywords: ["monocle"] },
      { char: "😕", keywords: ["confused"] },
      { char: "😟", keywords: ["worried"] },
      { char: "🙁", keywords: ["frown"] },
      { char: "☹️", keywords: ["sad"] },
      { char: "😮", keywords: ["surprise", "wow"] },
    ],
  },
  {
    key: "gestures",
    emojis: [
      { char: "👍", keywords: ["thumbs", "up", "like", "yes"] },
      { char: "👎", keywords: ["thumbs", "down", "dislike", "no"] },
      { char: "👌", keywords: ["ok", "perfect"] },
      { char: "🤌", keywords: ["pinch"] },
      { char: "🤏", keywords: ["pinch", "small"] },
      { char: "✌️", keywords: ["peace", "victory"] },
      { char: "🤞", keywords: ["fingers", "crossed", "luck"] },
      { char: "🤟", keywords: ["love", "rock"] },
      { char: "🤘", keywords: ["rock"] },
      { char: "🤙", keywords: ["call", "shaka"] },
      { char: "👈", keywords: ["point", "left"] },
      { char: "👉", keywords: ["point", "right"] },
      { char: "👆", keywords: ["point", "up"] },
      { char: "👇", keywords: ["point", "down"] },
      { char: "☝️", keywords: ["point", "up", "one"] },
      { char: "👋", keywords: ["wave", "hi", "hello", "bye"] },
      { char: "🤚", keywords: ["stop", "raised"] },
      { char: "🖐️", keywords: ["hand", "five"] },
      { char: "✋", keywords: ["stop", "hand"] },
      { char: "🖖", keywords: ["vulcan", "spock"] },
      { char: "👏", keywords: ["clap", "applause"] },
      { char: "🙌", keywords: ["raise", "hands", "celebrate"] },
      { char: "👐", keywords: ["open", "hands"] },
      { char: "🤲", keywords: ["palms", "together"] },
      { char: "🙏", keywords: ["pray", "thanks", "please"] },
      { char: "✍️", keywords: ["write", "pen"] },
      { char: "💪", keywords: ["muscle", "strong", "flex"] },
      { char: "🦾", keywords: ["arm", "mechanical"] },
      { char: "🦿", keywords: ["leg", "mechanical"] },
      { char: "🤝", keywords: ["handshake", "deal"] },
    ],
  },
  {
    key: "animals",
    emojis: [
      { char: "🐶", keywords: ["dog", "puppy"] },
      { char: "🐱", keywords: ["cat", "kitten"] },
      { char: "🐭", keywords: ["mouse"] },
      { char: "🐹", keywords: ["hamster"] },
      { char: "🐰", keywords: ["rabbit", "bunny"] },
      { char: "🦊", keywords: ["fox"] },
      { char: "🐻", keywords: ["bear"] },
      { char: "🐼", keywords: ["panda"] },
      { char: "🐨", keywords: ["koala"] },
      { char: "🐯", keywords: ["tiger"] },
      { char: "🦁", keywords: ["lion"] },
      { char: "🐮", keywords: ["cow"] },
      { char: "🐷", keywords: ["pig"] },
      { char: "🐸", keywords: ["frog"] },
      { char: "🐵", keywords: ["monkey"] },
      { char: "🐔", keywords: ["chicken"] },
      { char: "🐧", keywords: ["penguin"] },
      { char: "🐦", keywords: ["bird"] },
      { char: "🦆", keywords: ["duck"] },
      { char: "🦅", keywords: ["eagle"] },
      { char: "🦉", keywords: ["owl"] },
      { char: "🐺", keywords: ["wolf"] },
      { char: "🐗", keywords: ["boar"] },
      { char: "🐴", keywords: ["horse"] },
      { char: "🦄", keywords: ["unicorn"] },
      { char: "🐝", keywords: ["bee"] },
      { char: "🐛", keywords: ["bug"] },
      { char: "🦋", keywords: ["butterfly"] },
      { char: "🐌", keywords: ["snail"] },
      { char: "🐞", keywords: ["ladybug"] },
      { char: "🐙", keywords: ["octopus"] },
      { char: "🦑", keywords: ["squid"] },
      { char: "🦐", keywords: ["shrimp"] },
      { char: "🦀", keywords: ["crab"] },
      { char: "🐡", keywords: ["fish"] },
      { char: "🐠", keywords: ["fish", "tropical"] },
      { char: "🐟", keywords: ["fish"] },
      { char: "🐬", keywords: ["dolphin"] },
      { char: "🐳", keywords: ["whale"] },
      { char: "🦕", keywords: ["dinosaur"] },
      { char: "🦖", keywords: ["dinosaur", "t-rex"] },
    ],
  },
  {
    key: "activities",
    emojis: [
      { char: "⚽", keywords: ["soccer", "football"] },
      { char: "🏀", keywords: ["basketball"] },
      { char: "🏈", keywords: ["football"] },
      { char: "⚾", keywords: ["baseball"] },
      { char: "🥎", keywords: ["softball"] },
      { char: "🎾", keywords: ["tennis"] },
      { char: "🏐", keywords: ["volleyball"] },
      { char: "🏉", keywords: ["rugby"] },
      { char: "🥏", keywords: ["frisbee"] },
      { char: "🎱", keywords: ["pool", "billiards"] },
      { char: "🏓", keywords: ["ping", "pong"] },
      { char: "🏸", keywords: ["badminton"] },
      { char: "🏒", keywords: ["hockey"] },
      { char: "🏑", keywords: ["hockey", "field"] },
      { char: "🏏", keywords: ["cricket"] },
      { char: "🎮", keywords: ["game", "controller"] },
      { char: "🕹️", keywords: ["joystick"] },
      { char: "🎲", keywords: ["dice"] },
      { char: "🎯", keywords: ["dart", "target"] },
      { char: "🎳", keywords: ["bowling"] },
      { char: "🎨", keywords: ["art", "paint"] },
      { char: "🎭", keywords: ["theater", "drama"] },
      { char: "🎤", keywords: ["mic", "sing"] },
      { char: "🎧", keywords: ["headphone", "music"] },
      { char: "🎼", keywords: ["music", "score"] },
      { char: "🎹", keywords: ["piano"] },
      { char: "🥁", keywords: ["drum"] },
      { char: "🎷", keywords: ["saxophone"] },
      { char: "🎺", keywords: ["trumpet"] },
      { char: "🎸", keywords: ["guitar"] },
      { char: "🎻", keywords: ["violin"] },
      { char: "🏆", keywords: ["trophy", "win"] },
      { char: "🥇", keywords: ["gold", "medal"] },
      { char: "🥈", keywords: ["silver", "medal"] },
      { char: "🥉", keywords: ["bronze", "medal"] },
      { char: "🎽", keywords: ["running"] },
      { char: "🥊", keywords: ["boxing"] },
      { char: "🥋", keywords: ["martial", "arts"] },
      { char: "⛸️", keywords: ["ice", "skate"] },
      { char: "🛷", keywords: ["sled"] },
    ],
  },
  {
    key: "travel",
    emojis: [
      { char: "🚗", keywords: ["car"] },
      { char: "🚕", keywords: ["taxi"] },
      { char: "🚙", keywords: ["suv"] },
      { char: "🚌", keywords: ["bus"] },
      { char: "🚎", keywords: ["trolleybus"] },
      { char: "🏎️", keywords: ["race", "car"] },
      { char: "🚓", keywords: ["police", "car"] },
      { char: "🚑", keywords: ["ambulance"] },
      { char: "🚒", keywords: ["fire", "truck"] },
      { char: "🚐", keywords: ["minibus"] },
      { char: "🚚", keywords: ["truck"] },
      { char: "🚛", keywords: ["truck", "semi"] },
      { char: "🏍️", keywords: ["motorcycle"] },
      { char: "🛵", keywords: ["scooter"] },
      { char: "🚲", keywords: ["bicycle", "bike"] },
      { char: "🛴", keywords: ["scooter"] },
      { char: "✈️", keywords: ["plane", "fly"] },
      { char: "🚀", keywords: ["rocket", "space"] },
      { char: "🛸", keywords: ["ufo"] },
      { char: "🚁", keywords: ["helicopter"] },
      { char: "⛵", keywords: ["sailboat", "boat"] },
      { char: "🚤", keywords: ["speedboat"] },
      { char: "🛳️", keywords: ["ship"] },
      { char: "⛴️", keywords: ["ferry"] },
      { char: "🚢", keywords: ["ship"] },
      { char: "🚂", keywords: ["train"] },
      { char: "🚆", keywords: ["train"] },
      { char: "🚊", keywords: ["tram"] },
      { char: "🚇", keywords: ["metro", "subway"] },
      { char: "🚉", keywords: ["station"] },
      { char: "🗺️", keywords: ["map"] },
      { char: "🗿", keywords: ["moai", "statue"] },
      { char: "🗽", keywords: ["statue", "liberty"] },
      { char: "🗼", keywords: ["tower"] },
      { char: "🏰", keywords: ["castle"] },
      { char: "🏯", keywords: ["castle"] },
      { char: "🎡", keywords: ["ferris", "wheel"] },
      { char: "🎢", keywords: ["rollercoaster"] },
      { char: "🎠", keywords: ["carousel"] },
      { char: "⛲", keywords: ["fountain"] },
    ],
  },
  {
    key: "objects",
    emojis: [
      { char: "💡", keywords: ["idea", "light", "bulb"] },
      { char: "🔦", keywords: ["flashlight"] },
      { char: "📔", keywords: ["notebook"] },
      { char: "📕", keywords: ["book"] },
      { char: "📖", keywords: ["book", "read"] },
      { char: "📗", keywords: ["book"] },
      { char: "📘", keywords: ["book"] },
      { char: "📙", keywords: ["book"] },
      { char: "📚", keywords: ["books", "library"] },
      { char: "📓", keywords: ["notebook"] },
      { char: "📒", keywords: ["notebook"] },
      { char: "📃", keywords: ["page"] },
      { char: "📜", keywords: ["scroll"] },
      { char: "📄", keywords: ["document"] },
      { char: "📰", keywords: ["newspaper", "news"] },
      { char: "📑", keywords: ["bookmark"] },
      { char: "🔖", keywords: ["bookmark"] },
      { char: "💰", keywords: ["money", "bag"] },
      { char: "💳", keywords: ["credit", "card"] },
      { char: "💵", keywords: ["dollar", "money"] },
      { char: "💴", keywords: ["yen", "money"] },
      { char: "💶", keywords: ["euro", "money"] },
      { char: "💷", keywords: ["pound", "money"] },
      { char: "🔧", keywords: ["wrench", "tool"] },
      { char: "🔨", keywords: ["hammer", "tool"] },
      { char: "⚒️", keywords: ["hammer", "pick"] },
      { char: "🛠️", keywords: ["tools"] },
      { char: "⚙️", keywords: ["gear", "settings"] },
      { char: "🧰", keywords: ["toolbox"] },
      { char: "🔑", keywords: ["key"] },
      { char: "🗝️", keywords: ["key"] },
      { char: "🔒", keywords: ["lock", "closed"] },
      { char: "🔓", keywords: ["lock", "open", "unlock"] },
      { char: "🔔", keywords: ["bell", "notification"] },
      { char: "🔕", keywords: ["bell", "mute"] },
      { char: "📱", keywords: ["phone", "mobile"] },
      { char: "💻", keywords: ["laptop", "computer"] },
      { char: "⌨️", keywords: ["keyboard"] },
      { char: "🖥️", keywords: ["desktop"] },
      { char: "🖱️", keywords: ["mouse"] },
      { char: "💾", keywords: ["save", "floppy"] },
      { char: "💿", keywords: ["cd", "disc"] },
      { char: "📷", keywords: ["camera", "photo"] },
      { char: "📸", keywords: ["camera", "flash"] },
      { char: "🎥", keywords: ["camera", "movie"] },
      { char: "📺", keywords: ["tv", "television"] },
      { char: "📻", keywords: ["radio"] },
      { char: "⏰", keywords: ["alarm", "clock"] },
      { char: "⏱️", keywords: ["timer"] },
      { char: "🔋", keywords: ["battery"] },
      { char: "🔌", keywords: ["plug", "power"] },
    ],
  },
  {
    key: "symbols",
    emojis: [
      { char: "⭐", keywords: ["star"] },
      { char: "🌟", keywords: ["star", "glow"] },
      { char: "✨", keywords: ["sparkle", "shine"] },
      { char: "⚡", keywords: ["lightning", "energy"] },
      { char: "🔥", keywords: ["fire", "hot"] },
      { char: "💥", keywords: ["explosion", "boom"] },
      { char: "💫", keywords: ["dizzy", "star"] },
      { char: "🌈", keywords: ["rainbow"] },
      { char: "☀️", keywords: ["sun", "sunny"] },
      { char: "🌤️", keywords: ["sun", "cloud"] },
      { char: "⛅", keywords: ["cloud", "sun"] },
      { char: "☁️", keywords: ["cloud"] },
      { char: "🌧️", keywords: ["rain"] },
      { char: "⛈️", keywords: ["storm", "rain"] },
      { char: "❄️", keywords: ["snow", "cold"] },
      { char: "☃️", keywords: ["snowman"] },
      { char: "💧", keywords: ["drop", "water"] },
      { char: "🌊", keywords: ["wave", "ocean"] },
      { char: "🎉", keywords: ["party", "celebrate", "tada"] },
      { char: "🎊", keywords: ["confetti", "party"] },
      { char: "🎈", keywords: ["balloon", "party"] },
      { char: "🎁", keywords: ["gift", "present"] },
      { char: "❤️", keywords: ["love", "heart", "red"] },
      { char: "🧡", keywords: ["heart", "orange"] },
      { char: "💛", keywords: ["heart", "yellow"] },
      { char: "💚", keywords: ["heart", "green"] },
      { char: "💙", keywords: ["heart", "blue"] },
      { char: "💜", keywords: ["heart", "purple"] },
      { char: "🖤", keywords: ["heart", "black"] },
      { char: "🤍", keywords: ["heart", "white"] },
      { char: "💔", keywords: ["heart", "broken"] },
      { char: "💢", keywords: ["angry"] },
      { char: "💣", keywords: ["bomb"] },
      { char: "💤", keywords: ["sleep", "zzz"] },
      { char: "💬", keywords: ["speech", "chat"] },
      { char: "💭", keywords: ["thought"] },
    ],
  },
  {
    key: "tech",
    emojis: [
      { char: "🔍", keywords: ["search", "magnify", "zoom"] },
      { char: "🔎", keywords: ["search", "magnify", "zoom"] },
      { char: "🧭", keywords: ["compass", "navigation", "direction"] },
      { char: "🔬", keywords: ["microscope", "science", "research"] },
      { char: "🔭", keywords: ["telescope", "space", "astronomy"] },
      { char: "📡", keywords: ["satellite", "antenna", "signal"] },
      { char: "🛰️", keywords: ["satellite", "space"] },
      { char: "🧲", keywords: ["magnet", "magnetic"] },
      { char: "🧪", keywords: ["test", "tube", "lab", "chemistry"] },
      { char: "🧫", keywords: ["petri", "bacteria", "biology"] },
      { char: "🧬", keywords: ["dna", "gene", "biology"] },
      { char: "⚗️", keywords: ["alembic", "chemistry", "lab"] },
      { char: "🪐", keywords: ["saturn", "planet", "space"] },
      { char: "⚛️", keywords: ["atom", "nuclear", "physics"] },
      { char: "☢️", keywords: ["radioactive"] },
      { char: "☣️", keywords: ["biohazard"] },
      { char: "🧮", keywords: ["abacus", "math", "calculator"] },
      { char: "📊", keywords: ["chart", "bar", "stats", "data"] },
      { char: "📈", keywords: ["chart", "growth", "trend", "up"] },
      { char: "📉", keywords: ["chart", "decline", "trend", "down"] },
      { char: "🧾", keywords: ["receipt", "bill", "invoice"] },
      { char: "🏷️", keywords: ["tag", "label", "price"] },
      { char: "💲", keywords: ["dollar", "currency", "money"] },
      { char: "🪙", keywords: ["coin", "money", "currency"] },
      { char: "💱", keywords: ["currency", "exchange", "money"] },
      { char: "🏦", keywords: ["bank", "building", "finance"] },
      { char: "🏧", keywords: ["atm", "cash", "money"] },
      { char: "📌", keywords: ["pushpin", "pin", "mark"] },
      { char: "📍", keywords: ["pushpin", "location", "map"] },
      { char: "📎", keywords: ["paperclip", "attach"] },
      { char: "✂️", keywords: ["scissors", "cut"] },
      { char: "🗑️", keywords: ["wastebasket", "trash", "bin"] },
      { char: "🖨️", keywords: ["printer", "print"] },
      { char: "📠", keywords: ["fax", "machine"] },
      { char: "☎️", keywords: ["telephone", "phone", "landline"] },
      { char: "📞", keywords: ["telephone", "phone", "receiver"] },
    ],
  },
];

const GROUP_LABEL_KEYS: Record<string, string> = {
  status: "sidebar.emojiGroupStatus",
  smileys: "sidebar.emojiGroupSmileys",
  gestures: "sidebar.emojiGroupGestures",
  animals: "sidebar.emojiGroupAnimals",
  activities: "sidebar.emojiGroupActivities",
  travel: "sidebar.emojiGroupTravel",
  objects: "sidebar.emojiGroupObjects",
  symbols: "sidebar.emojiGroupSymbols",
  tech: "sidebar.emojiGroupTech",
};

const GROUP_DEFAULT_LABELS: Record<string, string> = {
  status: "Status",
  smileys: "Smileys",
  gestures: "Gestures",
  animals: "Animals",
  activities: "Activities",
  travel: "Travel",
  objects: "Objects",
  symbols: "Symbols",
  tech: "Tech",
};

/** 将所有 emoji 展平为一维数组，用于搜索 */
const ALL_EMOJIS: EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.emojis);

/**
 * 全局单例锁：同一时刻只允许一个 picker 面板存在。
 * 悬停连续掠过多个图标时，新面板挂载会先关闭上一个，避免多面板并存。
 */
let activePickerClose: (() => void) | null = null;

export function EmojiPicker({
  triggerRef,
  currentEmoji,
  onSelect,
  onClose,
  onPanelMouseEnter,
  onPanelMouseLeave,
  focusOutKeepRef,
}: EmojiPickerProps): React.JSX.Element {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<PanelPosition>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const computePosition = useCallback((): PanelPosition => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger) {
      return null;
    }

    const triggerRect = trigger.getBoundingClientRect();
    // 使用 offsetWidth/offsetHeight 测量，不受入场动画 scale 变换影响
    const panelWidth = panel ? panel.offsetWidth : 280;
    const panelHeight = panel ? panel.offsetHeight : 360;

    // 水平：优先显示在图标右侧，空间不足时翻转到左侧
    const spaceRight = window.innerWidth - triggerRect.right - VIEWPORT_MARGIN;
    const opensRight = spaceRight >= panelWidth + PANEL_GAP;
    const preferredLeft = opensRight
      ? triggerRect.right + PANEL_GAP
      : triggerRect.left - panelWidth - PANEL_GAP;

    // 垂直：优先向下展开（顶边对齐图标顶边）；
    // 图标靠近列表底部、下方空间不足时翻转为向上展开（底边对齐图标底边）
    const spaceBelow = window.innerHeight - triggerRect.top - VIEWPORT_MARGIN;
    const opensDown = spaceBelow >= panelHeight;
    const preferredTop = opensDown
      ? triggerRect.top
      : triggerRect.bottom - panelHeight;

    // 兜底钳制：视口极小上下都放不下时，仍保证面板完整可见
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - panelHeight - VIEWPORT_MARGIN,
    );

    return {
      top: Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maxTop),
      left: Math.min(
        Math.max(preferredLeft, VIEWPORT_MARGIN),
        Math.max(
          VIEWPORT_MARGIN,
          window.innerWidth - panelWidth - VIEWPORT_MARGIN,
        ),
      ),
    };
  }, [triggerRef]);

  const updatePosition = useCallback((): void => {
    setPosition(computePosition());
  }, [computePosition]);

  useLayoutEffect(() => {
    updatePosition();
    const sidebar = triggerRef.current?.closest<HTMLElement>(".sidebar");
    const observer = new ResizeObserver(() => updatePosition());
    if (panelRef.current) {
      observer.observe(panelRef.current);
    }
    if (sidebar) {
      observer.observe(sidebar);
    }
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition, triggerRef]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const focusOutKeepRefRef = useRef(focusOutKeepRef);
  focusOutKeepRefRef.current = focusOutKeepRef;

  // 挂载时注册为全局唯一面板，并关闭此前仍存在的实例
  useEffect(() => {
    activePickerClose?.();
    const closeSelf = (): void => onCloseRef.current();
    activePickerClose = closeSelf;
    return () => {
      if (activePickerClose === closeSelf) {
        activePickerClose = null;
      }
    };
  }, []);

  // ESC 关闭面板（层级栈；组件仅在打开时挂载，挂载期间即激活）。
  useEscapeKey({ onEscape: onClose });

  // 焦点离开面板时关闭（覆盖"点击搜索框输入后鼠标已移开"的场景）
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const handleFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget as Node | null;
      if (next && panel.contains(next)) {
        return;
      }
      // 焦点移入菜单等宿主区域时保持打开，交由宿主处理点击
      if (next && focusOutKeepRefRef.current?.current?.contains(next)) {
        return;
      }
      onCloseRef.current();
    };
    panel.addEventListener("focusout", handleFocusOut);
    return () => {
      panel.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  // 搜索过滤：匹配关键词或 emoji 字符本身
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return EMOJI_GROUPS;
    }
    const matched = ALL_EMOJIS.filter(
      (entry) =>
        entry.keywords.some((kw) => kw.includes(query)) ||
        entry.char.includes(searchQuery.trim()),
    );
    if (matched.length === 0) {
      return [];
    }
    return [{ key: "search", emojis: matched }];
  }, [searchQuery]);

  const handleSelect = (emoji: string): void => {
    onSelect(emoji);
    onClose();
  };

  const handleClear = (): void => {
    onSelect("");
    onClose();
  };

  const handleClearSearch = (): void => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };

  const handlePanelMouseEnter = (): void => {
    onPanelMouseEnter?.();
  };

  const handlePanelMouseLeave = (): void => {
    // 焦点仍在面板内（如正在搜索框输入）时，鼠标移开也保持打开
    if (panelRef.current?.contains(document.activeElement)) {
      return;
    }
    onPanelMouseLeave?.();
  };

  const hasResults = filteredGroups.length > 0;

  return createPortal(
    <div
      ref={panelRef}
      className="emoji-picker"
      style={position ? { top: position.top, left: position.left } : undefined}
      role="dialog"
      aria-label={t("sidebar.emojiPickerLabel", {
        defaultValue: "Select an emoji",
      })}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseEnter={handlePanelMouseEnter}
      onMouseLeave={handlePanelMouseLeave}
    >
      <div className="emoji-picker-header">
        <span className="emoji-picker-title">
          {t("sidebar.emojiPickerTitle", { defaultValue: "Choose icon" })}
        </span>
        {currentEmoji && (
          <button
            type="button"
            className="emoji-picker-clear-btn"
            onClick={handleClear}
            aria-label={t("sidebar.emojiClear", {
              defaultValue: "Clear emoji",
            })}
            title={t("sidebar.emojiClear", { defaultValue: "Clear emoji" })}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="emoji-picker-search">
        <Search size={12} className="emoji-picker-search-icon" />
        <input
          ref={searchInputRef}
          type="text"
          className="emoji-picker-search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("sidebar.emojiSearchPlaceholder", {
            defaultValue: "Search emoji...",
          })}
        />
        {searchQuery && (
          <button
            type="button"
            className="emoji-picker-search-clear"
            onClick={handleClearSearch}
            aria-label={t("sidebar.emojiClearSearch", {
              defaultValue: "Clear search",
            })}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="emoji-picker-body">
        {hasResults ? (
          filteredGroups.map((group) => (
            <div key={group.key} className="emoji-picker-group">
              <div className="emoji-picker-group-label">
                {searchQuery
                  ? t("sidebar.emojiSearchResults", {
                      defaultValue: "Search results",
                    })
                  : t(GROUP_LABEL_KEYS[group.key], {
                      defaultValue: GROUP_DEFAULT_LABELS[group.key],
                    })}
              </div>
              <div className="emoji-picker-grid">
                {group.emojis.map((entry) => (
                  <button
                    key={entry.char}
                    type="button"
                    className={`emoji-picker-item${
                      entry.char === currentEmoji ? " selected" : ""
                    }`}
                    onClick={() => handleSelect(entry.char)}
                    aria-label={entry.char}
                    title={entry.keywords.join(", ")}
                  >
                    {entry.char}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="emoji-picker-no-results">
            {t("sidebar.emojiNoResults", {
              defaultValue: "No emoji found",
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
