ARG DEBIAN_VERSION
FROM debian:${DEBIAN_VERSION}

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh snow \
  && echo 'snow:snow-test-password' | chpasswd \
  && mkdir -p /run/sshd /home/snow/workspace /home/snow/.local/lib/snow-app/agent \
  && chown -R snow:snow /home/snow \
  && ssh-keygen -A

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/snow-openssh-fixture
RUN chmod 0755 /usr/local/bin/snow-openssh-fixture

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/snow-openssh-fixture"]
