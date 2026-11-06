#!/usr/bin/env python3
"""Privacy guard: files headed for this public repo must carry no credentials, contact details,
private addresses, home paths or CJK text (the repo is English-only).

Usage: guard.py <file...>   scan the given files
       guard.py --staged    scan the git index (the pre-commit hook)
Exits 1 on any hit. A line containing guard:allow is skipped (test fixtures).

Extra rules, one regex per line ('#' lines ignored), come from .git/info/guard-patterns when it exists.
It sits inside .git, so patterns naming what must stay private are never committed themselves.
"""
import re
import subprocess
import sys

RULES = [
    ("credential", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("credential", r"\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abprs]-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[\w-]{30,})"),
    ("credential", r"\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}"),
    ("credential", r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{20,}"),
    ("credential", r"(?i)\b(api[_-]?key|access[_-]?token|token|secret|password|passwd)\s*[:=]\s*['\"]?[^\s'\"<>]{8,}"),
    ("credential", r"(?i)[?&](token|sig|signature|x-amz-signature|access_token)=[^&\s]{8,}"),
    ("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("private IP", r"\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b"),
    ("home path", r"/(Users|home)/[^/\s'\"`]+/"),
    # Ideographs, kana, Hangul, CJK punctuation and full-width forms; source that must match them uses \u escapes
    ("CJK", "[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]"),
]


def local_rules():
    # Asked of git, not hard-coded: a run from a subdirectory or a worktree must not silently skip the private rules
    path = subprocess.run(["git", "rev-parse", "--git-path", "info/guard-patterns"], capture_output=True, text=True).stdout.strip()
    try:
        lines = open(path or ".git/info/guard-patterns", encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        return []
    return [("local", line) for line in lines if line.strip() and not line.lstrip().startswith("#")]


def scan(name, text, compiled):
    hits = []
    for no, line in enumerate(text.splitlines(), 1):
        if "guard:allow" in line:
            continue
        for kind, rx in compiled:
            m = rx.search(line)
            if m:
                # Print only the start of the match: the point is to not echo a secret in full
                hits.append(f"{name}:{no} [{kind}] {m.group(0)[:12]}…")
    return hits


def main(argv):
    compiled = [(k, re.compile(p)) for k, p in RULES + local_rules()]
    if argv[:1] == ["--staged"]:
        names = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"],
                               capture_output=True, text=True, check=True).stdout.split("\0")
        read = lambda n: subprocess.run(["git", "show", f":{n}"], capture_output=True).stdout
    else:
        names = argv
        read = lambda n: open(n, "rb").read()
    hits = []
    for n in filter(None, names):
        data = read(n)
        if b"\0" in data[:4096]:
            continue
        hits += scan(n, data.decode("utf-8", "replace"), compiled)
    for h in hits:
        print(h, file=sys.stderr)
    if hits:
        print(f"\nPrivacy guard: {len(hits)} hit(s). Remove them, or mark a test fixture line with guard:allow.", file=sys.stderr)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
