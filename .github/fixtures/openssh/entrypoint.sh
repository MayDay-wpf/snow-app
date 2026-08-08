#!/bin/sh
set -eu

case "${SNOW_SSH_TEST_FIXTURE:-}" in
  sftp-disabled)
    sed -i '/^Subsystem sftp /d' /etc/ssh/sshd_config
    ;;
  permit-tty-no)
    sed -i 's/^PermitTTY yes$/PermitTTY no/' /etc/ssh/sshd_config
    ;;
  noexec)
    # The GitHub workflow mounts this directory with noexec. Docker creates
    # the mount as root, so make it usable by the unprivileged SSH account.
    chown -R snow:snow /home/snow/.local/lib/snow-app/agent
    ;;
esac

exec /usr/sbin/sshd -D -e
