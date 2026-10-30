#!/usr/bin/env python3
"""
Monthly attendance report for the HRIS (Python, standard library only).

Reads the SQLite database read-only and, for every active employee, counts the
scheduled work days in the month and classifies each as Present, Late, On Leave
or Absent. Output is JSON (for the web page) or CSV (for download).

Usage:
  python3 attendance_report.py --db ../hris.db --month 2026-11 [--format json|csv] [--today YYYY-MM-DD]
"""
import argparse, calendar, csv, io, json, sqlite3, sys
from datetime import date, datetime


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def hours_between(t_in, t_out):
    if not t_in or not t_out:
        return 0.0
    diff = to_min(t_out) - to_min(t_in)
    if diff < 0:           # night shift crossing midnight
        diff += 24 * 60
    return diff / 60.0


def late_minutes(time_in, shift_start):
    diff = ((to_min(time_in) - to_min(shift_start) + 720) % 1440) - 720
    return max(diff, 0)


def build_report(db_path, month, today):
    year, mon = (int(x) for x in month.split("-"))
    last_day = calendar.monthrange(year, mon)[1]
    first = date(year, mon, 1)
    last = date(year, mon, last_day)
    through = min(last, today)

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    try:
        holidays = {r[0] for r in con.execute("SELECT date FROM holidays WHERE date BETWEEN ? AND ?", (first.isoformat(), last.isoformat()))}
    except sqlite3.OperationalError:      # database from an older version without the table
        holidays = set()

    employees = con.execute("""
        SELECT e.id, e.employee_no, e.first_name || ' ' || e.last_name AS name, e.date_hired,
               COALESCE(d.name, '') AS department,
               COALESCE(s.name, 'No shift (Mon-Fri)') AS shift_name,
               COALESCE(s.start_time, '08:00') AS start_time,
               COALESCE(s.work_days, '1,2,3,4,5') AS work_days
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.is_active = 1
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN shift_assignments sa ON sa.employee_id = e.id
        LEFT JOIN shifts s ON s.id = sa.shift_id
        ORDER BY e.last_name, e.first_name""").fetchall()

    rows = []
    for e in employees:
        work_days = {int(x) for x in e["work_days"].split(",") if x != ""}
        recs = {r["work_date"]: r for r in con.execute(
            "SELECT * FROM attendance WHERE employee_id=? AND work_date BETWEEN ? AND ?",
            (e["id"], first.isoformat(), last.isoformat()))}
        leaves = con.execute(
            """SELECT start_date, end_date FROM leave_requests
               WHERE employee_id=? AND status='Approved' AND start_date<=? AND end_date>=?""",
            (e["id"], last.isoformat(), first.isoformat())).fetchall()

        def on_leave(day_iso):
            return any(l["start_date"] <= day_iso <= l["end_date"] for l in leaves)

        scheduled = present = late = absent = leave_days = 0
        late_total = 0
        hours = 0.0
        d = first
        while d <= through:
            iso = d.isoformat()
            hired = e["date_hired"] or "0000-00-00"
            # Python weekday(): Mon=0..Sun=6  ->  convert to Sun=0..Sat=6 used by the app
            dow = (d.weekday() + 1) % 7
            if dow in work_days and iso >= hired and not (iso in holidays and iso not in recs):
                # public/company holidays are not scheduled days (unless the employee worked that day)
                scheduled += 1
                rec = recs.get(iso)
                if rec and rec["time_in"]:
                    if rec["status"] == "Late":
                        late += 1
                        late_total += late_minutes(rec["time_in"], e["start_time"])
                    else:
                        present += 1
                    hours += hours_between(rec["time_in"], rec["time_out"])
                elif on_leave(iso):
                    leave_days += 1
                else:
                    absent += 1
            d = date.fromordinal(d.toordinal() + 1)

        expected = scheduled - leave_days
        rate = round((present + late) / expected * 100, 1) if expected > 0 else None
        rows.append({
            "employee_no": e["employee_no"], "name": e["name"], "department": e["department"],
            "shift": e["shift_name"], "scheduled_days": scheduled, "present": present,
            "late": late, "absent": absent, "on_leave": leave_days,
            "late_minutes": late_total, "hours_worked": round(hours, 1), "attendance_rate": rate,
        })
    con.close()

    rated = [r["attendance_rate"] for r in rows if r["attendance_rate"] is not None]
    totals = {
        "employees": len(rows),
        "present": sum(r["present"] for r in rows),
        "late": sum(r["late"] for r in rows),
        "absent": sum(r["absent"] for r in rows),
        "on_leave": sum(r["on_leave"] for r in rows),
        "average_rate": round(sum(rated) / len(rated), 1) if rated else None,
    }
    return {"month": month, "through": through.isoformat(), "rows": rows, "totals": totals}


def to_csv(report):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Employee No", "Name", "Department", "Shift", "Scheduled Days", "Present", "Late",
                "Absent", "On Leave", "Late Minutes", "Hours Worked", "Attendance Rate %"])
    for r in report["rows"]:
        w.writerow([r["employee_no"], r["name"], r["department"], r["shift"], r["scheduled_days"],
                    r["present"], r["late"], r["absent"], r["on_leave"], r["late_minutes"],
                    r["hours_worked"], "" if r["attendance_rate"] is None else r["attendance_rate"]])
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--format", choices=["json", "csv"], default="json")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD), for testing")
    a = ap.parse_args()
    try:
        datetime.strptime(a.month, "%Y-%m")
        today = datetime.strptime(a.today, "%Y-%m-%d").date() if a.today else date.today()
        report = build_report(a.db, a.month, today)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(to_csv(report) if a.format == "csv" else json.dumps(report))


if __name__ == "__main__":
    main()
