import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type {
  AppNotificationSound,
  BuiltinNotificationSound,
  NotificationSoundPreset,
} from "../../shared/notification";

/**
 * 通知提示音播放（渲染进程侧）。
 *
 * 系统通知自带音效由操作系统播放；内置音效与自定义 MP3 在这里播放：
 * - 内置音效：WebAudio 实时合成，不需要打包音频资源
 * - 自定义 MP3：读取本地文件生成 Blob URL 后播放，播完即释放
 */

/** 自定义提示音文件大小上限，避免误选超大文件时卡住渲染进程 */
const MAX_CUSTOM_SOUND_BYTES = 24 * 1024 * 1024;

/** 单个音符：相对起点的延迟、时长与音色 */
type NotificationTone = {
  frequency: number;
  delayMs: number;
  durationMs: number;
  type: OscillatorType;
  gain: number;
};

const BUILTIN_TONES: Record<BuiltinNotificationSound, NotificationTone[]> = {
  chime: [
    {
      frequency: 880,
      delayMs: 0,
      durationMs: 200,
      type: "sine",
      gain: 0.22,
    },
    {
      frequency: 1318.5,
      delayMs: 110,
      durationMs: 320,
      type: "sine",
      gain: 0.18,
    },
  ],
  bell: [
    {
      frequency: 659.3,
      delayMs: 0,
      durationMs: 900,
      type: "triangle",
      gain: 0.2,
    },
    {
      frequency: 987.8,
      delayMs: 0,
      durationMs: 700,
      type: "sine",
      gain: 0.1,
    },
  ],
  pop: [
    {
      frequency: 520,
      delayMs: 0,
      durationMs: 110,
      type: "sine",
      gain: 0.3,
    },
    {
      frequency: 780,
      delayMs: 60,
      durationMs: 90,
      type: "sine",
      gain: 0.14,
    },
  ],
  wood: [
    {
      frequency: 440,
      delayMs: 0,
      durationMs: 90,
      type: "triangle",
      gain: 0.16,
    },
    {
      frequency: 330,
      delayMs: 75,
      durationMs: 80,
      type: "triangle",
      gain: 0.14,
    },
  ],
};

let audioContext: AudioContext | null = null;

const getAudioContext = (): AudioContext | null => {
  try {
    audioContext ??= new AudioContext({ latencyHint: "interactive" });
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }
    return audioContext;
  } catch (error) {
    console.warn("[notification] Failed to create audio context", error);
    return null;
  }
};

const playBuiltinSound = (preset: BuiltinNotificationSound): void => {
  const tones = BUILTIN_TONES[preset];
  const context = getAudioContext();
  if (!tones || !context) {
    return;
  }

  const base = context.currentTime + 0.02;
  for (const tone of tones) {
    const start = base + tone.delayMs / 1000;
    const end = start + tone.durationMs / 1000;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(tone.gain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
};

const playCustomSound = async (filePath: string): Promise<void> => {
  if (extname(filePath).toLowerCase() !== ".mp3") {
    return;
  }

  let objectUrl = "";
  try {
    const info = await stat(filePath);
    if (
      !info.isFile() ||
      info.size <= 0 ||
      info.size > MAX_CUSTOM_SOUND_BYTES
    ) {
      return;
    }

    const bytes = await readFile(filePath);
    objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }),
    );
    const audio = new Audio(objectUrl);
    const release = (): void => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = "";
      }
    };
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    await audio.play();
  } catch (error) {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    console.warn("[notification] Failed to play custom sound", error);
  }
};

/** 播放主进程解析出的通知提示音。 */
export const playNotificationSound = async (
  sound: AppNotificationSound,
): Promise<void> => {
  if (sound.kind === "custom") {
    await playCustomSound(sound.path);
    return;
  }

  playBuiltinSound(sound.preset);
};

/** 设置页「试听」：按用户当前选择播放一次（系统默认音效无需试听）。 */
export const previewNotificationSound = async (
  preset: NotificationSoundPreset,
  customSoundPath?: string,
): Promise<void> => {
  if (preset === "custom") {
    if (customSoundPath) {
      await playCustomSound(customSoundPath);
    }
    return;
  }

  if (preset === "system" || preset === "none") {
    return;
  }

  playBuiltinSound(preset);
};
