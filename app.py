from flask import Flask, render_template, request, redirect, url_for, flash, session
from functools import wraps
import subprocess
import os
import simplepam
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "changeme")

SCRIPTS = {
    "Conabadi MySQL Backup": "/usr/local/bin/backup_conabadi_db.sh",
    "Unraid Backup": "/usr/local/bin/backup_unraid.sh",
    "Update + Reboot": "/usr/local/bin/update_and_reboot.sh",
}

LOGS = {
    "Conabadi MySQL Backup Log": "/var/log/custom/conabadi_db_backup.log",
    "Unraid Backup Log": "/var/log/custom/backup_unraid.log",
    "Update Log": "/var/log/custom/update_and_reboot.log",
}

CRON_TAGS = {
    "Conabadi MySQL Backup": "backup_conabadi_db.sh",
    "Unraid Backup": "backup_unraid.sh",
    "Update + Reboot": "update_and_reboot.sh"
}

def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form["username"]
        password = request.form["password"]
        if simplepam.authenticate(username, password):
            session["logged_in"] = True
            session["username"] = username
            return redirect(url_for("index"))
        flash("Invalid credentials", "error")
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

@app.route("/")
@requires_auth
def index():
    cron_output = subprocess.getoutput("sudo crontab -l")
    cron_lines = cron_output.splitlines()
    paused = {}
    for name, tag in CRON_TAGS.items():
        paused[name] = any(tag in line and line.strip().startswith("#") for line in cron_lines)
    return render_template("index.html", scripts=SCRIPTS, logs=LOGS, cron_output=cron_output, paused=paused)

@app.route("/run/<name>")
@requires_auth
def run_script(name):
    script = SCRIPTS.get(name)
    if script:
        try:
            subprocess.Popen(["/bin/bash", script])
            flash(f"✅ '{name}' started successfully.", "success")
        except Exception as e:
            flash(f"❌ Error: {e}", "error")
    else:
        flash("❌ Script not found.", "error")
    return redirect(url_for("index"))

@app.route("/log/<name>")
@requires_auth
def view_log(name):
    path = LOGS.get(name)
    if path and os.path.exists(path):
        with open(path, "r") as f:
            content = f.readlines()[-100:]
        return render_template("log.html", name=name, content=content)
    flash("❌ Log not found.", "error")
    return redirect(url_for("index"))

@app.route("/toggle_cron/<name>")
@requires_auth
def toggle_cron(name):
    tag = CRON_TAGS.get(name)
    if not tag:
        flash("❌ Unknown script tag.", "error")
        return redirect(url_for("index"))

    cron_lines = subprocess.getoutput("sudo crontab -l").splitlines()
    updated_lines = []
    toggled = False
    for line in cron_lines:
        if tag in line:
            if line.strip().startswith("#"):
                updated_lines.append(line.lstrip("# "))
                toggled = True
            else:
                updated_lines.append(f"# {line}")
                toggled = True
        else:
            updated_lines.append(line)
    new_cron = "\n".join(updated_lines) + "\n"  # Add trailing newline
    subprocess.run("sudo crontab -", input=new_cron, text=True, shell=True)
    flash(f"{'▶️ Resumed' if toggled else '⏸️ Paused'} cron job for '{name}'.", "success")
    return redirect(url_for("index"))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)