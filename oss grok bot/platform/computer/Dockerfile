FROM debian:bookworm-slim@sha256:ec31d744f83f4a73447ba045aaab9409997efe5cc706eca4890c1be36cc1606a
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-websockify xvfb x11vnc fluxbox chromium xterm xdotool scrot fonts-dejavu ca-certificates procps tini && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 -s /bin/bash bot && install -d -o bot -g bot /home/bot/workspace /home/bot/.config/chromium
RUN python3 -m venv --system-site-packages /opt/transport && /opt/transport/bin/pip install --no-deps websockify==0.13.0
RUN apt-get update && apt-get install -y --no-install-recommends pcmanfm lxterminal mousepad tint2 adwaita-icon-theme libglib2.0-bin && rm -rf /var/lib/apt/lists/*
RUN chown -R bot:bot /home/bot
COPY supervisor.py /opt/workshop/supervisor.py
COPY transport.py /opt/workshop/transport.py
USER root
ENV HOME=/home/bot DISPLAY=:1
WORKDIR /home/bot
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/opt/workshop/supervisor.py"]
