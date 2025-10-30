const BASE_URL = 'https://www.call2all.co.il/ym/api';

async function httpGet(pathWithQuery) {
	const res = await fetch(`${BASE_URL}/${pathWithQuery}`);
	return res.json();
}

async function httpPostJson(path, body) {
	const res = await fetch(`${BASE_URL}/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	return res.json();
}

export async function login(username, password) {
	// Login returns { token }
	return httpGet(`Login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`);
}

export async function getSession(token) {
	return httpGet(`GetSession?token=${encodeURIComponent(token)}`);
}

export async function getIncomingSms(token, limit) {
	return httpGet(`GetIncomingSms?token=${encodeURIComponent(token)}&limit=${encodeURIComponent(limit)}`);
}

export async function getSmsOutLog(token, limit) {
	return httpGet(`GetSmsOutLog?token=${encodeURIComponent(token)}&limit=${encodeURIComponent(limit)}`);
}

export async function getTextFile(token, what) {
	return httpGet(`GetTextFile?token=${encodeURIComponent(token)}&what=${encodeURIComponent(what)}`);
}

export async function uploadTextFile(token, what, contents) {
	return httpPostJson('UploadTextFile', { token, what, contents: typeof contents === 'string' ? contents : JSON.stringify(contents) });
}

export async function sendSms(token, params) {
	// params: phones, message, CallerId (optional)
	const query = new URLSearchParams(params).toString();
	return httpGet(`SendSms?token=${encodeURIComponent(token)}&${query}`);
}

// MFA
export async function mfaIsPass(token) {
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=isPass`);
}

export async function mfaTry(token) {
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=try`);
}

export async function mfaGetMethods(token) {
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=getMFAMethods`);
}

export async function mfaSend(token, { mfaId, mfaSendType, lang = 'HE', autoOtpHostname }) {
	const query = new URLSearchParams({ mfaId, mfaSendType, lang, ...(autoOtpHostname ? { autoOtpHostname } : {}) }).toString();
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=sendMFA&${query}`);
}

export async function mfaValidate(token, { mfaCode, mfaRememberMe = false, mfaRememberNote = '' }) {
	const query = new URLSearchParams({ mfaCode, mfaRememberMe: mfaRememberMe ? 1 : 0, mfaRememberNote }).toString();
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=validMFA&${query}`);
}

// Generic MFASession action helper to cover all current/future actions
export async function mfaAction(token, action, params = {}) {
	const query = new URLSearchParams(
		Object.entries(params).reduce((acc, [k, v]) => {
			if (v !== undefined && v !== null) acc[k] = String(v);
			return acc;
		}, {})
	).toString();
	const suffix = query ? `&${query}` : '';
	return httpGet(`MFASession?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}${suffix}`);
}

export function getStoredToken() {
	return localStorage.getItem('apiToken') || '';
}

export function setStoredToken(token) {
	localStorage.setItem('apiToken', token);
}

export function clearStoredToken() {
	localStorage.removeItem('apiToken');
}


