#!/usr/bin/env python3
"""gen-perf-100k.py -- fixture perf-100k (FX-100K of ) by a deterministic `git fast-import` stream.

    gen-perf-100k.py --repo DIR [--dirty] [--no-commit-graph] [--scale N]

DIR: repository git initialized and empty (fx_init), or non-existent (it is then created).

  * 100 000 commits, dont 1 000 merges (2 parents) ;
* 300 local branches (main + 299 feature/NNN), each with a upstream refs/remote/origin/<name> (ahead/behind
various: in sync, in advance from 1 to 5 commits, late from 1 to 4; 30 tags (20 annotated, 10 light) on hand;
* 5,000 files tracked; ~30 branches simultaneously active (life window of 10% of history);
* worktree extracted and clean, HEAD on hand; commit-graph file written (`git commit-graph write --reachable`)
Except with --no-commit-graph.

--dirty: FX-100K-DIRTY, adds 1,000 modified tracked files and 20,000 untracked files (untracked/dNNN/uNNNN.txt,
          200 dossiers de 100 fichiers).
--scale N: divides everything by N (commits, branches, merges, tags, files; floor 200 / 4 / 3 / 3 / 100) for
The only one that produces the official fixture is scale 1.

Determinism: no clock, no system chance. The pseudo-random generator is a home xorshift64* (the module
`random` does not guarantee its sequences from one version of Python to the other; the dates are derived from the commit number.
Two performances give the same OID, with any version of git >= 2.30.

Python 3.6+, standard library only. Approximately 10 to 20 s for full fixture.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

MASK = (1 << 64) - 1
BASE_TIME = 1700000000
SEED = 0x6B6C2D70657266  # "kl-perf"
TREE_FRACTION_BRANCH = 0.30   # part of the commits worn by the feature branches
WINDOW = 0.10                 # service life of a branch, in fraction of history

AUTHORS = [
    "Alice Martin", "Bruno Lefevre", "Chloe Durand", "David Moreau", "Emma Petit", "Felix Roux", "Gaelle Simon",
    "Hugo Laurent", "Ines Michel", "Jules Garcia", "Karine Bernard", "Louis Fournier", "Manon Girard", "Noah Bonnet",
    "Oceane Dupont", "Paul Lambert", "Quentin Faure", "Romane Mercier", "Samuel Blanc", "Tess Guerin", "Ulysse Muller",
    "Valerie Henry", "William Roussel", "Yasmine Nicolas",
]
TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "build"]
SCOPES = ["parser", "lexer", "graph", "diff", "status", "stash", "rebase", "remote", "ui", "core", "cache", "watcher"]
VERBS = ["add", "fix", "update", "remove", "rename", "simplify", "extend", "handle", "document", "optimize"]
OBJECTS = ["tokcached", "lane allocation", "index refresh", "hunk header", "commit pagination", "conflict marker",
           "ref filter", "progress event", "undo entry", "tree walker", "search query", "theme variable"]
EXTS = ["rs", "ts", "md", "txt"]


class Rng:
    """xorshift64*: deterministic and independent of the Python version."""

    def __init__(self, seed):
        self.s = seed & MASK or 1

    def next(self):
        x = self.s
        x ^= x >> 12
        x ^= (x << 25) & MASK
        x ^= x >> 27
        self.s = x
        return (x * 0x2545F4914F6CDD1D) & MASK

    def below(self, n):
        return (self.next() >> 11) % n

    def uniform(self):
        return (self.next() >> 11) / float(1 << 53)

    def shuffle(self, items):
        for i in range(len(items) - 1, 0, -1):
            j = self.below(i + 1)
            items[i], items[j] = items[j], items[i]


# --------------------------------------------------------------------------------------------------------------------
# git
# --------------------------------------------------------------------------------------------------------------------
def git_ok(path):
    try:
        out = subprocess.check_output([path, "--version"], stderr=subprocess.DEVNULL).decode()
    except (OSError, subprocess.CalledProcessError):
        return False
    parts = out.replace("git version ", "").split(".")
    try:
        return (int(parts[0]), int(parts[1])) >= (2, 30)
    except (ValueError, IndexError):
        return False


def select_git():
    explicit = os.environ.get("GITMINI_TEST_GIT")
    if explicit:
        if not git_ok(explicit):
            sys.exit("GITMINI_TEST_GIT=%s is not a git >= 2.30" % explicit)
        return explicit
    for cand in (shutil.which("git"), "/usr/bin/git"):
        if cand and os.access(cand, os.X_OK) and git_ok(cand):
            return cand
    sys.exit("git >= 2.30 not found (defined GITMINI_TEST_GIT)")


class Git:
    def __init__(self, repo, tmp_home):
        self.bin = select_git()
        self.repo = repo
        env = dict(os.environ)
        env["PATH"] = os.path.dirname(self.bin) + os.pathsep + env.get("PATH", "")
        if env.get("GIT_CONFIG_NOSYSTEM") != "1":   # launched out of lib.sh: we isolate git from the developer config
            env.update({"GIT_CONFIG_NOSYSTEM": "1", "HOME": tmp_home, "XDG_CONFIG_HOME": tmp_home + "/.config"})
        env.update({"TZ": "UTC", "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0"})
        for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            env.pop(k, None)
        self.env = env

    def run(self, *args, **kw):
        return subprocess.run([self.bin, "-C", self.repo] + list(args), env=self.env, check=True, **kw)

    def out(self, *args):
        return self.run(*args, stdout=subprocess.PIPE).stdout.decode().strip()

    def popen_fast_import(self):
        # 100 active branches: otherwise fast-import unloads and then rereads the tree of each branch in turn
        return subprocess.Popen(
            [self.bin, "-C", self.repo, "fast-import", "--quiet", "--active-branches=100", "--max-pack-size=1g"],
            stdin=subprocess.PIPE, env=self.env)


# --------------------------------------------------------------------------------------------------------------------
# plan de l'historique
# --------------------------------------------------------------------------------------------------------------------
class Plan:
    def __init__(self, scale):
        self.commits = max(200, 100000 // scale)
        self.branches = max(4, 300 // scale)            # main comprise
        self.features = self.branches - 1
        self.merges = max(3, 1000 // scale, self.features)
        self.tags = max(3, 30 // scale)
        self.files = max(100, 5000 // scale)
        self.branch_commits = max(int(self.commits * TREE_FRACTION_BRANCH), self.features * 2)
        self.main_commits = self.commits - 1 - self.merges - self.branch_commits   # off commit root and merges
        if self.main_commits < 1:
            sys.exit("too small scale: not enough commits for hand")
        self.files_per_branch = max(1, min(10, int(self.files * 0.6) // self.features))
        self.main_files = self.files - self.features * self.files_per_branch


def build_ops(plan, rng):
    """Ordered list of operations (time, genre, branch): 'C' commit hand, 'b' commit branch, 'm' merges in hand."""
    F = plan.features
    # commits per branch: random weights, exact sum
    weights = [0.5 + rng.uniform() for _ in range(F)]
    total_w = sum(weights)
    q = [max(2, int(w / total_w * plan.branch_commits)) for w in weights]
    i = 0
    while sum(q) < plan.branch_commits:
        q[i % F] += 1
        i += 1
    i = 0
    while sum(q) > plan.branch_commits:
        if q[i % F] > 2:
            q[i % F] -= 1
        i += 1
    # merges by branch: plan.merges // F, the rest by branches drawn by lot
    r = [plan.merges // F] * F
    order = list(range(F))
    rng.shuffle(order)
    for k in range(plan.merges - sum(r)):
        r[order[k]] += 1
    r = [min(r[j], q[j]) for j in range(F)]
    short = plan.merges - sum(r)
    j = 0
    while short > 0:   # (small scales) carry-over of rejected merges on branches with margin
        if r[j % F] < q[j % F]:
            r[j % F] += 1
            short -= 1
        j += 1
        if j > 100 * F:
            sys.exit("Impossible to place all merges")

    ops = []
    for j in range(F):
        tail = q[j] // 4 if j % 10 == 9 else 0     # ~10% of branches keep unfused commits
        merged = q[j] - tail
        base, extra = divmod(merged, r[j])
        seq = []
        for k in range(r[j]):
            seq.extend(["b"] * (base + (1 if k < extra else 0)))
            seq.append("m")
        seq.extend(["b"] * tail)
        start = (1.0 - WINDOW) * (j + 0.5 * rng.uniform()) / F
        n = len(seq)
        for k, kind in enumerate(seq):
            t = start + WINDOW * (k + 0.5 + 0.3 * (rng.uniform() - 0.5)) / n
            ops.append((t, 1, j, k, kind))
    for k in range(plan.main_commits):
        ops.append(((k + 0.5) / plan.main_commits, 0, 0, k, "C"))
    ops.sort()
    return ops, q


# --------------------------------------------------------------------------------------------------------------------
# flux fast-import
# --------------------------------------------------------------------------------------------------------------------
def main_path(k):
    return "src/m%02d/f%04d.%s" % (k // 50, k, EXTS[k % 4])


def branch_path(j, k):
    return "modules/b%03d/f%d.%s" % (j, k, EXTS[k % 4])


def blob(path, mark, who):
    return "%s\nrevision %d\nauthor %s\n// generated by gen-perf-100k.py\n" % (path, mark, who)


def make_message(rng, seq):
    msg = "%s(%s): %s %s (#%d)" % (
        TYPES[rng.below(len(TYPES))], SCOPES[rng.below(len(SCOPES))], VERBS[rng.below(len(VERBS))],
        OBJECTS[rng.below(len(OBJECTS))], seq)
    if seq % 7 == 0:
        msg += "\n\nRefs: #%d\nReviewed-by: %s" % (1000 + seq, AUTHORS[rng.below(len(AUTHORS))])
    return msg


def generate(plan, rng, g, log):
    ops, quotas = build_ops(plan, rng)
    F = plan.features
    fp = g.popen_fast_import()
    out = []

    def flush(force=False):
        if force or len(out) >= 4000:
            fp.stdin.write("".join(out).encode("ascii"))
            del out[:]

    def commit(ref, mark, ts, msg, who, from_mark=None, merge_mark=None, changes=()):
        name = AUTHORS[who]
        ident = "%s <%s@perf.gitmini> %d +0000" % (name, name.lower().replace(" ", "."), ts)
        out.append("commit %s\nmark :%d\nauthor %s\ncommitter %s\ndata %d\n%s\n" % (ref, mark, ident, ident, len(msg), msg))
        if from_mark:
            out.append("from :%d\n" % from_mark)
        if merge_mark:
            out.append("merge :%d\n" % merge_mark)
        for path, content in changes:
            out.append("M 100644 inline %s\ndata %d\n%s\n" % (path, len(content), content))
        out.append("\n")
        flush()

    # commit root: `files` files (main_files hand, files_per_branch per branch)
    mark = 1
    who = 0
    changes = []
    for k in range(plan.main_files):
        changes.append((main_path(k), blob(main_path(k), 0, AUTHORS[who])))
    for j in range(F):
        for k in range(plan.files_per_branch):
            changes.append((branch_path(j, k), blob(branch_path(j, k), 0, AUTHORS[who])))
    commit("refs/heads/main", mark, BASE_TIME, "chore(core): initial import (#0)", who, changes=changes)

    main_marks = [mark]            # marks of the commits hand, in order (including seams)
    main_only = [mark]             # regular commits hand marks (tag targets)
    branch_marks = [[] for _ in range(F)]
    pending = [dict() for _ in range(F)]
    seq = 0
    for (_t, _o, j, _k, kind) in ops:
        mark += 1
        seq += 1
        ts = BASE_TIME + 60 * seq
        who = rng.below(len(AUTHORS))
        if kind == "C":
            changes = []
            for _ in range(1 + rng.below(3)):
                p = main_path(rng.below(plan.main_files))
                changes.append((p, blob(p, mark, AUTHORS[who])))
            commit("refs/heads/main", mark, ts, make_message(rng, seq), who, changes=changes)
            main_marks.append(mark)
            main_only.append(mark)
        elif kind == "b":
            ref = "refs/heads/feature/%03d" % j
            changes = []
            for _ in range(1 + rng.below(2)):
                p = branch_path(j, rng.below(plan.files_per_branch))
                content = blob(p, mark, AUTHORS[who])
                changes.append((p, content))
                pending[j][p] = content
            first = not branch_marks[j]
            commit(ref, mark, ts, make_message(rng, seq), who, from_mark=main_marks[-1] if first else None, changes=changes)
            branch_marks[j].append(mark)
        else:  # 'm' : merges the j branch in hand, with the final contents of its files modified since the last merge
            changes = sorted(pending[j].items())
            pending[j] = {}
            commit("refs/heads/main", mark, ts, "Merge branch 'feature/%03d' into main" % j, who,
                   merge_mark=branch_marks[j][-1], changes=changes)
            main_marks.append(mark)

    # tags: 30 on ordinary commits hand, distributed; one on two annotated
    tag_marks = []
    for k in range(plan.tags):
        tag_marks.append(main_only[(k + 1) * len(main_only) // (plan.tags + 1)])
    for k, m in enumerate(tag_marks):
        name = "v%d.%d.0" % (1 + k // 10, k % 10)
        ts = BASE_TIME + 60 * (m + 1)
        if k % 2 == 0:
            msg = "Release %s" % name
            out.append("tag %s\nfrom :%d\ntagger %s <%s@perf.gitmini> %d +0000\ndata %d\n%s\n"
                       % (name, m, "Release Bot", "release", ts, len(msg), msg))
        else:
            out.append("reset refs/tags/%s\nfrom :%d\n\n" % (name, m))

    # Upstreams: refs/remotes/origin/<branche>. All 6: local in advance (1-5); 1 out of 6: local in late (1-4).
    def reset(ref, m):
        out.append("reset %s\nfrom :%d\n\n" % (ref, m))

    reset("refs/remotes/origin/main", main_marks[-1 - min(7, len(main_marks) - 1)])
    for j in range(F):
        marks = branch_marks[j]
        tip = marks[-1]
        local, remote = tip, tip
        if j % 6 == 0:
            remote = marks[max(0, len(marks) - 1 - (1 + j % 5))]
        elif j % 6 == 1:
            local = marks[max(0, len(marks) - 1 - (1 + j % 4))]
        reset("refs/remotes/origin/feature/%03d" % j, remote)
        if local != tip:
            reset("refs/heads/feature/%03d" % j, local)
    flush(force=True)
    fp.stdin.close()
    if fp.wait() != 0:
        sys.exit("git fast-import failed")
    log("written stream: %d commits" % (mark))
    return F


# --------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="repository empty git (created if it does not exist)")
    ap.add_argument("--dirty", action="store_true", help="variante FX-100K-DIRTY")
    ap.add_argument("--no-commit-graph", action="store_true", help="does not write commit-graph file")
    ap.add_argument("--scale", type=int, default=1, help="divise la taille par N (essais ; 1 = fixture officielle)")
    args = ap.parse_args()
    if args.scale < 1:
        ap.error("--scale must be >= 1")

    t0 = time.time()

    def log(msg):
        sys.stderr.write("[gen-perf-100k +%5.1fs] %s\n" % (time.time() - t0, msg))

    repo = os.path.abspath(args.repo)
    tmp_home = tempfile.mkdtemp(prefix="gitmini-perf-home.")
    try:
        g = Git(repo, tmp_home)
        if not os.path.exists(os.path.join(repo, ".git")):
            os.makedirs(repo, exist_ok=True)
            g.run("init", "-q", "--template=", "-b", "main")
            for k, v in (("commit.gpgsign", "false"), ("tag.gpgsign", "false"), ("core.autocrlf", "false"),
                         ("core.fileMode", "true"), ("gc.auto", "0"), ("maintenance.auto", "false")):
                g.run("config", k, v)
        if subprocess.call([g.bin, "-C", repo, "rev-parse", "-q", "--verify", "HEAD"], env=g.env,
                           stdout=subprocess.DEVNULL) == 0:
            sys.exit("the repository is not empty")

        plan = Plan(args.scale)
        rng = Rng(SEED)
        features = generate(plan, rng, g, log)

        # config upstreams : branch.<name>.remote / .merge for the 300 branches
        cfg = ['[remote "origin"]\n\turl = ../origin.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
               '\tfollowRemoteHEAD = never\n']
        names = ["main"] + ["feature/%03d" % j for j in range(features)]
        for n in names:
            cfg.append('[branch "%s"]\n\tremote = origin\n\tmerge = refs/heads/%s\n' % (n, n))
        with open(os.path.join(repo, ".git", "config"), "a") as f:
            f.write("".join(cfg))

        g.run("reset", "-q", "--hard", "main")
        log("worktree extrait (%d fichiers)" % len(g.out("ls-files").splitlines()))

        if not args.no_commit_graph:
            g.run("commit-graph", "write", "--reachable")
            log("commit-graph writes")

        if args.dirty:
            n_mod = max(10, 1000 // args.scale)
            n_dirs = max(2, 200 // args.scale)
            n_untracked = n_dirs * (max(10, 20000 // args.scale) // n_dirs)
            tracked = sorted(g.out("ls-files", "src").splitlines())[:n_mod]
            for p in tracked:
                with open(os.path.join(repo, p), "a") as f:
                    f.write("modified in worktree\n")
            per_dir = n_untracked // n_dirs
            for d in range(n_dirs):
                dpath = os.path.join(repo, "untracked", "d%03d" % d)
                os.makedirs(dpath, exist_ok=True)
                for k in range(per_dir):
                    with open(os.path.join(dpath, "u%05d.txt" % (d * per_dir + k)), "w") as f:
                        f.write("non suivi %d/%d\n" % (d, k))
            log("dirty variant: %d files tracked modified, %d not tracked in %d folders" % (len(tracked), n_untracked, n_dirs))

        # summary (checking the figures of )
        total = int(g.out("rev-list", "--all", "--count"))
        merges = int(g.out("rev-list", "--all", "--merges", "--count"))
        heads = len(g.out("for-each-ref", "refs/heads").splitlines())
        tags = len(g.out("for-each-ref", "refs/tags").splitlines())
        files = len(g.out("ls-files").splitlines())
        log("commits=%d merges=%d branches=%d tags=%d fichiers=%d" % (total, merges, heads, tags, files))
        if args.scale == 1 and (total, merges, heads, tags, files) != (100000, 1000, 300, 30, 5000):
            sys.exit("unexpected numbers for FX-100K: %s" % ((total, merges, heads, tags, files),))
    finally:
        shutil.rmtree(tmp_home, ignore_errors=True)


if __name__ == "__main__":
    main()
