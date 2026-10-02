#!/usr/bin/env python3
"""manifest.py -- tests/fixtures/manifest.json playback and verification.

Used by build.sh (never directly in CI); Python 3.6+, standard library only.

manifest.py snapshot --git GIT DIR JSON of a generated fixture
  manifest.py check    --git GIT --manifest M --name N DIR    compare DIR au manifeste (code 1 si divergence)
manifest.py update --git GIT --manifest M --name N DIR writes the snapshot of DIR in the manifest

DIR is <output>/<name>/:each sous-dossier that is a restitory git (repo, origin.git, other, lib.git...) is described.

For each repository: "head" (refs/heads/x, or "detached:<oid>"), "refs" (name -> OID, refs/stash excluded) and "stash"
(message + tree of each input: the OID of a commit stash depends on the git version).
"""
import argparse
import json
import os
import subprocess
import sys

VERSION = 1


def git(git_bin, repo, *args, check=True):
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("GIT_") and k not in ("GIT_EXEC_PATH",):
            del env[k]
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "LC_ALL": "C", "TZ": "UTC"})
    p = subprocess.run([git_bin, "-C", repo] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if check and p.returncode != 0:
        sys.exit("git %s failed in %s: %s" % (" ".join(args), repo, p.stderr.decode("utf-8", "replace").strip()))
    return p.returncode, p.stdout.decode("utf-8", "replace")


def is_repo(path):
    return os.path.isdir(path) and (
        os.path.exists(os.path.join(path, ".git"))
        or (os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects")))
    )


def snapshot_repo(git_bin, path):
    refs = {}
    _, out = git(git_bin, path, "for-each-ref", "--format=%(refname)%00%(objectname)")
    for line in out.splitlines():
        name, oid = line.split("\0")
        if name != "refs/stash":
            refs[name] = oid
    rc, sym = git(git_bin, path, "symbolic-ref", "-q", "HEAD", check=False)
    if rc == 0:
        head = sym.strip()
    else:
        _, oid = git(git_bin, path, "rev-parse", "HEAD")
        head = "detached:" + oid.strip()
    stash = []
    rc, _ = git(git_bin, path, "rev-parse", "-q", "--verify", "refs/stash", check=False)
    if rc == 0:
        _, out = git(git_bin, path, "log", "-g", "--format=%gs%x00%T", "refs/stash")
        for line in out.splitlines():
            msg, tree = line.split("\0")
            stash.append({"message": msg, "tree": tree})
    return {"head": head, "refs": refs, "stash": stash}


def snapshot(git_bin, fixture_dir):
    repos = {}
    for entry in sorted(os.listdir(fixture_dir)):
        path = os.path.join(fixture_dir, entry)
        if is_repo(path):
            repos[entry] = snapshot_repo(git_bin, path)
    return repos


def diff(name, expected, actual):
    """List of messages (empty if identical). The main repository ("repo") is not prefixed."""
    problems = []
    for repo in sorted(set(expected) | set(actual)):
        prefix = "" if repo == "repo" else repo + " "
        if repo not in actual:
            problems.append("fixture %s: repository %s expected but absent" % (name, repo))
            continue
        if repo not in expected:
            problems.append("fixture %s: repository %s unexpected (absent from manifest)" % (name, repo))
            continue
        e, a = expected[repo], actual[repo]
        if e["head"] != a["head"]:
            problems.append("fixture %s: %sHEAD expected %s obtained %s" % (name, prefix, e["head"], a["head"]))
        for ref in sorted(set(e["refs"]) | set(a["refs"])):
            if ref not in a["refs"]:
                problems.append("fixture %s: %s%s absent (expected %s)" % (name, prefix, ref, e["refs"][ref]))
            elif ref not in e["refs"]:
                problems.append("fixture %s: %s%s inattendue (obtenu %s)" % (name, prefix, ref, a["refs"][ref]))
            elif e["refs"][ref] != a["refs"][ref]:
                problems.append("fixture %s: %s%s expected %s obtained %s" % (name, prefix, ref, e["refs"][ref], a["refs"][ref]))
        es, as_ = e["stash"], a["stash"]
        if len(es) != len(as_):
            problems.append("fixture %s: %srefs/stash counts %d entries, expected %d" % (name, prefix, len(as_), len(es)))
        for i in range(min(len(es), len(as_))):
            if es[i] != as_[i]:
                problems.append(
                    "fixture %s: %sstash@{%d} expected '%s' (tree %s) obtained '%s' (tree %s)"
                    % (name, prefix, i, es[i]["message"], es[i]["tree"], as_[i]["message"], as_[i]["tree"])
                )
    return problems


def load(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"version": VERSION, "fixtures": {}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["snapshot", "check", "update"])
    ap.add_argument("--git", default="git")
    ap.add_argument("--manifest")
    ap.add_argument("--name")
    ap.add_argument("dir")
    args = ap.parse_args()

    snap = snapshot(args.git, args.dir)
    if args.cmd == "snapshot":
        json.dump(snap, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    manifest = load(args.manifest)
    if args.cmd == "update":
        manifest["version"] = VERSION
        manifest.setdefault("fixtures", {})[args.name] = snap
        with open(args.manifest, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
            f.write("\n")
        print("updated manifest: %s (%d repository(s))" % (args.name, len(snap)))
        return 0

    expected = manifest.get("fixtures", {}).get(args.name)
    if expected is None:
        print("fixture %s: absent from manifest (launch tests/fixtures/build.sh --update-manifest %s)" % (args.name, args.name))
        return 1
    problems = diff(args.name, expected, snap)
    for p in problems:
        print(p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
