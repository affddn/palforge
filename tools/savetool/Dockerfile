# Pinned toolchain for editing Palworld saves: palsav and its Oodle bindings from PalworldSaveTools, plus savetool.py.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
# PalworldSaveTools v2.4.5. Fetching the commit by its hash checks its content.
ARG SAVE_TOOLS_COMMIT=3cc96c7fcf7e9650e542ea7d271f7b892e0a9547

COPY requirements.txt /tmp/requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends git g++ ca-certificates \
  && pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
  && git init -q /tmp/save-tools \
  && git -C /tmp/save-tools fetch -q --depth 1 https://github.com/deafdudecomputers/PalworldSaveTools.git "${SAVE_TOOLS_COMMIT}" \
  && git -C /tmp/save-tools checkout -q FETCH_HEAD \
  && test "$(git -C /tmp/save-tools rev-parse HEAD)" = "${SAVE_TOOLS_COMMIT}" \
  && pip install --no-cache-dir --no-deps --no-build-isolation /tmp/save-tools/src/palsav/palooz /tmp/save-tools/src/palsav \
  && apt-get purge -y git g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /tmp/save-tools /tmp/requirements.txt

COPY savetool.py /opt/savetool/savetool.py
RUN printf '#!/bin/sh\nexec python3 -I /opt/savetool/savetool.py "$@"\n' > /usr/local/bin/savetool \
  && chmod +x /usr/local/bin/savetool

WORKDIR /work
