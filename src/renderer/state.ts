import { action, autorun, observable } from 'mobx';

import { ElectronVersion, OutputEntry } from '../interfaces';
import { IpcEvents } from '../ipc-events';
import { arrayToStringMap } from '../utils/array-to-stringmap';
import { getName } from '../utils/get-title';
import { normalizeVersion } from '../utils/normalize-version';
import { BinaryManager } from './binary';
import { updateEditorTypeDefinitions } from './fetch-types';
import { ipcRendererManager } from './ipc';
import { getKnownVersions, getUpdatedKnownVersions } from './versions';

const knownVersions = getKnownVersions();
const defaultVersion = normalizeVersion(knownVersions[0].tag_name);

/**
 * Editors exist outside of React's world. To make things *a lot*
 * easier, we keep them around in a global object. Don't judge us,
 * we're really only doing that for the editors.
 */
window.ElectronFiddle = {
  editors: {
    main: null,
    renderer: null,
    html: null
  },
  app: null
} as any;

/**
 * The application's state. Exported as a singleton below.
 *
 * @export
 * @class AppState
 */
export class AppState {
  @observable public gistId: string = '';
  @observable public version: string = defaultVersion;
  @observable public gitHubAvatarUrl: string | null = localStorage.getItem('gitHubAvatarUrl');
  @observable public gitHubName: string | null = localStorage.getItem('gitHubName');
  @observable public gitHubLogin: string | null = localStorage.getItem('gitHubLogin');
  @observable public gitHubToken: string | null = localStorage.getItem('gitHubToken') || null;
  @observable public binaryManager: BinaryManager = new BinaryManager();
  @observable public versions: Record<string, ElectronVersion> = arrayToStringMap(knownVersions);
  @observable public output: Array<OutputEntry> = [];
  @observable public localPath: string | null = null;
  @observable public isConsoleShowing: boolean = false;
  @observable public isTokenDialogShowing: boolean = false;
  @observable public isSettingsShowing: boolean = false;
  @observable public isUnsaved: boolean = false;
  @observable public isMyGist: boolean = false;
  @observable public isTourShowing: boolean = !localStorage.getItem('hasShownTour');

  private outputBuffer: string = '';
  private name: string;

  constructor() {
    // Bind all actions
    this.downloadVersion = this.downloadVersion.bind(this);
    this.pushError = this.pushError.bind(this);
    this.pushOutput = this.pushOutput.bind(this);
    this.removeVersion = this.removeVersion.bind(this);
    this.setVersion = this.setVersion.bind(this);
    this.showTour = this.showTour.bind(this);
    this.signOutGitHub = this.signOutGitHub.bind(this);
    this.toggleAuthDialog = this.toggleAuthDialog.bind(this);
    this.toggleConsole = this.toggleConsole.bind(this);
    this.toggleSettings = this.toggleSettings.bind(this);

    ipcRendererManager.on(IpcEvents.OPEN_SETTINGS, this.toggleSettings);
    ipcRendererManager.on(IpcEvents.SHOW_WELCOME_TOUR, this.showTour);

    // Setup autoruns
    autorun(() => localStorage.setItem('gitHubAvatarUrl', this.gitHubAvatarUrl || ''));
    autorun(() => localStorage.setItem('gitHubLogin', this.gitHubLogin || ''));
    autorun(() => localStorage.setItem('gitHubName', this.gitHubName || ''));
    autorun(() => localStorage.setItem('gitHubToken', this.gitHubToken || ''));

    // Update our known versions
    getUpdatedKnownVersions().then((versions) => {
      this.versions = arrayToStringMap(versions);
      this.updateDownloadedVersionState();
    });
  }

  @action public async getName() {
    if (!this.name) {
      this.name = await getName(this);
    }

    return this.name;
  }

  @action public toggleConsole() {
    this.isConsoleShowing = !this.isConsoleShowing;
  }

  @action public toggleAuthDialog() {
    this.isTokenDialogShowing = !this.isTokenDialogShowing;
  }

  @action public toggleSettings() {
    // We usually don't lose editor focus,
    // so you can still type. Let's force-blur.
    if ((document.activeElement as HTMLInputElement).blur) {
      (document.activeElement as HTMLInputElement).blur();
    }

    this.resetView({ isSettingsShowing: !this.isSettingsShowing });
  }

  @action public disableTour() {
    this.resetView({ isTourShowing: false });
    localStorage.setItem('hasShownTour', 'true');
  }

  @action public showTour() {
    this.resetView({ isTourShowing: true });
  }

 /*
  * Remove a version of Electron
  *
  * @param {string} input
  * @returns {Promise<void>}
  */
  @action public async removeVersion(input: string) {
    const version = normalizeVersion(input);
    console.log(`State: Removing Electron ${version}`);

    // Already not present?
    if ((this.versions[version] || { state: '' }).state !== 'ready') {
      console.log(`State: Version already removed, doing nothing`);
      return;
    }

    // Actually remove
    await this.binaryManager.remove(version);

    // Update state
    const updatedVersions = { ...this.versions };
    updatedVersions[version].state = 'unknown';

    this.versions = updatedVersions;
    this.updateDownloadedVersionState();
  }

 /*
  * Download a version of Electron.
  *
  * @param {string} input
  * @returns {Promise<void>}
  */
  @action public async downloadVersion(input: string) {
    const version = normalizeVersion(input);
    console.log(`State: Downloading Electron ${version}`);

    // Fetch new binaries, maybe?
    if ((this.versions[version] || { state: '' }).state !== 'ready') {
      console.log(`State: Instructing BinaryManager to fetch v${version}`);
      const updatedVersions = { ...this.versions };
      updatedVersions[version] = updatedVersions[version] || {};
      updatedVersions[version].state = 'downloading';
      this.versions = updatedVersions;

      await this.binaryManager.setup(version);
      this.updateDownloadedVersionState();
    } else {
      console.log(`State: Version ${version} already downloaded, doing nothing.`);
    }
  }

 /*
  * Select a version of Electron (and download it if necessary).
  *
  * @param {string} input
  * @returns {Promise<void>}
  */
  @action public async setVersion(input: string) {
    const version = normalizeVersion(input);
    console.log(`State: Switching to Electron ${version}`);

    this.version = version;

    // Update TypeScript definitions
    updateEditorTypeDefinitions(version);

    // Fetch new binaries, maybe?
    await this.downloadVersion(version);
  }

 /*
  * Go and check which versions have already been downloaded.
  *
  * @returns {Promise<void>}
  */
  @action public async updateDownloadedVersionState(): Promise<void> {
    const downloadedVersions = await this.binaryManager.getDownloadedVersions();
    const updatedVersions = { ...this.versions };

    console.log(`State: Updating version state`);
    downloadedVersions.forEach((version) => {
      if (updatedVersions[version]) {
        updatedVersions[version].state = 'ready';
      }
    });

    this.versions = updatedVersions;
  }

  /**
   * The equivalent of signing out.
   *
   * @returns {void}
   */
  @action public signOutGitHub(): void {
    this.gitHubAvatarUrl = null;
    this.gitHubLogin = null;
    this.gitHubToken = null;
    this.gitHubName = null;
  }

  /**
   * Push output to the application's state. Accepts a buffer or a string as input,
   * attaches a timestamp, and pushes into the store.
   *
   * @param {(string | Buffer)} data
   */
  @action public pushOutput(data: string | Buffer, bypassBuffer: boolean = true) {
    let strData = data.toString();

    if (process.platform === 'win32' && !bypassBuffer) {
      this.outputBuffer += strData;
      strData = this.outputBuffer;
      const parts = strData.split('\r\n');

      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (partIndex === parts.length - 1) {
          this.outputBuffer = part;
          continue;
        }

        this.pushOutput(part);
      }

      return;
    }

    if (strData.startsWith('Debugger listening on ws://')) return;
    if (strData === 'For help see https://nodejs.org/en/docs/inspector') return;

    this.output.push({
      timestamp: Date.now(),
      text: strData.trim()
    });
  }

  /**
   * Little convenience method that pushes message and error.
   *
   * @param {string} message
   * @param {Error} error
   */
  @action public pushError(message: string, error: Error) {
    this.pushOutput(`⚠️ ${message} Error encountered:`);
    this.pushOutput(error.toString());
    console.warn(error);
  }

  /**
   * Resets the view, optionally with certain view flags enabled.
   *
   * @param {Record<string, boolean>} [additionalOptions]
   * @memberof AppState
   */
  @action private resetView(additionalOptions?: Record<string, boolean>) {
    this.isTokenDialogShowing = false;
    this.isSettingsShowing = false;
    this.isTourShowing = false;
    this.isConsoleShowing = false;

    if (additionalOptions) {
      for (const key in additionalOptions) {
        if (additionalOptions.hasOwnProperty(key)) {
          this[key] = additionalOptions[key];
        }
      }
    }

    this.setPageHash();
  }

  /**
   * Updates the pages url with a hash element that allows the main
   * process to quickly determine if there's a view open.
   *
   * @private
   * @memberof AppState
   */
  @action private setPageHash() {
    let hash = '';

    if (this.isSettingsShowing) {
      hash = 'settings';
    }

    window.location.hash = hash;
  }
}

export const appState = new AppState();
appState.setVersion(appState.version);
