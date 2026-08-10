const { webFrame } = require('electron');

const ROOT_ID = 'o4l-switcher';
const POSITION_KEY = '__outlook4linux_switcher_pos_v2';

let _AccountSwitcher_config = new WeakMap();
let _AccountSwitcher_ipc = new WeakMap();
let _AccountSwitcher_initialized = new WeakMap();
let _AccountSwitcher_state = new WeakMap();

class AccountSwitcher {
	constructor() {
		_AccountSwitcher_initialized.set(this, false);
	}

	/**
	 * @param {object} config
	 * @param {Electron.IpcRenderer} ipc
	 */
	init(config, ipc) {
		if (this.initialized) {
			return;
		}
		_AccountSwitcher_config.set(this, config);
		_AccountSwitcher_ipc.set(this, ipc);
		_AccountSwitcher_initialized.set(this, true);
		_AccountSwitcher_state.set(this, { accounts: [], activeId: null });

		injectStyles();
		whenBodyReady(() => mount(this));
		ipc.on('accounts:updated', onAccountsUpdated(this));
		ipc.invoke('accounts:get').then(state => applyState(this, state));
	}

	get config() {
		return _AccountSwitcher_config.get(this);
	}

	get ipc() {
		return _AccountSwitcher_ipc.get(this);
	}

	get initialized() {
		return _AccountSwitcher_initialized.get(this);
	}

	get state() {
		return _AccountSwitcher_state.get(this);
	}
}

const switcher = new AccountSwitcher();

/**
 * Build the switcher with DOM APIs (createElement/textContent) rather than
 * innerHTML, because Outlook's page enforces Trusted Types and rejects
 * innerHTML assignments.
 *
 * @param {AccountSwitcher} self
 */
function mount(self) {
	if (document.getElementById(ROOT_ID)) {
		return;
	}
	const root = document.createElement('div');
	root.id = ROOT_ID;

	const pill = document.createElement('div');
	pill.className = 'o4l-pill';
	pill.title = 'Switch account';

	const initial = document.createElement('span');
	initial.className = 'o4l-initial';
	initial.textContent = '…';

	const chevron = document.createElement('span');
	chevron.className = 'o4l-chevron';
	chevron.textContent = '▾';

	pill.appendChild(initial);
	pill.appendChild(chevron);

	const dropdown = document.createElement('div');
	dropdown.className = 'o4l-dropdown';
	dropdown.setAttribute('hidden', '');

	root.appendChild(pill);
	root.appendChild(dropdown);
	document.body.appendChild(root);

	applyPosition(root);
	attachDrag(self, root);

	pill.addEventListener('click', (event) => {
		event.stopPropagation();
		toggleDropdown(self, root);
	});
	document.addEventListener('click', (event) => {
		if (!root.contains(event.target)) {
			closeDropdown(self, root);
		}
	});

	renderDropdown(self, root);
	watchForRemoval(self);
}

/**
 * Re-inject if Outlook's SPA removes our node.
 */
function watchForRemoval(self) {
	const observer = new MutationObserver(() => {
		if (!document.getElementById(ROOT_ID) && document.body) {
			mount(self);
		}
	});
	observer.observe(document.body, { childList: true });
}

/**
 * @param {AccountSwitcher} self
 * @param {HTMLElement} root
 */
function toggleDropdown(self, root) {
	const dropdown = root.querySelector('.o4l-dropdown');
	if (!dropdown) {
		return;
	}
	if (dropdown.hasAttribute('hidden')) {
		renderDropdown(self, root);
		dropdown.removeAttribute('hidden');
	} else {
		dropdown.setAttribute('hidden', '');
	}
}

/**
 * @param {AccountSwitcher} self
 * @param {HTMLElement} root
 */
function closeDropdown(self, root) {
	const dropdown = root.querySelector('.o4l-dropdown');
	if (dropdown) {
		dropdown.setAttribute('hidden', '');
	}
}

/**
 * @param {AccountSwitcher} self
 * @param {HTMLElement} root
 */
function renderDropdown(self, root) {
	const dropdown = root.querySelector('.o4l-dropdown');
	if (!dropdown) {
		return;
	}
	while (dropdown.firstChild) {
		dropdown.removeChild(dropdown.firstChild);
	}
	const { accounts, activeId } = self.state;

	accounts.forEach(account => {
		const item = document.createElement('div');
		item.className = 'o4l-item' + (account.id === activeId ? ' active' : '');
		item.dataset.id = account.id;

		const ini = document.createElement('span');
		ini.className = 'o4l-item-initial';
		ini.textContent = initialOf(account.name);

		const name = document.createElement('span');
		name.className = 'o4l-item-name';
		name.textContent = account.name;

		item.appendChild(ini);
		item.appendChild(name);

		if (accounts.length > 1) {
			const rm = document.createElement('span');
			rm.className = 'o4l-remove';
			rm.textContent = '✕';
			rm.title = 'Remove';
			rm.dataset.remove = account.id;
			rm.addEventListener('click', (event) => {
				event.stopPropagation();
				self.ipc.send('accounts:remove', account.id);
			});
			item.appendChild(rm);
		}

		const rename = document.createElement('span');
		rename.className = 'o4l-rename';
		rename.textContent = '✎';
		rename.title = 'Rename';
		rename.addEventListener('click', (event) => {
			event.stopPropagation();
			startInlineRename(self, item, account, name);
		});
		item.appendChild(rename);

		item.addEventListener('click', (event) => {
			if (event.target.classList.contains('o4l-remove') ||
				event.target.classList.contains('o4l-rename') ||
				event.target.classList.contains('o4l-rename-input')) {
				return;
			}
			self.ipc.send('accounts:switch', account.id);
			closeDropdown(self, root);
		});

		dropdown.appendChild(item);
	});

	const add = document.createElement('div');
	add.className = 'o4l-item add';
	const addName = document.createElement('span');
	addName.className = 'o4l-item-name';
	addName.textContent = '＋ Add account…';
	add.appendChild(addName);
	add.addEventListener('click', () => {
		self.ipc.send('accounts:add');
		closeDropdown(self, root);
	});
	dropdown.appendChild(add);

	const initialEl = root.querySelector('.o4l-initial');
	const active = accounts.find(a => a.id === activeId);
	if (initialEl) {
		initialEl.textContent = active ? initialOf(active.name) : '…';
	}
}

/**
 * Replace the account's name label with a text input so the user can rename
 * inline. We can't use window.prompt() — Electron doesn't implement it, so it
 * returns null and nothing happens. Commit on Enter/blur, cancel on Escape.
 *
 * @param {AccountSwitcher} self
 * @param {HTMLElement} item
 * @param {{id: string, name: string}} account
 * @param {HTMLElement} nameSpan
 */
function startInlineRename(self, item, account, nameSpan) {
	if (item.querySelector('.o4l-rename-input')) {
		return;
	}
	const input = document.createElement('input');
	input.className = 'o4l-rename-input';
	input.type = 'text';
	input.value = account.name;
	input.setAttribute('aria-label', 'Rename account');
	nameSpan.replaceWith(input);
	input.focus();
	input.select();

	// Swallow clicks so the item's switch handler doesn't fire while editing.
	input.addEventListener('click', event => event.stopPropagation());
	input.addEventListener('mousedown', event => event.stopPropagation());

	const finish = commit => {
		if (!input.parentNode) {
			return; // dropdown was re-rendered out from under us
		}
		const value = input.value.trim();
		const span = document.createElement('span');
		span.className = 'o4l-item-name';
		span.textContent = value || account.name;
		input.replaceWith(span);
		if (commit && value && value !== account.name) {
			self.ipc.send('accounts:rename', { id: account.id, name: value });
		}
	};

	input.addEventListener('keydown', event => {
		if (event.key === 'Enter') {
			event.preventDefault();
			finish(true);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			finish(false);
		}
	});
	input.addEventListener('blur', () => finish(true));
}

/**
 * @param {AccountSwitcher} self
 * @param {HTMLElement} root
 */
function attachDrag(self, root) {
	const pill = root.querySelector('.o4l-pill');
	let dragging = false;
	let startX = 0;
	let startY = 0;
	let startLeft = 0;
	let startTop = 0;

	pill.addEventListener('mousedown', (event) => {
		dragging = true;
		startX = event.clientX;
		startY = event.clientY;
		const rect = root.getBoundingClientRect();
		startLeft = rect.left;
		startTop = rect.top;
		event.preventDefault();
	});

	document.addEventListener('mousemove', (event) => {
		if (!dragging) {
			return;
		}
		let left = startLeft + (event.clientX - startX);
		let top = startTop + (event.clientY - startY);
		left = clamp(left, 0, window.innerWidth - root.offsetWidth);
		top = clamp(top, 0, window.innerHeight - root.offsetHeight);
		root.style.left = left + 'px';
		root.style.top = top + 'px';
		root.style.right = 'auto';
	});

	document.addEventListener('mouseup', () => {
		if (!dragging) {
			return;
		}
		dragging = false;
		savePosition(root);
	});
}

function applyPosition(root) {
	let pos = null;
	try {
		pos = JSON.parse(localStorage.getItem(POSITION_KEY));
	} catch (e) {
		pos = null;
	}
	if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
		root.style.left = clamp(pos.left, 0, window.innerWidth - root.offsetWidth) + 'px';
		root.style.top = clamp(pos.top, 0, window.innerHeight - root.offsetHeight) + 'px';
		root.style.right = 'auto';
	} else {
		// Default to just below Outlook's top bar so we don't cover the
		// gear / notifications / account controls in the top-right corner.
		root.style.right = '8px';
		root.style.top = '50px';
	}
}

function savePosition(root) {
	const rect = root.getBoundingClientRect();
	localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
}

function clamp(value, min, max) {
	if (max < min) {
		return min;
	}
	return Math.max(min, Math.min(max, value));
}

function initialOf(name) {
	return (name && name.trim()[0] || '?').toUpperCase();
}

/**
 * @param {AccountSwitcher} self
 */
function onAccountsUpdated(self) {
	return (event, payload) => {
		try {
			applyState(self, JSON.parse(payload));
		} catch (e) {
			// ignore malformed payloads
		}
	};
}

/**
 * @param {AccountSwitcher} self
 * @param {{accounts: Array, activeId: string}} state
 */
function applyState(self, state) {
	if (!state) {
		return;
	}
	_AccountSwitcher_state.set(self, {
		accounts: state.accounts || [],
		activeId: state.activeId || null
	});
	const root = document.getElementById(ROOT_ID);
	if (root) {
		renderDropdown(self, root);
	}
}

function whenBodyReady(callback) {
	if (document.body) {
		callback();
	} else {
		document.addEventListener('DOMContentLoaded', () => callback(), { once: true });
	}
}

function injectStyles() {
	const css = `
#${ROOT_ID} {
	position: fixed;
	z-index: 2147483647;
	top: 50px;
	right: 8px;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
	font-size: 12px;
	color: #fff;
	--o4l-bg: rgba(23,23,30,0.62);
	--o4l-bg-hover: rgba(23,23,30,0.82);
	--o4l-accent: #0f6cbd;
	--o4l-accent-soft: rgba(15,108,189,0.35);
}
#${ROOT_ID} .o4l-pill {
	display: flex;
	align-items: center;
	gap: 5px;
	background: var(--o4l-bg);
	-webkit-backdrop-filter: blur(6px);
	backdrop-filter: blur(6px);
	border-radius: 16px;
	padding: 3px 9px 3px 4px;
	cursor: move;
	user-select: none;
	box-shadow: 0 2px 6px rgba(0,0,0,0.3);
	line-height: 1;
}
#${ROOT_ID} .o4l-initial {
	font-weight: 600;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--o4l-accent);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 11px;
}
#${ROOT_ID} .o4l-chevron {
	opacity: 0.65;
	font-size: 9px;
}
#${ROOT_ID} .o4l-dropdown {
	margin-top: 4px;
	min-width: 168px;
	background: var(--o4l-bg);
	-webkit-backdrop-filter: blur(6px);
	backdrop-filter: blur(6px);
	border-radius: 8px;
	box-shadow: 0 4px 14px rgba(0,0,0,0.38);
	overflow: hidden;
}
#${ROOT_ID} .o4l-dropdown[hidden] {
	display: none;
}
#${ROOT_ID} .o4l-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 7px 10px;
	cursor: pointer;
}
#${ROOT_ID} .o4l-item:hover {
	background: var(--o4l-bg-hover);
}
#${ROOT_ID} .o4l-item.active {
	background: var(--o4l-accent-soft);
}
#${ROOT_ID} .o4l-item .o4l-item-initial {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--o4l-accent);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 11px;
	font-weight: 600;
	flex: 0 0 auto;
}
#${ROOT_ID} .o4l-item .o4l-item-name {
	flex: 1 1 auto;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
#${ROOT_ID} .o4l-item .o4l-remove,
#${ROOT_ID} .o4l-item .o4l-rename {
	flex: 0 0 auto;
	opacity: 0.5;
	padding: 0 4px;
	border-radius: 4px;
}
#${ROOT_ID} .o4l-item .o4l-remove:hover {
	opacity: 1;
	background: rgba(220,60,60,0.4);
}
#${ROOT_ID} .o4l-item .o4l-rename:hover {
	opacity: 1;
	background: rgba(255,255,255,0.18);
}
#${ROOT_ID} .o4l-item .o4l-rename-input {
	flex: 1 1 auto;
	min-width: 0;
	font: inherit;
	color: #fff;
	background: rgba(0,0,0,0.35);
	border: 1px solid var(--o4l-accent);
	border-radius: 4px;
	padding: 2px 4px;
	outline: none;
}
#${ROOT_ID} .o4l-item .o4l-rename-input:focus {
	border-color: #fff;
}
#${ROOT_ID} .o4l-item.add {
	color: #cfe2f2;
	border-top: 1px solid rgba(255,255,255,0.12);
}
`;
	webFrame.insertCSS(css);
}

exports = module.exports = switcher;