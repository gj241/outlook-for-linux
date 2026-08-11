const { net } = require('electron');
const { LucidLog } = require('lucid-log');

// Debounce window for rapid network change events before refreshing.
const REFRESH_DEBOUNCE_MS = 1000;
// Bound a single connectivity probe so a hung net.request / net.resolveHost
// (e.g. a stale socket left after system suspend) can't wedge refresh(): the
// isRefreshing guard would otherwise stick on forever and every later retry
// be skipped, leaving the app on "Waiting for network..." until killed.
const PROBE_TIMEOUT_MS = 5000;

let _ConnectionManager_window = new WeakMap();
let _ConnectionManager_config = new WeakMap();
let _ConnectionManager_logger = new WeakMap();
let _ConnectionManager_currentUrl = new WeakMap();
let _ConnectionManager_isRefreshing = new WeakMap();
let _ConnectionManager_refreshTimeout = new WeakMap();
let _ConnectionManager_boundDidFailLoad = new WeakMap();

class ConnectionManager {
	/**
	 * @returns {Electron.BrowserWindow}
	 */
	get window() {
		return _ConnectionManager_window.get(this);
	}

	/**
	 * @returns {*}
	 */
	get config() {
		return _ConnectionManager_config.get(this);
	}

	/**
	 * @returns {LucidLog}
	 */
	get logger() {
		return _ConnectionManager_logger.get(this);
	}

	/**
	 * @returns {string}
	 */
	get currentUrl() {
		return _ConnectionManager_currentUrl.get(this);
	}

	/**
	 * @param {string} url
	 * @param {{window:Electron.BrowserWindow,config:object}} options
	 */
	start(url, options) {
		// Drop any listeners/timers from a previously-started window so
		// re-starting doesn't stack did-fail-load handlers.
		this.cleanup();

		_ConnectionManager_window.set(this, options.window);
		_ConnectionManager_config.set(this, options.config);
		_ConnectionManager_logger.set(this, new LucidLog({
			levels: options.config.appLogLevels.split(',')
		}));
		_ConnectionManager_currentUrl.set(this, url ? url : this.config.url);
		_ConnectionManager_isRefreshing.set(this, false);
		_ConnectionManager_refreshTimeout.set(this, null);

		const boundDidFailLoad = assignOnDidFailLoadEventHandler(this);
		_ConnectionManager_boundDidFailLoad.set(this, boundDidFailLoad);
		this.window.webContents.on('did-fail-load', boundDidFailLoad);
		this.refresh();
	}

	/**
	 * Remove the did-fail-load listener and clear any pending debounce timeout.
	 * Safe to call when no window is bound yet (called at the top of start()).
	 */
	cleanup() {
		const boundDidFailLoad = _ConnectionManager_boundDidFailLoad.get(this);
		if (boundDidFailLoad && this.isWindowAvailable() && this.window.webContents) {
			this.window.webContents.removeListener('did-fail-load', boundDidFailLoad);
		}
		const timeout = _ConnectionManager_refreshTimeout.get(this);
		if (timeout) {
			clearTimeout(timeout);
			_ConnectionManager_refreshTimeout.set(this, null);
		}
	}

	isWindowAvailable() {
		return this.window && !this.window.isDestroyed();
	}

	/**
	 * Coalesce rapid failure bursts (e.g. several did-fail-load events firing
	 * back-to-back on a flapping network) into a single refresh after a short
	 * quiet period.
	 */
	debouncedRefresh() {
		const existingTimeout = _ConnectionManager_refreshTimeout.get(this);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}
		const timeout = setTimeout(() => {
			_ConnectionManager_refreshTimeout.set(this, null);
			this.refresh();
		}, REFRESH_DEBOUNCE_MS);
		_ConnectionManager_refreshTimeout.set(this, timeout);
	}

	async refresh() {
		if (!this.isWindowAvailable()) {
			this.logger.debug('Window is not available. Cannot refresh.');
			return;
		}

		// Prevent concurrent refresh operations. The guard is released in
		// finally so a hung probe (now bounded by probeWithTimeout) can't
		// leave it stuck on.
		const isRefreshing = _ConnectionManager_isRefreshing.get(this);
		if (isRefreshing) {
			this.logger.debug('Refresh already in progress, skipping...');
			return;
		}

		try {
			_ConnectionManager_isRefreshing.set(this, true);

			const currentUrl = this.window.webContents.getURL();
			const hasUrl = currentUrl && currentUrl.startsWith('https://') ? true : false;
			this.window.setTitle('Waiting for network...');
			this.logger.debug('Waiting for network...');
			const connected = await this.isOnline(1000, 1);

			// The window may have been destroyed during the async network
			// check; re-check before touching it.
			if (!this.isWindowAvailable()) {
				this.logger.debug('Window was destroyed during network check. Aborting refresh.');
				return;
			}

			const retryConnected = connected || await this.isOnline(1000, 30);
			if (!this.isWindowAvailable()) {
				this.logger.debug('Window was destroyed during network check. Aborting refresh.');
				return;
			}

			if (retryConnected) {
				if (hasUrl) {
					this.window.reload();
				} else {
					this.window.loadURL(this.currentUrl, { userAgent: this.config.chromeUserAgent });
				}
			} else {
				this.window.setTitle('No internet connection');
				this.logger.error('No internet connection');
			}
		} finally {
			_ConnectionManager_isRefreshing.set(this, false);
		}
	}

	/**
	 * @param {number} timeout
	 * @param {number} retries
	 * @returns
	 */
	async isOnline(timeout, retries) {
		const onlineCheckMethod = this.config.onlineCheckMethod;
		var resolved = false;
		for (var i = 1; i <= retries && !resolved; i++) {
			resolved = await this.isOnlineTest(onlineCheckMethod, this.config.url);
			if (!resolved) await sleep(timeout);
		}
		if (resolved) {
			this.logger.debug('Network test successful with method ' + onlineCheckMethod);
		} else {
			this.logger.debug('Network test failed with method ' + onlineCheckMethod);
		}
		return resolved;
	}

	async isOnlineTest(onlineCheckMethod, testUrl) {
		switch (onlineCheckMethod) {
		case 'none':
			// That's more an escape gate in case all methods are broken, it disables
			// the network test (assumes we're online).
			this.logger.warn('Network test is disabled, assuming online status.');
			return true;
		case 'dns': {
			// Sometimes too optimistic, might be false-positive where an HTTP proxy is
			// mandatory but not reachable yet.
			const testDomain = (new URL(testUrl)).hostname;
			this.logger.debug('Testing network using net.resolveHost() for ' + testDomain);
			return await isOnlineDns(testDomain);
		}
		case 'native':
			// Sounds good but be careful, too optimistic in my experience; and at the contrary,
			// might also be false negative where no DNS is available for internet domains, but
			// an HTTP proxy is actually available and working.
			this.logger.debug('Testing network using net.isOnline()');
			return net.isOnline();
		case 'https':
		default:
			// Perform an actual HTTPS request, similar to loading the Outlook app.
			this.logger.debug('Testing network using net.request() for ' + testUrl);
			return await isOnlineHttps(testUrl);
		}
	}
}

/**
 * did-fail-load handler. Only main-frame failures are actionable (sub-frame
 * failures are expected — blocked telemetry iframes, unreachable CDN edges);
 * debounced so a burst of failures triggers one refresh, not many.
 *
 * @param {ConnectionManager} cm
 */
function assignOnDidFailLoadEventHandler(cm) {
	return (event, code, description, validatedURL, isMainFrame) => {
		if (isMainFrame) {
			cm.logger.error(description);
			if (description === 'ERR_INTERNET_DISCONNECTED' || description === 'ERR_NETWORK_CHANGED') {
				cm.debouncedRefresh();
			}
		} else {
			cm.logger.debug(`Sub-frame failed to load: ${description} (code: ${code})`);
		}
	};
}

function sleep(timeout) {
	return new Promise(r => setTimeout(r, timeout));
}

// Bound a connectivity probe so it always settles. run(finish) performs the
// probe and calls the idempotent finish(true|false) when it resolves; finish
// also clears the timeout. If the probe hasn't settled within timeoutMs, the
// optional cleanup returned by run() runs (e.g. abort an in-flight request) and
// the probe resolves false. A synchronous throw from run() is treated as
// offline so the probe always resolves a boolean and isOnline() falls through
// rather than rejecting and wedging refresh().
function probeWithTimeout(run, timeoutMs = PROBE_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		let cleanup;
		const finish = (online) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(online);
		};
		timer = setTimeout(() => {
			try {
				cleanup && cleanup();
			} catch (e) {
				// nothing to clean up, or request already settled
			}
			finish(false);
		}, timeoutMs);
		try {
			cleanup = run(finish);
		} catch (e) {
			finish(false);
		}
	});
}

function isOnlineHttps(testUrl) {
	return probeWithTimeout((finish) => {
		var req = net.request({
			url: testUrl,
			method: 'HEAD'
		});
		req.on('response', () => {
			finish(true);
		});
		req.on('error', () => {
			finish(false);
		});
		req.end();
		// On timeout, abort the in-flight request before resolving false.
		return () => req.abort();
	});
}

function isOnlineDns(testDomain) {
	return probeWithTimeout((finish) => {
		net.resolveHost(testDomain)
			.then(() => finish(true))
			.catch(() => finish(false));
	});
}

module.exports = ConnectionManager;