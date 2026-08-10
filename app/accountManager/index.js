const { app, session, ipcMain, powerMonitor, dialog } = require('electron');
const { LucidLog } = require('lucid-log');

/**
 * Owns the list of accounts and the BrowserWindow per account.
 *
 * Each account is backed by its own persistent Electron partition
 * (`persist:outlook-<id>`), so each holds an independent Outlook login.
 * Windows are managed with a hybrid cache: the active account's window is
 * shown, up to `config.accountCacheSize` others are kept alive (hidden) for
 * instant switching, and the rest are destroyed ("cold") — their login
 * persists in the partition, so re-switching recreates the window without
 * requiring a fresh sign-in.
 */
class AccountManager {
	constructor() {
		this.appConfig = null;
		this.config = null;
		this.iconChooser = null;
		this.logger = null;
		/** @type {Map<string, {window: Electron.BrowserWindow, connMgr: any, state: string, lastUsed: number}>} */
		this.windows = new Map();
		this.activeId = null;
		this.allowQuit = false;
		this.badgeCounts = new Map();
		this.changeListeners = [];
		this._globalHandlersRegistered = false;
	}

	/**
	 * @param {import('../appConfiguration').AppConfiguration} appConfig
	 * @param {{config: object, iconChooser: object, logger: LucidLog}} deps
	 */
	init(appConfig, deps) {
		this.appConfig = appConfig;
		this.config = deps.config;
		this.iconChooser = deps.iconChooser;
		this.logger = deps.logger || new LucidLog({ levels: this.config.appLogLevels.split(',') });
		this._registerGlobalHandlers();
		this._migrate();
	}

	get settingsStore() {
		return this.appConfig.settingsStore;
	}

	// ── account list persistence ──────────────────────────────────────────

	getAccounts() {
		return this.settingsStore.get('app.accounts') || [];
	}

	saveAccounts(accounts) {
		this.settingsStore.set('app.accounts', accounts);
		this._notifyChange();
	}

	getAccount(id) {
		return this.getAccounts().find(a => a.id === id);
	}

	/**
	 * First-run migration: if there are no accounts yet, seed one from the
	 * existing default partition so current users keep their logged-in session.
	 */
	_migrate() {
		let accounts = this.getAccounts();
		if (!accounts.length) {
			accounts = [{
				id: 'default',
				name: 'Account 1',
				partition: this.config.partition,
				addedAt: 0
			}];
			this.settingsStore.set('app.accounts', accounts);
		}
		this.activeId = accounts[0].id;
	}

	// ── active window access ─────────────────────────────────────────────

	getActive() {
		if (!this.activeId) return { window: null, connMgr: null };
		const entry = this.windows.get(this.activeId);
		if (!entry || entry.window.isDestroyed()) return { window: null, connMgr: null };
		return { window: entry.window, connMgr: entry.connMgr };
	}

	/**
	 * Ensure the active account's window exists and is shown.
	 */
	async showActive() {
		await this._maybeClearStorage(this.activeId);
		await this.ensureWindow(this.activeId);
		const entry = this.windows.get(this.activeId);
		entry.state = 'active';
		entry.lastUsed = Date.now();
		if (this.config.minimized) {
			entry.window.hide();
		} else {
			entry.window.show();
			entry.window.focus();
		}
		if (this.config.webDebug) {
			entry.window.openDevTools();
		}
		this._restoreBadge();
		this._notifyChange();
	}

	// ── window lifecycle ─────────────────────────────────────────────────

	/**
	 * Create the BrowserWindow for an account if it is not already alive.
	 * @param {string} id
	 */
	async ensureWindow(id) {
		const existing = this.windows.get(id);
		if (existing && !existing.window.isDestroyed()) {
			return existing;
		}
		const account = this.getAccount(id);
		if (!account) {
			return null;
		}
		const mainAppWindow = require('../mainAppWindow');
		const window = mainAppWindow.createWindow(account, this);
		const ConnectionManager = require('../connectionManager');
		const connMgr = new ConnectionManager();
		connMgr.start(null, { window, config: this.config });
		const entry = { window, connMgr, state: 'cold', lastUsed: Date.now() };
		this.windows.set(id, entry);
		return entry;
	}

	/**
	 * Switch the visible account to `id`.
	 * @param {string} id
	 */
	async switchTo(id) {
		if (!this.getAccount(id)) {
			return;
		}
		if (id === this.activeId) {
			const active = this.getActive();
			if (active.window) {
				active.window.show();
				active.window.focus();
			}
			return;
		}
		// Hide the currently active window (keep it cached).
		const prev = this.windows.get(this.activeId);
		if (prev && !prev.window.isDestroyed()) {
			prev.window.hide();
			prev.state = 'cached';
			prev.lastUsed = Date.now();
		}
		this.activeId = id;
		await this.ensureWindow(id);
		const entry = this.windows.get(id);
		entry.state = 'active';
		entry.lastUsed = Date.now();
		entry.window.show();
		entry.window.focus();
		this._evictIfNeeded();
		this._restoreBadge();
		this._notifyChange();
	}

	/**
	 * Apply the `clearStorage` flag once at startup to the active account's
	 * partition. Mirrors the previous single-window behaviour.
	 */
	async _maybeClearStorage(id) {
		if (this._storageCleared || !this.config.clearStorage) {
			return;
		}
		this._storageCleared = true;
		const account = this.getAccount(id);
		if (account) {
			await session.fromPartition(account.partition).clearStorageData();
		}
	}

	/**
	 * Evict least-recently-used cached windows until the cache fits
	 * `config.accountCacheSize`. Evicted windows are destroyed (cold).
	 */
	_evictIfNeeded() {
		const max = this.config.accountCacheSize || 2;
		const cached = [...this.windows.entries()]
			.filter(([, e]) => e.state === 'cached')
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		while (cached.length > max) {
			const [id] = cached.shift();
			const entry = this.windows.get(id);
			if (entry && !entry.window.isDestroyed()) {
				entry.window.destroy();
			}
			this.windows.delete(id);
		}
	}

	/**
	 * Add a new account on a fresh partition and switch to it. The Outlook
	 * login page loads in the new window; signing in once captures the
	 * session in that partition permanently.
	 */
	async addAccount() {
		const id = 'acc-' + Math.random().toString(36).slice(2, 10);
		const accounts = this.getAccounts();
		const account = {
			id,
			name: `Account ${accounts.length + 1}`,
			partition: `persist:outlook-${id}`,
			addedAt: Date.now()
		};
		accounts.push(account);
		this.saveAccounts(accounts);
		await this.switchTo(id);
	}

	/**
	 * Remove an account: destroy its window, clear its partition storage,
	 * and delete it from the list. At least one account is always kept.
	 * @param {string} id
	 */
	async removeAccount(id) {
		const accounts = this.getAccounts();
		if (accounts.length <= 1) {
			return;
		}
		const acc = accounts.find(a => a.id === id);
		if (!acc) {
			return;
		}
		const parent = this.getActive().window;
		const choice = dialog.showMessageBoxSync(parent, {
			type: 'warning',
			buttons: ['Remove', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			title: 'Remove account',
			message: `Remove "${acc.name}"?`,
			detail: 'This account\'s saved login data will be cleared.'
		});
		if (choice !== 0) {
			return;
		}
		const entry = this.windows.get(id);
		if (entry) {
			if (!entry.window.isDestroyed()) {
				entry.window.destroy();
			}
			this.windows.delete(id);
		}
		try {
			await session.fromPartition(acc.partition).clearStorageData();
		} catch (e) {
			this.logger.error(`Failed to clear storage for ${acc.name}: ${e.message}`);
		}
		const remaining = accounts.filter(a => a.id !== id);
		this.badgeCounts.delete(id);
		this.saveAccounts(remaining);
		if (this.activeId === id) {
			this.activeId = remaining[0].id;
			await this.showActive();
		}
	}

	/**
	 * Called from the window factory when a window has actually been closed
	 * (destroyed), as opposed to hidden.
	 * @param {string} id
	 */
	handleWindowClosed(id) {
		this.windows.delete(id);
		if (this.activeId === id && !this.allowQuit) {
			const accounts = this.getAccounts();
			if (accounts.length) {
				this.activeId = accounts[0].id;
				this.showActive();
			}
		}
	}

	/**
	 * Quit the whole application: allow all windows to close, then quit.
	 */
	quitAll() {
		this.allowQuit = true;
		app.quit();
	}

	/**
	 * Rename an account. The name is what the switcher and tray display.
	 * @param {string} id
	 * @param {string} name
	 */
	renameAccount(id, name) {
		name = (name || '').trim();
		if (!name) {
			return;
		}
		const accounts = this.getAccounts();
		const account = accounts.find(a => a.id === id);
		if (!account) {
			return;
		}
		account.name = name;
		this.saveAccounts(accounts);
	}

	// ── badge count ──────────────────────────────────────────────────────

	/**
	 * @param {Electron.WebContents} webContents
	 * @param {number} count
	 */
	setBadgeCount(webContents, count) {
		const id = this._idByWebContents(webContents);
		if (!id) {
			return;
		}
		this.badgeCounts.set(id, count);
		if (id === this.activeId) {
			app.setBadgeCount(count);
		}
	}

	_restoreBadge() {
		const count = this.badgeCounts.get(this.activeId) || 0;
		app.setBadgeCount(count);
	}

	_idByWebContents(webContents) {
		for (const [id, entry] of this.windows) {
			if (entry.window && !entry.window.isDestroyed() && entry.window.webContents === webContents) {
				return id;
			}
		}
		return null;
	}

	/**
	 * Returns the partition of the account owning the given webContents, so
	 * per-window config (e.g. zoom level) is keyed per account.
	 * @param {Electron.WebContents} webContents
	 */
	partitionForWebContents(webContents) {
		const id = this._idByWebContents(webContents);
		const account = id && this.getAccount(id);
		return account ? account.partition : null;
	}

	/**
	 * Returns the account owning the given webContents, or null. Used by the
	 * new-mail handler to address the notification to the right account.
	 * @param {Electron.WebContents} webContents
	 */
	getAccountByWebContents(webContents) {
		const id = this._idByWebContents(webContents);
		return id ? this.getAccount(id) : null;
	}

	// ── state for the renderer switcher ──────────────────────────────────

	/**
	 * @param {Electron.WebContents} webContents
	 */
	getStateForWebContents(webContents) {
		return {
			accounts: this.getAccounts(),
			activeId: this.activeId,
			selfId: this._idByWebContents(webContents)
		};
	}

	// ── change notification (tray rebuild + renderer broadcast) ──────────

	/**
	 * @param {() => void} cb
	 */
	onChange(cb) {
		this.changeListeners.push(cb);
	}

	_notifyChange() {
		for (const cb of this.changeListeners) {
			try {
				cb();
			} catch (e) {
				this.logger.error(`change listener failed: ${e.message}`);
			}
		}
		const payload = JSON.stringify({
			accounts: this.getAccounts(),
			activeId: this.activeId
		});
		for (const [, entry] of this.windows) {
			if (entry.window && !entry.window.isDestroyed()) {
				entry.window.webContents.send('accounts:updated', payload);
			}
		}
	}

	// ── global handlers (registered once) ────────────────────────────────

	_registerGlobalHandlers() {
		if (this._globalHandlersRegistered) {
			return;
		}
		this._globalHandlersRegistered = true;
		ipcMain.on('offline-retry', () => this.refreshAll());
		powerMonitor.on('resume', () => this.refreshAll());
	}

	refreshAll() {
		for (const [, entry] of this.windows) {
			if (entry.connMgr) {
				entry.connMgr.refresh();
			}
		}
	}
}

module.exports = new AccountManager();