import axios from "axios";
import {
  configStore,
  get as getConfig,
  getBlockChainStorePath,
  WIN_GAME_PATH,
  playerPath,
  EXECUTE_PATH,
  MIXPANEL_TOKEN,
  initializeNode,
  NodeInfo,
  netenv,
  userConfigStore,
  baseUrl,
  CONFIG_FILE_PATH,
} from "../config";
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
} from "electron";
import { NotSupportedPlatformError } from "src/main/exceptions/not-supported-platform";
import { PLATFORM2OS_MAP } from "src/utils/os";
import { enable as remoteEnable } from "@electron/remote/main";
import path from "path";
import fs from "fs";
import { ChildProcessWithoutNullStreams } from "child_process";
import logoImage from "./resources/logo.png";
import { initializeSentry } from "src/utils/sentry";
import "core-js";
import log from "electron-log";
import * as utils from "src/utils";
import {
  HeadlessExitedError,
  HeadlessInitializeError,
} from "../main/exceptions";
import CancellationToken from "cancellationtoken";
import { IGameStartOptions } from "../interfaces/ipc";
import { init as createMixpanel } from "mixpanel";
import { v4 as ipv4 } from "public-ip";
import { v4 as uuidv4 } from "uuid";
import { Client as NTPClient } from "ntp-time";
import { IConfig } from "src/interfaces/config";
import installExtension, {
  REACT_DEVELOPER_TOOLS,
  MOBX_DEVTOOLS,
  APOLLO_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import RemoteHeadless from "./headless/remoteHeadless";
import { NineChroniclesMixpanel } from "./mixpanel";
import {
  createWindow as createV2Window,
  setQuitting as setV2Quitting,
} from "./application";
import fg from "fast-glob";
import {
  performPlayerUpdate,
  cleanUpLockfile,
  isUpdating,
} from "./update/player-update";
import { IUpdateOptions } from "./update/types";
import AppUpdater from "./update/updater";
import { send } from "./ipc";
import { IPC_OPEN_URL } from "src/renderer/ipcTokens";
import {
  initialize as remoteInitialize,
  enable as webEnable,
} from "@electron/remote/main";
import { fork } from "child_process";
import { removeSubscribe } from "src/utils/monsterCollection/removeSubscription";
import {
  KeyId,
  PassphraseEntry,
  Web3Account,
  Web3KeyStore,
  getDefaultWeb3KeyStorePath,
} from "@planetarium/account-web3-secret-storage";

initializeSentry();

Object.assign(console, log.functions);

const REMOTE_CONFIG_URL = `${baseUrl}/${netenv}/config.json`;

let win: BrowserWindow | null = null;
let appUpdaterInstance: AppUpdater | null = null;
let tray: Tray;
let isQuiting: boolean = false;
let gameNode: ChildProcessWithoutNullStreams | null = null;
let ip: string | null = null;
let relaunched: boolean = false;

let initializeHeadlessCts: {
  cancel: (reason?: any) => void;
  token: CancellationToken;
} | null = null;
const client = new NTPClient("time.google.com", 123, { timeout: 5000 });

let remoteHeadless: RemoteHeadless;
let useRemoteHeadless: boolean;
let remoteNode: NodeInfo;

const useUpdate = getConfig("UseUpdate", process.env.NODE_ENV === "production");

const updateOptions: IUpdateOptions = {
  downloadStarted: quitAllProcesses,
};

ipv4().then((value) => (ip = value));

const mixpanelUUID = loadInstallerMixpanelUUID();
const mixpanel: NineChroniclesMixpanel | undefined =
  getConfig("Mixpanel") && process.env.NODE_ENV === "production"
    ? new NineChroniclesMixpanel(createMixpanel(MIXPANEL_TOKEN), mixpanelUUID)
    : undefined;

client
  .syncTime()
  .then((time) => {
    const timeFromNTP = new Date(time.receiveTimestamp);
    const computerTime = new Date();
    const delta = Math.abs(timeFromNTP.getTime() - computerTime.getTime());

    if (delta > 15000) {
      dialog.showErrorBox(
        "Computer Time Incorrect",
        "The current computer time is incorrect. Please sync your computer's time correctly."
      );
    }
  })
  .catch((error) => {
    console.error(error);
  });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const lastArgv = argv[argv.length - 1];
    if (lastArgv.startsWith("ninechronicles-launcher://") && win)
      send(win, IPC_OPEN_URL, lastArgv);
    win?.show();
  });

  app.on("open-url", (_, url) => win && send(win, IPC_OPEN_URL, url));

  let quitTracked = false;
  let removedAddresses: Array<string> = [];
  app.on("before-quit", async (event) => {
    event.preventDefault();

    if (!quitTracked) {
      if (mixpanel != null) {
        mixpanel?.track("Launcher/Quit", undefined, () => {});
      }

      const keyStorePath = getDefaultWeb3KeyStorePath();

      try {
        const files = await fs.promises.readdir(keyStorePath);

        const addresses = [];
        for (const file of files) {
          const filePath = path.join(keyStorePath, file);
          const content = await fs.promises.readFile(filePath, "utf-8");

          const data = JSON.parse(content);
          if (data.address) {
            addresses.push(data.address);
          }
        }

        for (const address of addresses) {
          if (!removedAddresses.includes(address)) {
            await removeSubscribe(`https://${remoteNode.host}`, `0x${address}`);
            console.info("Finish Subscribe address:", address);
            removedAddresses.push(address);
          }
        }
      } catch (error) {
        console.info("Remove Subscribe Error occurred:", error);
      }
    }

    app.quit();
    quitTracked = true;
  });

  cleanUp();

  initializeConfig();
  initializeApp();
  initializeIpc();
}

async function initializeConfig() {
  try {
    const res = await axios(REMOTE_CONFIG_URL);
    const remoteConfig: IConfig = res.data;

    const exists = await fs.promises.stat(CONFIG_FILE_PATH).catch(() => false);

    if (!exists) {
      console.log(
        "Remote not exists, Replace config with remote config:",
        remoteConfig
      );
      configStore.store = remoteConfig;
      return;
    }

    const localConfigVersion = getConfig("ConfigVersion");
    const remoteConfigVersion = remoteConfig.ConfigVersion;
    if (localConfigVersion > remoteConfigVersion) {
      console.log(
        `Local config is newer than remote, ignore. (local: ${localConfigVersion}, remote: ${remoteConfigVersion})`
      );
      return;
    }

    // Replace config
    console.log("Replace config with remote config:", remoteConfig);
    configStore.store = remoteConfig;
  } catch (error) {
    console.error(
      `An unexpected error occurred during fetching remote config. ${error}`
    );
  }

  log.transports.file.maxSize = getConfig("LogSizeBytes");
}

async function initializeApp() {
  console.log("initializeApp");

  const isProtocolSet = app.setAsDefaultProtocolClient(
    "ninechronicles-launcher",
    process.execPath,
    [!app.isPackaged && path.resolve(process.argv[1]), "--protocol"].filter(
      Boolean
    )
  );
  console.log("isProtocolSet", isProtocolSet);

  app.on("ready", async () => {
    remoteInitialize();
    if (process.env.NODE_ENV !== "production")
      await installExtension([
        REACT_DEVELOPER_TOOLS,
        MOBX_DEVTOOLS,
        APOLLO_DEVELOPER_TOOLS,
      ])
        .then((name) => console.log(`Added Extension:  ${name}`))
        .catch((err) => console.log("An error occurred: ", err));

    win = await createV2Window();

    if (useUpdate) {
      appUpdaterInstance = new AppUpdater(win, baseUrl, updateOptions);
      initCheckForUpdateWorker(win, appUpdaterInstance);
    }

    webEnable(win.webContents);
    createTray(path.join(app.getAppPath(), logoImage));

    try {
      remoteNode = await initializeNode();
    } catch (e) {
      console.error(e);
      const { checkboxChecked } = await dialog.showMessageBox(win!, {
        message: "Failed to connect remote node. please restart launcher.",
        type: "error",
        checkboxLabel: "Disable RPC mode",
      }); // TODO Replace with "go to error page" event
      if (checkboxChecked) userConfigStore.set("UseRemoteHeadless", false);

      app.exit();
    }

    if (app.commandLine.hasSwitch("protocol"))
      send(win!, IPC_OPEN_URL, process.argv[process.argv.length - 1]);

    mixpanel?.track("Launcher/Start", {
      isV2: true,
      useRemoteHeadless,
    });

    // Detects and move old snapshot caches as they're unused.
    // Ignores any failure as they're not critical.
    fg("snapshot-*", { cwd: app.getPath("userData") }).then((files) =>
      Promise.allSettled(files.map((file) => fs.promises.unlink(file)))
    );
    console.log("main initializeApp call initializeRemoteHeadless");
    initializeRemoteHeadless();
  });

  app.on("quit", (event) => {
    quitAllProcesses();
  });

  app.on("activate", async (event) => {
    event.preventDefault();
    win?.show();
  });
}

function initializeIpc() {
  ipcMain.on("launch game", (_, info: IGameStartOptions) => {
    if (gameNode !== null) {
      console.error("Game is already running.");
      return;
    }

    if (isUpdating()) {
      console.error("Cannot launch game while updater is running.");
      return;
    }

    const node = utils.execute(
      EXECUTE_PATH[process.platform] || WIN_GAME_PATH,
      info.args
    );

    node.on("close", (code) => {
      // Code 21: ERROR_NOT_READY
      if (code === 21) {
        relaunch();
      }
      win?.webContents.send("game closed");
      win?.show();
    });
    node.on("exit", (code) => {
      win?.webContents.send("game closed");
      win?.show();
      gameNode = null;
    });
    gameNode = node;
  });

  ipcMain.handle("clear cache", async (event, rerun: boolean) => {
    console.log(`Clear cache is requested. (rerun: ${rerun})`);
    mixpanel?.track("Launcher/Clear Cache");
    await quitAllProcesses("clear-cache");
    utils.deleteBlockchainStoreSync(getBlockChainStorePath());
    if (rerun) {
      console.log("main clear cache call initializeRemoteHeadless");
      await initializeRemoteHeadless();
    }
    return true;
  });

  ipcMain.handle("execute launcher update", async (event) => {
    if (appUpdaterInstance === null) throw Error("appUpdaterInstance is null");
    await appUpdaterInstance.execute();
  });

  ipcMain.on("select-directory", async (event) => {
    if (win === null) throw Error("BrowserWindow is null");
    const directory = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (directory.canceled) {
      event.returnValue = null;
    } else {
      event.returnValue = directory.filePaths;
    }
  });

  ipcMain.on("login", async () => {
    mixpanel?.login();
  });

  ipcMain.on("relaunch standalone", async (event, param: object) => {
    mixpanel?.track("Launcher/Relaunch Headless", {
      relaunched,
      ...param,
    });
    await relaunchHeadless();
    relaunched = true;
    event.returnValue = true;
  });

  ipcMain.on("get-aws-sink-cloudwatch-guid", async (event) => {
    const localAppData = process.env.localappdata;
    if (process.platform === "win32" && localAppData !== undefined) {
      const guidPath = path.join(
        localAppData,
        "planetarium",
        ".aws_sink_cloudwatch_guid"
      );

      if (fs.existsSync(guidPath)) {
        event.returnValue = await fs.promises.readFile(guidPath, {
          encoding: "utf-8",
        });
      } else {
        event.returnValue = null;
      }

      return;
    }

    event.returnValue = "Not supported platform.";
  });

  ipcMain.on(
    "mixpanel-track-event",
    async (_, eventName: string, param: object) => {
      mixpanel?.track(eventName, {
        ...param,
      });
    }
  );

  ipcMain.on("mixpanel-alias", async (_, alias: string) => {
    mixpanel?.alias(alias);
  });

  ipcMain.on("online-status-changed", (event, status: "online" | "offline") => {
    console.log(`online-status-changed: ${status}`);
    if (status === "offline") {
      relaunch();
    }
  });

  ipcMain.handle("get-node-info", async () => {
    while (!remoteNode) {
      await utils.sleep(100);
    }
    return remoteNode;
  });
}

async function initializeRemoteHeadless(): Promise<void> {
  /*
  1. Check APV and update if needed.
  2. Execute remote headless.
  */
  console.log(`Initialize remote headless. (win: ${win?.getTitle()})`);

  if (initializeHeadlessCts !== null) {
    console.error(
      "Cannot initialize remote headless while initializing headless."
    );
    return;
  }

  if (isUpdating()) {
    console.error(
      "Cannot initialize remote headless while updater is running."
    );
    return;
  }

  initializeHeadlessCts = CancellationToken.create();

  try {
    initializeHeadlessCts.token.throwIfCancelled();
    win?.webContents.send("start remote headless");
    // console.log("main call remote_node");
    remoteHeadless = new RemoteHeadless(remoteNode!);
    await remoteHeadless.execute();
  } catch (error) {
    console.error(
      `Error occurred during initialize remote headless(). ${error}`
    );
    if (
      error instanceof HeadlessInitializeError ||
      error instanceof CancellationToken.CancellationError
    ) {
      console.error(`Initialize remote headless() halted: ${error}`);
    } else if (error instanceof HeadlessExitedError) {
      console.error("remote headless exited during initialization:", error);
      win?.webContents.send("go to error page", "clear-cache");
    } else {
      win?.webContents.send("go to error page", "reinstall");
      throw error;
    }
  } finally {
    console.log("initialize remote headless() finished.");
    initializeHeadlessCts = null;
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const _win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      preload: path.join(app.getAppPath(), "preload.js"),
    },
    frame: true,
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), logoImage),
  });
  remoteEnable(_win.webContents);

  _win.setResizable(false); // see: https://github.com/electron/electron/issues/19565#issuecomment-867283465

  console.log(app.getAppPath());

  if (process.env.NODE_ENV !== "production") {
    await _win.loadURL("http://localhost:9000");
    await _win.webContents.openDevTools();
  } else {
    _win.loadFile("index.html");
  }

  _win.on("close", function (event: any) {
    if (!isQuiting) {
      event.preventDefault();
      _win?.hide();
    }
  });

  _win.webContents.on("new-window", function (event: any, url: string) {
    event.preventDefault();
    shell.openExternal(url);
  });

  return _win;
}

/**
 * Clean up the byproducts from the previous runs at the start of the program.
 */
function cleanUp() {
  cleanUpLockfile();
}

function loadInstallerMixpanelUUID(): string {
  const planetariumPath =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA as string, "planetarium")
      : app.getPath("userData");
  if (!fs.existsSync(planetariumPath)) {
    fs.mkdirSync(planetariumPath, {
      recursive: true,
    });
  }

  const guidPath = path.join(planetariumPath, ".installer_mixpanel_uuid");

  if (!fs.existsSync(guidPath)) {
    const newUUID = uuidv4();
    console.log(`The installer mixpanel UUID doesn't exist at '${guidPath}'.`);
    fs.writeFileSync(guidPath, newUUID);
    console.log(`Created new UUID ${newUUID} and stored.`);
    return newUUID;
  } else {
    return fs.readFileSync(guidPath, {
      encoding: "utf-8",
    });
  }
}

async function relaunchHeadless(reason: string = "default") {
  await initializeRemoteHeadless();
}

async function quitAllProcesses(reason: string = "default") {
  if (gameNode === null) return;
  const pid = gameNode.pid!;
  process.kill(pid, "SIGINT");
  gameNode = null;
}

function createTray(iconPath: string) {
  let trayIcon = nativeImage.createFromPath(iconPath);
  trayIcon = trayIcon.resize({
    width: 16,
    height: 16,
  });
  tray = new Tray(trayIcon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Window",
        click: function () {
          win?.show();
        },
      },
      {
        label: "Restart Launcher",
        click: function () {
          relaunch();
        },
      },
      {
        label: "Quit Launcher",
        click: function () {
          isQuiting = true;
          setV2Quitting(true);
          app.quit();
        },
      },
    ])
  );
  tray.on("click", function () {
    win?.show();
  });
  return tray;
}

function relaunch() {
  if (mixpanel !== undefined) {
    mixpanel.track("Launcher/Relaunch", undefined, () => {
      app.relaunch();
      app.exit();
    });
  } else {
    app.relaunch();
    app.exit();
  }
}

function initCheckForUpdateWorker(
  win: BrowserWindow,
  appUpdaterInstance: AppUpdater
) {
  interface Message {
    type: string;
    [key: string]: any;
  }

  const os = PLATFORM2OS_MAP[process.platform];
  const publishedStorageBaseUrl = `${baseUrl}/${netenv}`;

  if (os == null) {
    throw new NotSupportedPlatformError(process.platform);
  }

  const checkForUpdateWorker = fork(
    path.join(__dirname, "./checkForUpdateWorker.js"),
    [],
    {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        playerPath,
        os,
        baseUrl: publishedStorageBaseUrl,
      },
    }
  );

  checkForUpdateWorker.on("message", (message: Message) => {
    if (message.type === "player update") {
      console.log("Encountered player update", message);
      performPlayerUpdate(win, message.path, message.size, updateOptions);
    }
    if (message.type === "launcher update") {
      appUpdaterInstance.checkForUpdate();
    }
    if (message.type === "log") {
      console[message.level as "debug" | "error" | "log"](
        "[checkForUpdateWorker] " + message.body
      );
    }
  });

  checkForUpdateWorker.on("error", (error) => {
    console.error("Error in child process:", error);
  });

  checkForUpdateWorker.on("exit", (code) => {
    console.log(`Child process exited with code ${code}`);
  });
}
