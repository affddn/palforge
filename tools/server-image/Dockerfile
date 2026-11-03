# The operator's own server image plus the open-pal start-time guard. palctl passes the image the server already
# runs, by digest, as UPSTREAM.
ARG UPSTREAM
FROM ${UPSTREAM}
COPY open-pal-guard.sh /home/steam/server/open-pal-guard.sh

# The guard goes right before the server starts, after the image has updated the game. If upstream's start.sh no
# longer has that line, the build fails and the server keeps the image it has.
RUN chmod 0755 /home/steam/server/open-pal-guard.sh \
  && grep -q '^LogAction "Starting Server"$' /home/steam/server/start.sh \
  && sed -i 's|^LogAction "Starting Server"$|/home/steam/server/open-pal-guard.sh \|\| true\n&|' /home/steam/server/start.sh \
  && grep -B1 '^LogAction "Starting Server"$' /home/steam/server/start.sh | grep -q '^/home/steam/server/open-pal-guard.sh || true$'
