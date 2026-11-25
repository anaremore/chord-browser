"""How fast the factory runs, per pull request: open time, review rounds, CI runs and their waits, flakes.

  python scripts/dev/process-metrics.py 103 104 110 112 > out.md
  python scripts/dev/process-metrics.py --merged-since 2026-11-24          every PR merged since that day

Needs gh, signed in. Reads GitHub only. Per PR:
  Hours open        opened to merged (or to now)
  Commits           on the PR
  Review rounds     commits whose headline names a review round: "review 2", "Neon's second pass", "final pass"
                    (reviews happen in agent threads, not on GitHub, and each round ends in such a commit)
  CI runs           CI workflow runs on the PR's branch (pull_request events), with
    cancelled         those cancelled (a newer push replaced them, or by hand)
    reruns            those re-run at least once (run_attempt > 1)
  First feedback    median minutes from a push's run being created to its first job (other than `What changed`)
                    finishing: how long a push waits to hear anything
  Verdict           median minutes from a run being created to its verdict job (`E2E · <tier> tier`, before
                    tiers `E2E`) finishing
  Queue wait        median minutes a job waited for a runner (created to started), over every job that ran
  CI jobs           jobs that ran (not skipped) across the PR's runs, plus its merge group's and main's push
  Flaky tests       tests that passed only on their retry (Playwright's run summary on each E2E job)
"""
import argparse
import json
import re
import statistics
import subprocess
from datetime import datetime, timezone

REPO = "anaremore/chord-browser"
ROUND = re.compile(r"\breview \d+\b|\bNeon'?s? (\w+ )?(pass|review)|\bfinal pass\b|\breview round\b", re.I)


def gh(*args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", check=True).stdout
    return out


def gh_lines(*args):
    return [json.loads(line) for line in gh(*args).splitlines() if line.strip()]


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def minutes(a, b):
    return (t(b) - t(a)).total_seconds() / 60


def median(xs):
    return round(statistics.median(xs), 1) if xs else None


def jobs(run_id):
    return gh_lines("api", "--paginate", f"repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100", "--jq", ".jobs[]")


def flaky_count(job_ids):
    """Tests that passed only on their retry: the "N flaky" line of Playwright's run summary, which its github
    reporter annotates on each E2E job."""
    n = 0
    for job_id in job_ids:
        try:
            messages = gh_lines("api", f"repos/{REPO}/check-runs/{job_id}/annotations?per_page=100", "--jq",
                                '.[] | select(.title | contains("Playwright Run Summary")) | .message | tojson')
        except subprocess.CalledProcessError:
            continue
        for message in messages:
            m = re.search(r"(\d+) flaky", message)
            n += int(m.group(1)) if m else 0
    return n


def pr_metrics(number):
    pr = json.loads(gh("pr", "view", str(number), "-R", REPO, "--json", "number,title,headRefName,createdAt,mergedAt,state,commits,mergeCommit"))
    runs = gh_lines("api", "--paginate", f"repos/{REPO}/actions/workflows/ci.yml/runs?branch={pr['headRefName']}&event=pull_request&per_page=100", "--jq", ".workflow_runs[]")
    merge_sha = (pr.get("mergeCommit") or {}).get("oid")
    after = []
    if merge_sha:
        after = gh_lines("api", "--paginate", f"repos/{REPO}/actions/workflows/ci.yml/runs?head_sha={merge_sha}&per_page=100", "--jq", ".workflow_runs[]")
    group = gh_lines("api", "--paginate", f"repos/{REPO}/actions/workflows/ci.yml/runs?event=merge_group&per_page=100", "--jq",
                     f'.workflow_runs[] | select(.head_branch | test("/pr-{pr["number"]}-"))')
    first, verdict, queue, e2e_jobs = [], [], [], []
    ran = 0
    for r in runs + group + after:
        if r["status"] != "completed":
            continue
        js = [j for j in jobs(r["id"]) if j.get("started_at") and j.get("conclusion") not in (None, "skipped")]
        ran += len(js)
        if r in after or r["conclusion"] == "cancelled":
            continue
        # A re-run job keeps its first try's created_at: its wait would read negative, so it's left out.
        queue += [w for w in (minutes(j["created_at"], j["started_at"]) for j in js if j.get("created_at")) if w >= 0]
        done = [j["completed_at"] for j in js if j["name"] != "What changed" and j.get("completed_at")]
        if done:
            first.append(minutes(r["created_at"], min(done)))
        verdicts = [j["completed_at"] for j in js if re.fullmatch(r"E2E( · \w+ tier)?", j["name"]) and j.get("completed_at")]
        if verdicts:
            verdict.append(minutes(r["created_at"], verdicts[0]))
        e2e_jobs += [j["id"] for j in js if j["name"].startswith("E2E · ") and " · " in j["name"][6:]]
    end = t(pr["mergedAt"]) if pr["mergedAt"] else datetime.now(timezone.utc)
    return {
        "pr": pr["number"],
        "title": pr["title"][:48],
        "state": pr["state"],
        "hours_open": round((end - t(pr["createdAt"])).total_seconds() / 3600, 1),
        "commits": len(pr["commits"]),
        "rounds": sum(1 for c in pr["commits"] if ROUND.search(c["messageHeadline"])),
        "runs": len(runs),
        "cancelled": sum(1 for r in runs if r["conclusion"] == "cancelled"),
        "reruns": sum(1 for r in runs if r.get("run_attempt", 1) > 1),
        "first": median(first),
        "verdict": median(verdict),
        "queue": median(queue),
        "jobs": ran,
        "flaky": flaky_count(e2e_jobs),
    }


COLUMNS = [
    ("PR", lambda r: f"#{r['pr']}"),
    ("Title", lambda r: r["title"]),
    ("State", lambda r: r["state"]),
    ("Hours open", lambda r: r["hours_open"]),
    ("Commits", lambda r: r["commits"]),
    ("Review rounds", lambda r: r["rounds"]),
    ("CI runs", lambda r: r["runs"]),
    ("Cancelled", lambda r: r["cancelled"]),
    ("Reruns", lambda r: r["reruns"]),
    ("First feedback (min)", lambda r: r["first"]),
    ("Verdict (min)", lambda r: r["verdict"]),
    ("Queue wait (min)", lambda r: r["queue"]),
    ("CI jobs", lambda r: r["jobs"]),
    ("Flaky tests", lambda r: r["flaky"]),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("prs", nargs="*", type=int)
    parser.add_argument("--merged-since", help="every PR merged since this day (YYYY-MM-DD)")
    args = parser.parse_args()
    numbers = list(args.prs)
    if args.merged_since:
        merged = json.loads(gh("pr", "list", "-R", REPO, "--state", "merged", "--search", f"merged:>={args.merged_since}", "--limit", "200", "--json", "number"))
        numbers += [p["number"] for p in merged if p["number"] not in numbers]
    if not numbers:
        parser.error("name some PRs, or --merged-since")
    rows = [pr_metrics(n) for n in numbers]
    print("| " + " | ".join(name for name, _ in COLUMNS) + " |")
    print("|" + "---|" * len(COLUMNS))
    for r in rows:
        print("| " + " | ".join(str(get(r)) for _, get in COLUMNS) + " |")
    if len(rows) > 1:
        def med(key):
            return median([r[key] for r in rows if r[key] is not None])
        print(f"\nMedians over {len(rows)} PRs: hours open {med('hours_open')}, review rounds {med('rounds')}, first feedback {med('first')} min, "
              f"verdict {med('verdict')} min, queue wait {med('queue')} min, CI jobs {med('jobs')}, cancelled runs {med('cancelled')}, flaky tests {med('flaky')}.")


if __name__ == "__main__":
    main()
