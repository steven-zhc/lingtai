"""Reduce an OTLP/HTTP Jaeger export to comparable, credential-free request samples."""

import argparse
import collections
import csv
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path


def instant(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps require an explicit UTC offset")
    return int(parsed.timestamp() * 1_000_000_000)


def iso(nanos):
    return datetime.fromtimestamp(nanos / 1_000_000_000, timezone.utc).isoformat(timespec="microseconds")


def attributes(span):
    return {a["key"]: next(iter(a["value"].values())) for a in span.get("attributes", [])}


def statistics(values, suffix="_s"):
    values = sorted(values)
    return {
        "n": len(values),
        "p50" + suffix: values[math.ceil(len(values) * 0.50) - 1],
        "p95" + suffix: values[math.ceil(len(values) * 0.95) - 1],
        "max" + suffix: values[-1],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    args = parser.parse_args()
    lower, upper = instant(args.start), instant(args.end)
    if lower >= upper:
        parser.error("start must precede end")
    # Prevent an accidental comparison from replacing an earlier baseline.
    args.output.mkdir(parents=True, exist_ok=False)
    traces = collections.defaultdict(dict)
    for line in args.source.read_text().splitlines():
        document = json.loads(line)
        if "error" in document:
            raise ValueError(document["error"])
        for resource in document["result"].get("resourceSpans", []):
            if attributes(resource.get("resource", {})).get("service.name") != "lingtai-board":
                continue
            for scope in resource.get("scopeSpans", []):
                for span in scope.get("spans", []):
                    traces[span["traceId"]][span["spanId"]] = span
    rows = []
    stages = {
        "page_home": "page /", "queue": "board.queue", "progress": "board.progress",
        "system": "board.system", "pr_landed_where": "pr.landed-where", "pr_board": "pr.board",
    }
    excluded = collections.Counter()
    for trace_id, lookup in traces.items():
        spans = list(lookup.values())
        roots = [s for s in spans if "http.method" in attributes(s) and "next.route" in attributes(s)]
        for root in roots:
            start, end = int(root["startTimeUnixNano"]), int(root["endTimeUnixNano"])
            if not lower <= start < upper:
                excluded["request_start_outside_window"] += 1
                continue
            if end > upper:
                excluded["request_crosses_window_end"] += 1
                continue
            a = attributes(root)
            reads = [s for s in spans if s["name"] == "events.read"]
            ticket_reads = [s for s in reads if attributes(s).get("lingtai.stream") == "ticket"]
            pr_parents = {s["spanId"] for s in spans if s["name"] in ("pr.landed-where", "pr.board")}

            def under_pr(span):
                parent = span.get("parentSpanId")
                seen = set()
                while parent and parent not in seen:
                    if parent in pr_parents:
                        return True
                    seen.add(parent)
                    parent = lookup.get(parent, {}).get("parentSpanId")
                return False

            pr_reads = [s for s in ticket_reads if under_pr(s)]
            seconds = lambda s: (int(s["endTimeUnixNano"]) - int(s["startTimeUnixNano"])) / 1e9
            row = {
                "trace_id": trace_id, "request_span_id": root["spanId"],
                "start_utc": iso(start), "end_utc": iso(end), "duration_s": seconds(root),
                "method": a["http.method"], "route": a["next.route"],
                "rsc": str(a.get("next.rsc", "unknown")).lower(),
                "http_status": a.get("http.status_code", ""),
                "otel_error": root.get("status", {}).get("code") in (2, "STATUS_CODE_ERROR"),
                "event_reads": len(reads), "ticket_reads": len(ticket_reads),
                "pr_ticket_reads": len(pr_reads),
                "pr_ticket_events_returned": sum(int(attributes(s).get("lingtai.count", 0)) for s in pr_reads),
                "pr_ticket_read_sum_s": sum(seconds(s) for s in pr_reads),
                "github_requests": sum(s["name"] == "github.request" for s in spans),
                "projection_acquire_max_s": max((seconds(s) for s in spans if s["name"] == "db.acquire"), default=""),
                "missing_parent_spans": sum(bool(s.get("parentSpanId")) and s["parentSpanId"] not in lookup for s in spans),
            }
            for key, name in stages.items():
                values = [seconds(s) for s in spans if s["name"] == name]
                row[key + "_max_s"] = max(values) if values else ""
            rows.append(row)
    rows.sort(key=lambda r: (r["start_utc"], r["trace_id"]))
    if not rows:
        raise ValueError("no completed HTTP requests in the selected window")
    with (args.output / "requests.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row["method"], row["route"], row["rsc"])].append(row)
    summary = []
    for (method, route, rsc), group in sorted(groups.items()):
        measured = [r for r in group if r["event_reads"] > 0]
        summary.append({
            "method": method, "route": route, "rsc": rsc,
            **statistics([r["duration_s"] for r in group]),
            "http_status_counts": dict(collections.Counter(str(r["http_status"]) for r in group)),
            "otel_errors": sum(r["otel_error"] for r in group),
            "requests_with_event_read_spans": len(measured),
            "pr_ticket_reads_when_observed": statistics([r["pr_ticket_reads"] for r in measured], suffix="") if measured else None,
        })
    payload = {
        "window_start_inclusive": args.start, "window_end_exclusive": args.end,
        "selection": "request start in window and request end no later than window end",
        "quantiles": "nearest rank: sorted[ceil(p*n)-1]; per-request observations, no time weighting",
        "duration": "server request completion; not browser paint or exclusive CPU time",
        "source_sha256": hashlib.file_digest(args.source.open("rb"), "sha256").hexdigest(),
        "request_count": len(rows), "excluded_http_spans": dict(excluded), "groups": summary,
    }
    (args.output / "summary.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"request_count": len(rows), "output": str(args.output)}))


if __name__ == "__main__":
    main()
