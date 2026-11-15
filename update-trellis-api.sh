#!/usr/bin/env bash
# Runs on the Vultr GPU server. Replaces trellis_api.py with the uploaded copy and
# restarts the TRELLIS API, keeping the same folder, command and environment it was
# started with. Afterwards it runs as the trellis-api service (restarts on its own).
set -euo pipefail

NEW_FILE=${1:-/tmp/roomfit-upload/trellis_api.py}
UNIT=trellis-api
WRAPPER=/usr/local/bin/trellis-api-start
API_STATUS=http://127.0.0.1:7861/api/status

[ -f "$NEW_FILE" ] || { echo "No new trellis_api.py was uploaded."; exit 1; }

find_pid() {
    local pid
    for pid in $(pgrep -f 'trellis_api' || true); do
        [ "$pid" = "$$" ] && continue
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'update-trellis-api' && continue
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'uvicorn|python|fastapi|gunicorn' || continue
        echo "$pid"; return 0
    done
    return 1
}

echo "== Looking for the running TRELLIS API"
PID=$(find_pid || true)
if [ -z "$PID" ]; then
    if [ -x "$WRAPPER" ]; then
        TARGET_DIR=$(sed -n 's/^cd -- //p' "$WRAPPER" | head -1)
        TARGET_DIR=$(eval "printf '%s' $TARGET_DIR")
        echo "Not running, but it was set up before in $TARGET_DIR."
        cp -p "$TARGET_DIR/trellis_api.py" "$TARGET_DIR/trellis_api.py.bak" 2>/dev/null || true
        cp "$NEW_FILE" "$TARGET_DIR/trellis_api.py"
        systemctl restart "$UNIT"
    else
        echo "The TRELLIS API is not running, so I can't tell how it is started."
        FOUND=$(find / -xdev -name trellis_api.py -not -path '/opt/roomfit/*' -not -path '/tmp/*' 2>/dev/null | head -5 || true)
        if [ -n "$FOUND" ]; then
            echo "Found trellis_api.py here:"; echo "$FOUND" | sed 's/^/   /'
            FIRST=$(echo "$FOUND" | head -1)
            cp -p "$FIRST" "$FIRST.bak"; cp "$NEW_FILE" "$FIRST"
            echo "Updated $FIRST (old copy saved as trellis_api.py.bak)."
        fi
        echo "Start the TRELLIS API the way you normally do, then run the deploy again so it can be set up to restart on its own."
        exit 2
    fi
else
    CWD=$(readlink "/proc/$PID/cwd")
    RUN_USER=$(stat -c %U "/proc/$PID")
    mapfile -d '' CMD < "/proc/$PID/cmdline"
    echo "Found it (process $PID, user $RUN_USER, folder $CWD):"
    echo "   ${CMD[*]}"

    TARGET_DIR=$CWD
    if [ ! -f "$CWD/trellis_api.py" ]; then
        for arg in "${CMD[@]}"; do
            case "$arg" in */trellis_api.py) TARGET_DIR=$(dirname "$arg") ;; esac
            if [ -f "$arg/trellis_api.py" ]; then TARGET_DIR=$arg; fi
        done
    fi
    [ -f "$TARGET_DIR/trellis_api.py" ] || { echo "Could not find trellis_api.py next to the running program. Nothing was changed."; exit 1; }

    echo "== Updating $TARGET_DIR/trellis_api.py (old copy saved as trellis_api.py.bak)"
    cp -p "$TARGET_DIR/trellis_api.py" "$TARGET_DIR/trellis_api.py.bak"
    cp "$NEW_FILE" "$TARGET_DIR/trellis_api.py"
    chown --reference="$TARGET_DIR/trellis_api.py.bak" "$TARGET_DIR/trellis_api.py"

    EXISTING_UNIT=$(grep -o '[^/]*\.service' "/proc/$PID/cgroup" 2>/dev/null | head -1 || true)
    if [ -n "$EXISTING_UNIT" ] && [ "$EXISTING_UNIT" != "ssh.service" ] && [ "$EXISTING_UNIT" != "sshd.service" ] &&
        ! echo "$EXISTING_UNIT" | grep -Eq '^(session-|user@)'; then
        echo "== It already runs as $EXISTING_UNIT; restarting that"
        systemctl restart "$EXISTING_UNIT"
    else
        echo "== Setting it up as the $UNIT service"
        {
            echo '#!/usr/bin/env bash'
            echo '# Recreated from the TRELLIS API process that was running before. Edit to change how it starts.'
            while IFS= read -r -d '' entry; do
                name=${entry%%=*}
                case "$name" in
                    PWD|OLDPWD|SHLVL|_|TERM|TERM_*|SSH_*|TMUX|TMUX_*|STY|WINDOW|LS_COLORS|PS1|DISPLAY|MAIL|LOGNAME|XDG_SESSION_*|XDG_RUNTIME_DIR|DBUS_*|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_*|MOTD_SHOWN|COLORTERM|LESSOPEN|LESSCLOSE) continue ;;
                esac
                [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
                printf 'export %s=%q\n' "$name" "${entry#*=}"
            done < "/proc/$PID/environ"
            printf 'cd -- %q\n' "$CWD"
            printf 'exec'; printf ' %q' "${CMD[@]}"; printf '\n'
        } > "$WRAPPER"
        chmod 755 "$WRAPPER"

        cat > "/etc/systemd/system/$UNIT.service" <<UNITFILE
[Unit]
Description=TRELLIS image-to-3D API
After=network-online.target

[Service]
User=$RUN_USER
ExecStart=$WRAPPER
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE

        echo "== Stopping the old process"
        kill "$PID" 2>/dev/null || true
        for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
        kill -9 "$PID" 2>/dev/null || true

        systemctl daemon-reload
        systemctl enable "$UNIT" >/dev/null
        systemctl restart "$UNIT"
    fi
fi

echo "== Waiting for TRELLIS to load the model (this can take a few minutes)"
for i in $(seq 1 100); do
    if curl -fsS --max-time 5 "$API_STATUS" >/dev/null 2>&1; then
        echo "== TRELLIS is ready with the new settings."
        exit 0
    fi
    sleep 6
done
echo "== TRELLIS has not come back after 10 minutes. Recent log:"
journalctl -u "$UNIT" -n 40 --no-pager 2>/dev/null || true
echo "If it is broken, the old file is saved as trellis_api.py.bak next to it."
exit 1
