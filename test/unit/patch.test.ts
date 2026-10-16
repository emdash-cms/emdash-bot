import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_PRIVILEGED_PREFIXES,
	PatchRejected,
	parsePatch,
	validatePatch,
} from "../../src/source/patch.ts";

const policy = { maxBytes: 1_000_000, privilegedPrefixes: DEFAULT_PRIVILEGED_PREFIXES };
const enc = (s: string) => new TextEncoder().encode(s);

const modify = `diff --git a/src/a.ts b/src/a.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;

describe("checkpoint patch validation", () => {
	it("parses added, deleted, modified and binary files", () => {
		const patch = `${modify}diff --git a/new.txt b/new.txt
new file mode 100755
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+x
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444444444444444444444444444444444444..0000000000000000000000000000000000000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-y
diff --git a/img.png b/img.png
new file mode 100644
index 0000000000000000000000000000000000000000..5555555555555555555555555555555555555555
GIT binary patch
literal 3
Kcmb=Bh5!Hn3jhHE

literal 0
HcmV?d00001

`;
		expect(parsePatch(patch)).toEqual([
			{ path: "src/a.ts", change: "modified", mode: "100644", binary: false },
			{ path: "new.txt", change: "added", mode: "100755", binary: false },
			{ path: "old.txt", change: "deleted", mode: undefined, binary: false },
			{ path: "img.png", change: "added", mode: "100644", binary: true },
		]);
	});

	it("rejects workflow changes, git metadata, traversal and escaping symlinks", () => {
		const bad = (path: string) => modify.replaceAll("src/a.ts", path);
		expect(() => validatePatch(enc(bad(".github/workflows/ci.yml")), policy)).toThrow(/privileged/);
		expect(() => validatePatch(enc(bad(".git/config")), policy)).toThrow(PatchRejected);
		expect(() => validatePatch(enc(bad("a/../../etc/passwd")), policy)).toThrow(/non-canonical/);
		const link = `diff --git a/link b/link
new file mode 120000
index 0000000000000000000000000000000000000000..6666666666666666666666666666666666666666
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+../../outside
\\ No newline at end of file
`;
		expect(() => validatePatch(enc(link), policy)).toThrow(/symlink/);
		expect(() =>
			validatePatch(enc(link.replace("../../outside", "docs/readme.md")), policy),
		).not.toThrow();
	});

	it("rejects submodules, oversized artifacts and non-binary captures", () => {
		expect(() => validatePatch(enc(modify.replace("100644", "160000")), policy)).toThrow(/mode/);
		expect(() => validatePatch(enc(modify), { ...policy, maxBytes: 10 })).toThrow(/limit/);
		expect(() =>
			validatePatch(enc("diff --git a/x b/x\nBinary files a/x and b/x differ\n"), policy),
		).toThrow(/--binary/);
	});
});
