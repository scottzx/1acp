"""Run with the ERPNext bench Python on the site host; print a safe receipt.

Adds business parent links, not a NestedSet tree or automatic permission rollup.
Re-running repairs the same records; existing conflicting records are rejected.
"""
import argparse
import json
import os

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def provision(parent_name, report_user, reader):
    frappe.set_user("Administrator")
    parent = frappe.get_doc("Project", parent_name)
    if reader not in [row.user for row in parent.users]:
        raise ValueError("Reader must already be a member of the parent project")
    for user in (reader, report_user):
        if not frappe.db.get_value("User", user, "enabled"):
            raise ValueError("Configured user is unavailable")

    definitions = [
        dict(fieldname="custom_parent_project", label="父项目", fieldtype="Link",
             options="Project", insert_after="project_name", in_list_view=1,
             in_standard_filter=1, description="业务归属关联；不自动继承权限或汇总成本。"),
        dict(fieldname="custom_github_repository", label="GitHub 仓库", fieldtype="Data",
             insert_after="custom_parent_project", in_standard_filter=1,
             description="owner/repository，用于关联项目开发日报。"),
    ]
    for definition in definitions:
        existing = frappe.get_meta("Project").get_field(definition["fieldname"])
        if existing and (existing.fieldtype != definition["fieldtype"]
                         or (existing.options or "") != definition.get("options", "")):
            raise ValueError("Existing Project field has an incompatible definition")
    create_custom_fields({"Project": definitions}, update=True)
    frappe.clear_cache(doctype="Project")

    receipt = {"parentProject": parent.name, "projects": {}}
    for label, repository in (("1acp", "scottzx/1acp"), ("session-reader", "scottzx/session-reader")):
        matches = frappe.get_all("Project", filters={"project_name": label}, pluck="name")
        if len(matches) > 1:
            raise ValueError("Duplicate project names require manual reconciliation")
        project = frappe.get_doc("Project", matches[0]) if matches else frappe.get_doc({
            "doctype": "Project", "project_name": label, "company": parent.company,
            "status": "Open", "is_active": "Yes", "percent_complete_method": "Manual",
        })
        if project.get("custom_parent_project") not in (None, "", parent.name):
            raise ValueError("Project already belongs to another parent")
        if project.get("custom_github_repository") not in (None, "", repository):
            raise ValueError("Project already maps to another repository")
        if project.name == parent.name:
            raise ValueError("Project cannot parent itself")
        project.custom_parent_project = parent.name
        project.custom_github_repository = repository
        project.save()
        # Only grant explicit access to these two children; no broadening to
        # unrelated Projects and no invitation or email notification.
        if not frappe.db.exists("User Permission", {
            "user": report_user, "allow": "Project", "for_value": project.name,
        }):
            frappe.get_doc({"doctype": "User Permission", "user": report_user,
                            "allow": "Project", "for_value": project.name,
                            "apply_to_all_doctypes": 1}).insert()
        frappe.share.add("Project", project.name, user=reader, read=1, write=0,
                         share=0, notify=0)

        title = f"代码日记 · {label}"
        diaries = frappe.get_all("Note", filters={"custom_project": project.name, "title": title}, pluck="name")
        if len(diaries) > 1:
            raise ValueError("Duplicate code diaries require manual reconciliation")
        diary = frappe.get_doc("Note", diaries[0]) if diaries else frappe.get_doc({
            "doctype": "Note", "title": title, "custom_project": project.name,
            "content": f"<p>{label} 项目的开发日报入口。请从项目页面查看下方关联日报。</p>", "public": 0,
        })
        if diary.get("custom_parent_note") or diary.get("custom_daily_report_key") or diary.public:
            raise ValueError("Existing code diary does not match the private root-note convention")
        diary.save()
        for user in (reader, report_user):
            frappe.share.add("Note", diary.name, user=user, read=1, write=0, share=0, notify=0)

        # This explicit administrative migration preserves report body, owner
        # and identity. Runtime upsert continues to reject cross-project moves.
        moved = []
        reports = frappe.get_all("Note", filters={"custom_project": parent.name,
            "title": ["like", f"Git 开发日报 · {repository} · %"]}, pluck="name")
        for name in reports:
            report = frappe.get_doc("Note", name)
            if not (report.get("custom_daily_report_key") or "").startswith("1acp:github-daily:v1:"):
                continue
            report.custom_project = project.name
            report.custom_parent_note = diary.name
            report.save()
            moved.append(name)
        receipt["projects"][label] = {"name": project.name, "repository": repository,
            "parentProject": parent.name, "diary": diary.name, "migratedReports": moved}
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--sites-path", default="/home/frappe/frappe-bench/sites")
    parser.add_argument("--parent-project", required=True)
    parser.add_argument("--report-user", required=True)
    parser.add_argument("--reader", required=True)
    args = parser.parse_args()
    os.chdir(args.sites_path)
    frappe.init(site=args.site)
    frappe.connect()
    try:
        receipt = provision(args.parent_project, args.report_user, args.reader)
        frappe.db.commit()
        print(json.dumps(receipt, ensure_ascii=False))
    except Exception:
        frappe.db.rollback()
        raise
    finally:
        frappe.destroy()


if __name__ == "__main__":
    main()
