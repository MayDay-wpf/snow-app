import {
  NOTIFICATION_SETTINGS_CODE,
  parseNotificationSettings,
  type NotificationSettings,
} from "../../shared/notification";
import { native } from "../native/nativeBridge";

/**
 * 读取系统通知设置。
 *
 * 通知本身是低频事件，这里直接读一次系统设置（Rust 侧异步查询），
 * 不做缓存，保证设置页改完立即生效。
 */
export const readNotificationSettings =
  async (): Promise<NotificationSettings> => {
    try {
      const raw = await native.getSystemSettingValue(
        NOTIFICATION_SETTINGS_CODE,
      );
      return parseNotificationSettings(raw);
    } catch (error) {
      console.warn(
        "[notification] Failed to read notification settings",
        error,
      );
      return parseNotificationSettings(null);
    }
  };
