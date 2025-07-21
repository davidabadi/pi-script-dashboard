from flask import Flask, render_template, request, redirect, url_for, flash, Response
from functools import wraps
import simplepam
import subprocess
import os

app = Flask(__name__)
app.secret_key = 'supersecretkey'  # Change in production

SCRIPTS = {
    "MySQL Backup": "/usr/local/bin/backup_db.sh",
    "Unraid Backup": "/usr/local/bin/backup_unraid_rsync_ssh.sh",
    "Update + Reboot": "/usr/local/bin/update_and_reboot.sh",
}

LOGS = {
    "MySQL Backup Log": "/var/log/custom/conabadi_db_backup.log",
    "Unraid Backup Log": "/var/log/backup_unraid_rsync.log",
    "Update Log": "/var/log/update_and_reboot.log",
}

def check_auth(username, password):
    return simplepam.authenticate(username, password)

def authenticate():
    return Response(
        'Authentication required', 401,
        {'WWW-Authenticate': 'Basic realm="Login Required"'}
    )

def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return authenticate()
        return f(*args, **kwargs)
    return decorated

@app.route("/")
@requires_auth
def index():
    return render_template("index.html", scripts=SCRIPTS, logs=LOGS)

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
            content = f.readlines()[-100:]  # Tail last 100 lines
        return render_template("log.html", name=name, content=content)
    flash("❌ Log not found.", "error")
    return redirect(url_for("index"))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
