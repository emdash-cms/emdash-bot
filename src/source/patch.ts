// Validation of checkpoint artifacts before they are stored or materialized.
// An artifact is `git diff --binary --cached --no-renames <base>`, so every
// file section starts with `diff --git` and carries explicit mode lines.

export interface PatchFile {
	readonly path: string;
	readonly change: "added" | "deleted" | "modified";
	/** Mode after the change; undefined for deletions. */
	readonly mode: string | undefined;
	readonly binary: boolean;
	/** Target of a symlink the patch creates or changes. */
	readonly symlinkTarget?: string;
}

export interface PatchPolicy {
	readonly maxBytes: number;
	/** Path prefixes that ordinary issue repair may not change. */
	readonly privilegedPrefixes: readonly string[];
}

export const DEFAULT_PRIVILEGED_PREFIXES = [".github/workflows/", ".github/actions/"];

const ALLOWED_MODES = new Set(["100644", "100755", "120000"]);
const DIFF_HEADER = /^diff --git (.+)$/;

export class PatchRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchRejected";
	}
}

function unquote(path: string): string {
	if (!path.startsWith('"')) return path;
	// Git C-quotes unusual paths. Decode the common escapes; octal escapes
	// encode UTF-8 bytes.
	const body = path.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (ch !== "\\") {
			bytes.push(...new TextEncoder().encode(ch));
			continue;
		}
		const next = body[++i]!;
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
			i += 2;
		} else {
			bytes.push(
				({ n: 10, t: 9, '"': 34, "\\": 92 } as Record<string, number>)[next] ?? next.charCodeAt(0),
			);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
	const value = unquote(path);
	return value.startsWith(prefix) ? value.slice(2) : value;
}

export function validatePath(path: string): void {
	if (path === "" || path.includes("\0"))
		throw new PatchRejected(`invalid path ${JSON.stringify(path)}`);
	if (path.startsWith("/")) throw new PatchRejected(`absolute path ${path}`);
	const segments = path.split("/");
	if (segments.some((s) => s === ".." || s === "." || s === "")) {
		throw new PatchRejected(`non-canonical path ${path}`);
	}
	if (segments[0] === ".git" || segments.includes(".git"))
		throw new PatchRejected(`git metadata path ${path}`);
}

function symlinkStaysInside(linkPath: string, target: string): boolean {
	if (target.startsWith("/") || target.includes("\0")) return false;
	const parts = linkPath.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return false;
			parts.pop();
		} else parts.push(segment);
	}
	return parts[0] !== ".git";
}

/** Parse the file sections of a binary git patch. */
export function parsePatch(patch: string): PatchFile[] {
	const files: PatchFile[] = [];
	const lines = patch.split("\n");
	let i = 0;
	while (i < lines.length) {
		const header = DIFF_HEADER.exec(lines[i]!);
		if (!header) {
			i++;
			continue;
		}
		let oldPath: string | undefined;
		let newPath: string | undefined;
		let change: PatchFile["change"] = "modified";
		let mode: string | undefined;
		let binary = false;
		let symlinkTarget: string | undefined;
		let inHunk = false;
		i++;
		for (; i < lines.length && !DIFF_HEADER.test(lines[i]!); i++) {
			const line = lines[i]!;
			if (inHunk) {
				if (mode === "120000" && line.startsWith("+") && symlinkTarget === undefined) {
					symlinkTarget = line.slice(1);
				}
				continue;
			}
			if (line.startsWith("new file mode ")) {
				change = "added";
				mode = line.slice(14).trim();
			} else if (line.startsWith("deleted file mode ")) {
				change = "deleted";
			} else if (line.startsWith("new mode ")) {
				mode = line.slice(9).trim();
			} else if (line.startsWith("index ")) {
				const parts = line.split(" ");
				if (parts[2]) mode ??= parts[2];
			} else if (line.startsWith("--- ")) {
				const value = line.slice(4);
				if (value !== "/dev/null") oldPath = stripPrefix(value, "a/");
			} else if (line.startsWith("+++ ")) {
				const value = line.slice(4);
				if (value !== "/dev/null") newPath = stripPrefix(value, "b/");
			} else if (line === "GIT binary patch") {
				binary = true;
				inHunk = true;
			} else if (line.startsWith("Binary files ")) {
				throw new PatchRejected("patch lacks binary content; capture must use --binary");
			} else if (line.startsWith("@@")) {
				inHunk = true;
			} else if (line.startsWith("rename ") || line.startsWith("copy ")) {
				throw new PatchRejected("rename sections are not accepted; capture uses --no-renames");
			}
		}
		// Binary and mode-only sections have no ---/+++ lines; use the header.
		if (!oldPath && !newPath) {
			const raw = header[1]!;
			const split = raw.startsWith('"') ? raw.indexOf('" ', 1) + 1 : raw.indexOf(" b/");
			newPath = stripPrefix(raw.slice(split + 1).trim(), "b/");
			oldPath = stripPrefix(raw.slice(0, split).trim(), "a/");
		}
		const path = change === "deleted" ? oldPath! : (newPath ?? oldPath!);
		files.push({
			path,
			change,
			mode: change === "deleted" ? undefined : mode,
			binary,
			...(symlinkTarget === undefined ? {} : { symlinkTarget }),
		});
	}
	return files;
}

export function validatePatch(patch: Uint8Array, policy: PatchPolicy): PatchFile[] {
	if (patch.byteLength > policy.maxBytes) {
		throw new PatchRejected(`artifact is ${patch.byteLength} bytes; limit is ${policy.maxBytes}`);
	}
	const files = parsePatch(new TextDecoder().decode(patch));
	for (const file of files) {
		validatePath(file.path);
		if (file.mode !== undefined && !ALLOWED_MODES.has(file.mode)) {
			throw new PatchRejected(`unsupported file mode ${file.mode} for ${file.path}`);
		}
		if (file.mode === "120000" && !symlinkStaysInside(file.path, file.symlinkTarget ?? "")) {
			throw new PatchRejected(`symlink ${file.path} points outside the checkout`);
		}
		const privileged = policy.privilegedPrefixes.find((prefix) => file.path.startsWith(prefix));
		if (privileged) {
			throw new PatchRejected(
				`${file.path} is a privileged path; workflow changes need a separately authorised maintenance task`,
			);
		}
	}
	return files;
}
