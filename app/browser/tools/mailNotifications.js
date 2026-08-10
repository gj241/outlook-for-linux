/**
 * Watches `document.title` for Outlook Web's leading `(N)` unread count and
 * reports it to the main process.
 *
 * - On any count change → `set-badge-count` (drives the app/dock badge per
 *   account).
 * - On an increase (new mail arrived) → `new-mail` (main process shows a native
 *   desktop notification + plays the sound), but only when
 *   `config.notifyOnNewMail` is on and `config.disableNotifications` is off.
 *   This avoids duplicating OWA's own in-page notifications when the user has
 *   those enabled.
 *
 * Outlook Web renders the unread total as a leading `(N)` in the document
 * title, e.g. `(3) Inbox - user@example.com`. When there is no unread mail the
 * prefix is absent. We poll the title because OWA is an SPA that updates it in
 * place (no full navigation), and there is no stable DOM hook for the count.
 */

let _MailNotifications_config = new WeakMap();
let _MailNotifications_ipc = new WeakMap();
let _MailNotifications_initialized = new WeakMap();
let _MailNotifications_lastCount = new WeakMap();

class MailNotifications {
	constructor() {
		_MailNotifications_initialized.set(this, false);
		_MailNotifications_lastCount.set(this, 0);
	}

	/**
	 * @param {object} config
	 * @param {Electron.IpcRenderer} ipc
	 */
	init(config, ipc) {
		if (this.initialized) {
			return;
		}
		_MailNotifications_config.set(this, config);
		_MailNotifications_ipc.set(this, ipc);
		_MailNotifications_initialized.set(this, true);

		startPolling(this);
	}

	get config() {
		return _MailNotifications_config.get(this);
	}

	get ipc() {
		return _MailNotifications_ipc.get(this);
	}

	get initialized() {
		return _MailNotifications_initialized.get(this);
	}

	get lastCount() {
		return _MailNotifications_lastCount.get(this);
	}

	set lastCount(value) {
		_MailNotifications_lastCount.set(this, value);
	}
}

const mailNotifications = new MailNotifications();

/**
 * Polling interval in milliseconds. OWA updates the title within a second or
 * two of mail arriving; 2s is responsive without being busy.
 */
const POLL_INTERVAL = 2000;

/**
 * @param {MailNotifications} self
 */
function startPolling(self) {
	const tick = () => {
		try {
			checkTitle(self);
		} catch (e) {
			// ignore — keep polling
		}
	};
	// Run once shortly after load (the title may not be set immediately on
	// first paint), then on the interval.
	setTimeout(tick, 3000);
	setInterval(tick, POLL_INTERVAL);
}

/**
 * @param {MailNotifications} self
 */
function checkTitle(self) {
	const count = parseUnreadCount(document.title);
	const previous = self.lastCount;
	if (count === previous) {
		return;
	}
	self.lastCount = count;

	// Always update the badge for this account.
	self.ipc.invoke('set-badge-count', count);

	// Notify only on an increase (new mail) and only if enabled.
	const notifyEnabled = self.config.notifyOnNewMail && !self.config.disableNotifications;
	if (notifyEnabled && count > previous) {
		self.ipc.send('new-mail', { count, delta: count - previous });
	}
}

/**
 * Extract the leading `(N)` unread count from an Outlook Web title. Returns 0
 * when there is no leading parenthesised number.
 *
 * @param {string} title
 * @returns {number}
 */
function parseUnreadCount(title) {
	if (!title) {
		return 0;
	}
	const match = title.match(/^\s*\((\d+)\)/);
	if (!match) {
		return 0;
	}
	const value = parseInt(match[1], 10);
	return Number.isNaN(value) ? 0 : value;
}

exports = module.exports = mailNotifications;