#!/usr/bin/env python3
"""
`npm run lean:renames`: every lemma name Mathlib deprecated since v4.8.0 → the name to use in the
sandbox's Mathlib now, written to lib/lean/data/mathlib-renames.json (read by lib/lean/renamed.ts).

Models trained on older Mathlib keep writing removed names (`le_div_iff`, `Finset.not_mem_empty`,
`Set.mem_setOf_eq`, …); each one used to be added to RENAMED_LEMMAS by hand after a failed proof.

1. Mathlib's sources at each release tag v4.8.0 … the sandbox's version, fetched shallowly into a
   bare repository (default .data/mathlib-src.git, ~90 MB): every `@[deprecated …]` with the
   declaration after it — `alias old := new` or `theorem old` with `@[deprecated new]` — and the
   namespaces it sits in (Lean resolves the new name from the innermost namespace outwards).
2. The sandbox's own Mathlib (`lake env lean` in LEAN_SANDBOX_PATH): every constant, and every
   still-deprecated one with its target.
3. Each old name followed through the chain (old → newer → current) to a name that exists and is
   no longer deprecated. Kept: names removed from the sandbox's Mathlib (a proof using one fails
   anyway, so rewriting it never breaks anything), and still-present ones whose every step is a
   pure `alias` (same statement, same arguments). A still-present `@[deprecated new] theorem old`
   may have other arguments (`pow_lt_pow` → `pow_lt_pow_right₀`) and still works, so it is left.

Options: --repo DIR, --names FILE --deprecated FILE (a dump made earlier: skips the Lean step,
which takes minutes), --out FILE, --from MINOR (default 8).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"git {' '.join(args[:3])}: {r.stderr.strip()}")
    return r.stdout


def sandbox_version(sandbox):
    m = json.load(open(os.path.join(sandbox, "lake-manifest.json")))
    for p in m["packages"]:
        if p["name"] == "mathlib":
            return p.get("inputRev") or ""
    return ""


def fetch_tags(repo, tags):
    if not os.path.isdir(repo):
        os.makedirs(repo)
        git(repo, "init", "-q", "--bare")
        git(repo, "remote", "add", "origin", "https://github.com/leanprover-community/mathlib4")
    have = set(git(repo, "tag").split())
    missing = [t for t in tags if t not in have]
    if missing:
        print(f"fetching {len(missing)} Mathlib tags …", file=sys.stderr)
        args = []
        for t in missing:
            args += ["tag", t]
        git(repo, "fetch", "-q", "--depth", "1", "origin", *args)


ATTR = re.compile(r"@\[([^\]]*\bdeprecated\b[^\]]*)\]")
DEPNEW = re.compile(r"\bdeprecated\s+(?!\()([^\s(,\]]+)")
DECL = re.compile(
    r"^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|nonrec|partial|unsafe)\s+)*"
    r"(alias|theorem|lemma|def|abbrev|instance|structure|class|inductive)\s+([^\s:(\[{]+)(.*)$"
)
ALIAS_RHS = re.compile(r":=\s*([^\s]+)")


def deprecations(text):
    """(full old name, candidate new names innermost namespace first, is a pure alias)"""
    stack = []  # ("ns" | "sec", name)
    pending = None
    in_comment = False
    for line in text.split("\n"):
        s = line.strip()
        if in_comment:
            if "-/" in s:
                in_comment = False
            continue
        if s.startswith("/-") and "-/" not in s:
            in_comment = True
            continue
        m = re.match(r"^namespace\s+(\S+)", s)
        if m:
            stack += [("ns", part) for part in m.group(1).split(".")]
            continue
        m = re.match(r"^(?:noncomputable\s+)?section\b\s*(\S*)", s)
        if m:
            stack.append(("sec", m.group(1)))
            continue
        m = re.match(r"^end\b\s*(\S*)$", s)
        if m:
            n = len(m.group(1).split(".")) if m.group(1) else 1
            del stack[len(stack) - min(n, len(stack)):]
            continue
        a = ATTR.search(s)
        if a:
            pending = a.group(1)
            s = s[a.end():]
            if not s.strip():
                continue
        if pending is None:
            continue
        d = DECL.match(s)
        if not d:
            if s and not s.startswith("--") and not s.startswith("@["):
                pending = None
            continue
        kind, name, tail = d.groups()
        attr, pending = pending, None
        if kind in ("instance", "structure", "class", "inductive") or name.startswith("⟨"):
            continue
        ns = [n for k, n in stack if k == "ns"]
        if name.startswith("_root_."):
            full, ns = name[7:], []
        else:
            full = ".".join(ns + [name])
        new = None
        dn = DEPNEW.search(attr)
        if dn:
            new = dn.group(1)
        if kind == "alias":
            r = ALIAS_RHS.search(tail)
            if r:
                new = r.group(1)
        if not new:
            continue
        new = new.rstrip(",")
        cands = [new[7:]] if new.startswith("_root_.") else [".".join(ns[:k] + [new]) for k in range(len(ns), -1, -1)]
        yield full, cands, kind == "alias"


def extract(repo, tags):
    out = {}
    for tag in tags:
        files = [l.split(":", 1)[1] for l in git(repo, "grep", "-l", "@\\[.*deprecated", tag, "--", "*.lean", check=False).splitlines() if ":" in l]
        before = len(out)
        for f in files:
            for full, cands, alias in deprecations(git(repo, "show", f"{tag}:{f}")):
                out.setdefault(full, {"cands": cands, "alias": alias})
        print(f"{tag}: {len(out) - before} new deprecations", file=sys.stderr)
    return out


DUMP = r"""import Mathlib
open Lean in
#eval show CoreM Unit from do
  let env ← getEnv
  let mut names : Array String := #[]
  let mut dep : Array String := #[]
  for (n, _) in env.constants.toList do
    if n.isInternal then continue
    let s := n.toString
    names := names.push s
    if let some e := Lean.Linter.deprecatedAttr.getParam? env n then
      dep := dep.push (s ++ "\t" ++ (match e.newName? with | some m => m.toString | none => ""))
  IO.FS.writeFile "NAMES" (String.intercalate "\n" names.toList)
  IO.FS.writeFile "DEPRECATED" (String.intercalate "\n" dep.toList)
"""


def dump_current(sandbox, tmp):
    names, dep = os.path.join(tmp, "names.txt"), os.path.join(tmp, "deprecated.txt")
    src = os.path.join(tmp, "Dump.lean")
    open(src, "w").write(DUMP.replace("NAMES", names).replace("DEPRECATED", dep))
    print("listing the sandbox's Mathlib (a few minutes) …", file=sys.stderr)
    r = subprocess.run(["lake", "env", "lean", src], cwd=sandbox, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(names):
        raise SystemExit(f"lake env lean failed: {r.stderr.strip() or r.stdout.strip()}")
    return names, dep


def resolve_all(old, names, cur_dep):
    def resolve(name, seen):
        if name in seen:
            return None
        seen = seen | {name}
        if name in names:
            if name in cur_dep:
                return resolve(cur_dep[name], seen) if cur_dep[name] else None
            return (name, True)
        e = old.get(name)
        if not e:
            return None
        for c in e["cands"]:
            r = resolve(c, seen)
            if r:
                return (r[0], r[1] and e["alias"])
        return None

    table, stats = {}, {"removed": 0, "deprecated_alias": 0, "skipped": 0}
    for o, e in old.items():
        present = o in names
        if present and o not in cur_dep:
            stats["skipped"] += 1
            continue
        r = next((r for r in (resolve(c, {o}) for c in e["cands"]) if r), None)
        if not r or r[0] == o:
            stats["skipped"] += 1
            continue
        # a short plain word (`lo`, `wf`) is more often a variable in a proof than the old lemma
        if "." not in o and "_" not in o and len(o) <= 3:
            stats["skipped"] += 1
            continue
        alias = r[1] and e["alias"]
        if present and not alias:
            stats["skipped"] += 1
            continue
        table[o] = r[0]
        stats["deprecated_alias" if present else "removed"] += 1
    return table, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.path.join(ROOT, ".data", "mathlib-src.git"))
    ap.add_argument("--sandbox", default=os.environ.get("LEAN_SANDBOX_PATH", os.path.join(ROOT, "lean-sandbox")))
    ap.add_argument("--names")
    ap.add_argument("--deprecated")
    ap.add_argument("--from", dest="start", type=int, default=8)
    ap.add_argument("--out", default=os.path.join(ROOT, "lib", "lean", "data", "mathlib-renames.json"))
    a = ap.parse_args()

    version = sandbox_version(a.sandbox) or "v4.33.1"
    m = re.match(r"v4\.(\d+)\.(\d+)", version)
    if not m:
        raise SystemExit(f"unexpected Mathlib version {version!r} in the sandbox's lake-manifest.json")
    minor = int(m.group(1))
    tags = [f"v4.{i}.0" for i in range(a.start, minor + 1)]
    if version not in tags:
        tags.append(version)
    fetch_tags(a.repo, tags)
    old = extract(a.repo, tags)

    with tempfile.TemporaryDirectory() as tmp:
        if a.names and a.deprecated:
            names_f, dep_f = a.names, a.deprecated
        else:
            names_f, dep_f = dump_current(os.path.abspath(a.sandbox), tmp)
        names = set(open(names_f).read().split("\n"))
        cur_dep = {}
        for l in open(dep_f).read().split("\n"):
            if "\t" in l:
                k, v = l.split("\t", 1)
                cur_dep[k] = v

    table, stats = resolve_all(old, names, cur_dep)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump({"mathlib": version, "from": tags[0], "renames": dict(sorted(table.items()))}, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print(json.dumps({"mathlib": version, "deprecations_seen": len(old), **stats, "written": len(table), "out": os.path.relpath(a.out, ROOT)}), file=sys.stderr)


if __name__ == "__main__":
    main()
