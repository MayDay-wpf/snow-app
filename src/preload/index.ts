import { contextBridge } from "electron";
import { apiConfigApi } from "./modules/apiConfigApi";
import { configApi } from "./modules/configApi";
import { conversationApi } from "./modules/conversationApi";
import { workspaceApi } from "./modules/workspaceApi";
import { sshApi } from "./modules/sshApi";
import { gitApi } from "./modules/gitApi";
import { teamApi } from "./modules/teamApi";
import { systemApi, ptyApi, windowApi } from "./modules/systemApi";
import { memoApi } from "./modules/memoApi";
import { scheduledTaskApi } from "./modules/scheduledTaskApi";
import { personalizationApi } from "./modules/personalizationApi";
import { codexApi } from "./modules/codexApi";
import { importConfigApi } from "./modules/importConfigApi";
import { pluginsApi } from "./modules/pluginsApi";
import { imageLibraryApi } from "./modules/imageLibraryApi";
import { storageApi } from "./modules/storageApi";
import { resourceApi } from "./modules/resourceApi";
import { ideApi } from "./modules/ideApi";
import { petApi } from "./modules/petApi";

export type * from "./types";

const api = {
  ...apiConfigApi,
  ...configApi,
  ...conversationApi,
  ...workspaceApi,
  ...sshApi,
  ...gitApi,
  ...teamApi,
  ...systemApi,
  ...ptyApi,
  ...windowApi,
  ...memoApi,
  ...scheduledTaskApi,
  ...personalizationApi,
  ...codexApi,
  ...importConfigApi,
  ...pluginsApi,
  ...imageLibraryApi,
  ...storageApi,
  ...resourceApi,
  ...ideApi,
  ...petApi,
};

contextBridge.exposeInMainWorld("snow", api);

export type SnowApi = typeof api;
